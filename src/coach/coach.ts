import type Anthropic from "@anthropic-ai/sdk";
import {
  DraftDroppedError,
  NoReplyTextError,
  type HeldNudge,
  toClaudeMessages,
  type DroppedDraft,
  type ClaudeModel,
  type NudgeRequest,
  type Replier,
  type ReplyInput,
  type TokenUsage,
} from "../claude/replier.js";
import type { Db } from "../db/client.js";
import type { Tester } from "../db/schema.js";
import {
  ALWAYS_MEMORY_TOOLS,
  MEMORY_TOOL_DEFINITIONS,
  MEMORY_TOOL_NAMES,
  runMemoryTool,
  type LookupBudget,
  type MemoryToolName,
} from "../memory/coach-tools.js";
import { memoryBlock, usesMemory } from "../memory/context.js";
import { OPT_OUT_CONFIRMATION } from "../testers/commands.js";
import { updateTester } from "../testers/testers.js";
import { buildStateBlock, FIXED_INSTRUCTIONS, fullVoiceInstructions } from "./prompt.js";
import { loadCoachState, localTime, onboardingComplete, type CoachState } from "./state.js";
import { runTool, TOOL_DEFINITIONS } from "./tools.js";
import { loadVoiceDoc } from "./voice.js";

/**
 * Claude calls per reply. The last one can't use tools, so it always ends in text. Five, so a
 * memory lookup never squeezes out a save.
 */
export const MAX_ROUNDS = 5;

/**
 * Messages the coach sees during onboarding and planning: the whole conversation since the
 * tester's context started, capped for safety. Once the plan is locked, memory takes over
 * (src/memory/context.ts) and only the last two days come word for word.
 */
export const COACH_HISTORY_CAP = 200;
/** Claude calls for a text ZOH starts after lock: the day's step may be saved first, the last call writes (#76). */
export const NUDGE_ROUNDS = 3;
/** The only tools a text ZOH starts may run: everything else waits for their reply. */
/** #78: record_week_recap is a no-op in the 6 pm recap (its slot is the record), allowed so a stray call can't derail the text. */
export const NUDGE_TOOLS: readonly string[] = ["set_today_step", "record_week_recap"];
/** #37: what the coach is told when its whole reply after a save was only a save confirmation. */
export const SAVE_ONLY_NOTE =
  "[Your text can't be only a save confirmation: they never hear about saves. Write the whole text to them now, answering their last text and then its next move if it needs one (the next question, the plan or the proposal). Don't mention saving or this note.]";

/**
 * #37: a reply that only confirms a save ("Saved.", "I've saved all of that."): short, no question,
 * no • list, and about saving. A lock's hype line or a one-line confirmation of a change doesn't count.
 */
export function onlySaveConfirmation(text: string): boolean {
  return text.length > 0 && text.length <= 60 && !text.includes("?") && !text.includes("•") && /\b(saved|recorded|got (it|that) (all )?down)\b/i.test(text);
}

/**
 * #16: told to the reply that replaces dropped drafts (they texted again before it went out).
 * Null when the drafts did nothing and wrote nothing: the history already holds every text.
 */
export function droppedDraftNote(d: DroppedDraft | undefined): string | null {
  if (!d || (d.actions.length === 0 && !d.text)) return null;
  const parts = ["[They sent more before your reply went out, so it was never sent."];
  if (d.actions.length) parts.push(`Already done while answering, so keep it and don't redo it (change it only if their new texts ask): ${d.actions.join("; ")}.`);
  if (d.text) parts.push(`Your unsent draft, which they never saw: "${d.text}"`);
  parts.push("Reply once to everything they've sent since your last text. Don't mention this note.]");
  return parts.join(" ");
}

/** Lines per finished action in a dropped draft: the tool and the first line of its result. */
const ACTION_RESULT_CHARS = 200;

/** #108: told once when a reply's text has a tool's name on its own line (it wrote the call instead of making it). */
export const TOOL_AS_TEXT_NOTE =
  "[Your text had a tool's name on its own line, which they'd see. If you meant to use it, call it now; then write only your text to them. Don't mention this note.]";

/** #108: a line that's only a tool's name ("mark_agreed", "`mark_agreed()`"). */
function isToolNameLine(line: string, names: readonly string[]): boolean {
  const bare = line.trim().replace(/^[`*_[(]+/, "").replace(/(\(\))?[`*_\]):.]*$/, "");
  return bare !== "" && names.includes(bare);
}

/** #108: whether the text has a bare tool name on a line of its own. */
export function hasToolNameLine(text: string, names: readonly string[]): boolean {
  return text.split("\n").some((l) => isToolNameLine(l, names));
}

/** #108: the text without lines that are only a tool's name; it never reaches a tester. */
export function withoutToolNames(text: string, names: readonly string[]): string {
  return text
    .split("\n")
    .filter((l) => !isToolNameLine(l, names))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The coach's whole answer when it skips a kickoff it was allowed to skip (#42), or declines any text it starts (#109). */
export const SKIP = "SKIP";

/** #109: every text ZOH starts may be declined, in one word, never with an explanation the tester would get. */
export const DECLINE_NOTE = ` The app already checked this text may go now (stops, breaks and quiet hours included). If it still shouldn't, answer only ${SKIP}: never explain.`;

/**
 * #109: a text ZOH starts that's really a decision about sending ("I'm not sending this text…",
 * "[No text sent. It's 9:05 PM…]"): the whole text in brackets, or opening with not sending.
 */
export function readsAsSendDecision(text: string): boolean {
  const t = text.trim();
  if (/^\[[\s\S]*\]$/.test(t)) return true;
  return /^\W*(i'?m not sending|i am not sending|not sending (this|it|a text|anything)|no text (sent|goes out)|nothing (sent|goes out|to send)|i won'?t send (this|it|a text|anything))\b/i.test(t.replace(/’/g, "'"));
}

/**
 * Output budget per Claude call. Thinking counts against it, so it sits well above a text's
 * length (CLAUDE_MAX_TOKENS' default of 400 left some calls with no room for any text).
 */
export const COACH_MAX_TOKENS = 2000;

export interface CoachOptions {
  db: Db;
  model: ClaudeModel;
  /** The voice page as the coach reads it; defaults to docs/coach-voice.md, read once here. */
  voice?: string;
  /** Focus plus maintenance goals a tester can have (`GOAL_CAP`); defaults to 3. */
  goalCap?: number;
}

/**
 * The coach: one reply per inbound text, from a short tool loop. Tools save what it learns;
 * the app (not the model) moves the tester to `planning` once the goal and every required
 * plan question are saved, and tells the model to carry straight on into the plan.
 */
export function createCoach(opts: CoachOptions): Replier {
  const { db, model, goalCap } = opts;
  // Read at startup (wiring builds the coach then), so a missing page stops the app, not a reply.
  const afterOnboarding = fullVoiceInstructions(opts.voice ?? loadVoiceDoc());
  return {
    async reply({ tester: initial, turns, now, messageId, onUsage, interrupted, signal, dropped }: ReplyInput) {
      const messages = toClaudeMessages(turns);
      if (messages.length === 0) throw new Error("Nothing to reply to");
      // #16: the reply that replaces dropped drafts hears what they did and wrote.
      const note = droppedDraftNote(dropped);
      if (note) (messages.at(-1)!.content as Anthropic.ContentBlockParam[]).push({ type: "text", text: note });
      markCached(messages);
      /** Actions this draft finished, handed on if it's dropped. */
      const done: string[] = [];
      /** #16: a safe point. They texted again: stop here, before the next call, action or send. */
      const checkpoint = (text?: string) => {
        if (interrupted?.()) throw new DraftDroppedError({ actions: done, ...(text ? { text } : {}) });
      };
      // Read once per reply: it only changes overnight (or on a preference or forget, which the tool result reports).
      const memory = usesMemory(initial) ? await memoryBlock(db, initial) : undefined;
      const budget: LookupBudget = { lookups: 0, searches: 0 };
      const usage: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      try {
        return await replyLoop();
      } finally {
        onUsage?.(usage);
      }

      async function replyLoop(): Promise<string> {
      const isFirstText = !turns.some((t) => t.role === "assistant");
      // Every text since ZOH's last reply: the model reads them as one message, so a commitment can be in any.
      const lastTesterText = turns
        .slice(turns.findLastIndex((t) => t.role === "assistant") + 1)
        .map((t) => t.text)
        .join("\n");

      let tester: Tester = initial;
      let justFinished = false;
      let state = await loadCoachState(db, tester, { now, isFirstText, lastTesterText, goalCap });
      let fallbackText = "";
      // Fixed for the whole reply: changing tools mid-loop breaks the cache and the history's tool calls.
      const tools = toolsFor(initial);
      // Onboarding keeps its condensed prompt so its rules stay sharp; afterwards, the whole voice page.
      const fixed = initial.phase === "onboarding" ? FIXED_INSTRUCTIONS : afterOnboarding;
      /** Tool names and outcomes per round (never their inputs), for the error if no text comes back. */
      const trail: string[] = [];
      let retried = false;
      let nudgedPastSave = false;
      let nudgedPastToolName = false;
      const toolNames = tools.map((t) => t.name);

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const last = round === MAX_ROUNDS;
        checkpoint(fallbackText);
        let response: Awaited<ReturnType<ClaudeModel["create"]>>;
        try {
          response = await model.create({
            system: systemBlocks(fixed, state, memory),
            messages,
            tools,
            toolChoice: last ? "none" : "auto",
            ...(signal ? { signal } : {}),
          });
        } catch (err) {
          // Cut off because they texted again: nothing from this call ran.
          if (signal?.aborted) throw new DraftDroppedError({ actions: done, ...(fallbackText ? { text: fallbackText } : {}) });
          throw err;
        }
        addUsage(usage, response.usage);
        const text = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const calls = response.content.filter((b) => b.type === "tool_use");
        // Rarely a round comes back with neither text nor a tool call we can run: try that round again.
        if (!text && calls.length === 0 && !last && !retried) {
          retried = true;
          trail.push(`empty:${response.stopReason}:${(response.raw ?? []).map((b) => b.type).join("+") || "no blocks"}`);
          continue;
        }
        // #108: a tool's name written as text instead of called: once, ask it to make the call and write only the text.
        if (calls.length === 0 && !last && !nudgedPastToolName && hasToolNameLine(text, toolNames)) {
          nudgedPastToolName = true;
          trail.push("tool-as-text");
          messages.push({ role: "assistant", content: response.raw ?? (response.content as Anthropic.ContentBlockParam[]) });
          messages.push({ role: "user", content: [{ type: "text", text: TOOL_AS_TEXT_NOTE }] });
          continue;
        }
        // #37: after saving, a bare "Saved." left testers at a dead end: once, ask for the real reply.
        if (calls.length === 0 && !last && !nudgedPastSave && trail.some((r) => r.includes(":ok")) && onlySaveConfirmation(text)) {
          nudgedPastSave = true;
          trail.push("save-only");
          messages.push({ role: "assistant", content: response.raw ?? (response.content as Anthropic.ContentBlockParam[]) });
          messages.push({ role: "user", content: [{ type: "text", text: SAVE_ONLY_NOTE }] });
          continue;
        }
        if (calls.length === 0 || last) {
          const reply = withoutToolNames(text, toolNames) || fallbackText;
          if (!reply) {
            throw new NoReplyTextError(`Claude returned no text (stop_reason: ${response.stopReason}; rounds: ${trail.join(" | ") || "none"})`);
          }
          checkpoint(reply);
          return reply;
        }
        if (text) fallbackText = withoutToolNames(text, toolNames);

        const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
        for (const call of calls) {
          checkpoint(fallbackText);
          const result = isMemoryTool(call.name)
            ? await runMemoryTool(db, tester, call.name, call.input, { at: now, budget, sourceMessageId: messageId })
            : await runTool(db, state, call.name, call.input, now);
          if (result.ok && "optedOut" in result && result.optedOut) return OPT_OUT_CONFIRMATION;
          if (result.ok) {
            done.push(`${call.name} (${result.message.split("\n")[0]!.slice(0, ACTION_RESULT_CHARS)})`);
            tester = result.tester;
            state = await loadCoachState(db, tester, { now, isFirstText, justFinished, lastTesterText, goalCap });
            if (tester.phase === "onboarding" && onboardingComplete(state)) {
              tester = await updateTester(db, tester.id, { phase: "planning" });
              justFinished = true;
              state = await loadCoachState(db, tester, { now, isFirstText, justFinished, lastTesterText, goalCap });
            }
          }
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            ...(result.ok ? { content: `${result.message}${progress(state)}` } : { content: result.error, is_error: true }),
          });
        }

        trail.push(calls.map((c, i) => `${c.name}:${(results[i] as Anthropic.ToolResultBlockParam).is_error ? "error" : "ok"}`).join(","));
        // The model sometimes answers a forced-text round with nothing unless it's told why.
        if (round + 1 === MAX_ROUNDS) results.push({ type: "text", text: "No more tool calls for this reply: write your text to the tester now." });
        messages.push({ role: "assistant", content: response.raw ?? (response.content as Anthropic.ContentBlockParam[]) });
        messages.push({ role: "user", content: results });
      }
      throw new Error("unreachable: the last round always returns");
      }
    },
    /**
     * A text ZOH starts itself: the same prompt and tools (so the cache holds), only `NUDGE_TOOLS`
     * run (after lock, so the day's step can be saved first), and a note in place of a tester text
     * naming the moment (the state block says it too).
     */
    async nudge({ tester, turns, now, moment, previous, carry, mayskip }: NudgeRequest) {
      const fresh = previous ? ` Your last ${moment} text was: "${previous}". Make this one different: another opener, detail and shape.` : "";
      const carries = carry ? ` It also does what the state's "THIS TEXT ALSO" line says.` : "";
      // #42: a kickoff right after a morning chat that settled today's step only repeats it.
      const skip = mayskip
        ? ` They've already texted today. If today's conversation already covered what this text would say (today's step and time agreed, they're on it or moved it, or they owned a miss and talked through today's plan), answer only ${SKIP} and nothing goes out. Otherwise write it without repeating what was already said.`
        : "";
      const note = `[No new text from them. It's ${localTime(now, tester.timeZone)}. Write the ${moment} text now.${carries}${fresh}${skip}${DECLINE_NOTE}]`;
      const messages = toClaudeMessages([...turns, { role: "user", text: note }]);
      let state = await loadCoachState(db, tester, { now, isFirstText: false, nudgeMoment: moment, carry, goalCap });
      const memory = usesMemory(tester) ? await memoryBlock(db, tester) : undefined;
      // After lock, a text it starts can save the day's step first (#76); nothing else runs.
      const rounds = tester.phase === "active" ? NUDGE_ROUNDS : 1;
      let round = 1;
      let retried = false;
      for (;;) {
        const last = round >= rounds;
        const response = await model.create({
          system: systemBlocks(tester.phase === "onboarding" ? FIXED_INSTRUCTIONS : afterOnboarding, state, memory),
          messages,
          tools: toolsFor(tester),
          toolChoice: last ? "none" : "auto",
        });
        const calls = last ? [] : response.content.filter((b) => b.type === "tool_use");
        if (calls.length) {
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const call of calls) {
            const result = NUDGE_TOOLS.includes(call.name)
              ? await runTool(db, state, call.name, call.input, now)
              : ({ ok: false, error: `Only ${NUDGE_TOOLS.join(", ")} while writing a text you start.` } as const);
            if (result.ok) state = await loadCoachState(db, result.tester, { now, isFirstText: false, nudgeMoment: moment, carry, goalCap });
            results.push({ type: "tool_result", tool_use_id: call.id, ...(result.ok ? { content: result.message } : { content: result.error, is_error: true }) });
          }
          messages.push({ role: "assistant", content: response.raw ?? (response.content as Anthropic.ContentBlockParam[]) });
          messages.push({ role: "user", content: results });
          round++;
          continue;
        }
        const text = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        // Starts with SKIP: a reason tacked on after it ("SKIP. Alex already agreed") must never reach them.
        const skipped = new RegExp(`^\\W*${SKIP}\\b`).test(text);
        if (skipped && mayskip) return null;
        // #109: any other SKIP, or words about not sending, is a decline: held, never sent.
        if (skipped || readsAsSendDecision(text)) return { held: true, wrote: text } satisfies HeldNudge;
        // #108: a tool's name on its own line never reaches them.
        const clean = withoutToolNames(text, toolsFor(tester).map((t) => t.name));
        if (clean) return clean;
        // Rarely the answer comes back with no text (as in a reply's rounds): one more try before failing.
        if (retried) throw new NoReplyTextError(`Claude returned no nudge text (stop_reason: ${response.stopReason})`);
        retried = true;
      }
    },
    check: () => model.check(),
  };
}

/**
 * Fixed instructions first, cached (tools are cached with them); then the memory block once the
 * plan is locked, cached too (it changes overnight); the state block, rebuilt every call, last.
 */
export function systemBlocks(fixed: string, state: CoachState, memory?: string): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: fixed, cache_control: { type: "ephemeral" } },
    ...(memory ? [{ type: "text" as const, text: memory, cache_control: { type: "ephemeral" as const } }] : []),
    { type: "text", text: buildStateBlock(state) },
  ];
}

/** The tools for a reply: onboarding adds choose_goal; once the plan is locked, the memory lookups and forget. */
function toolsFor(tester: Tester): Anthropic.Tool[] {
  const base = tester.phase === "onboarding" ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((t) => t.name !== "choose_goal");
  const memory = MEMORY_TOOL_DEFINITIONS.filter((t) => usesMemory(tester) || ALWAYS_MEMORY_TOOLS.includes(t.name as MemoryToolName));
  return [...base, ...memory];
}

function isMemoryTool(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as string[]).includes(name);
}

/**
 * Caches the conversation up to their latest text: every later round in the reply re-reads it
 * from cache instead of paying for it again. (The marker isn't visible to the model.)
 */
function markCached(messages: Anthropic.MessageParam[]): void {
  const last = messages.at(-1);
  if (!last || typeof last.content === "string") return;
  const blocks = last.content as Anthropic.ContentBlockParam[];
  const end = blocks.at(-1);
  if (end && (end.type === "text" || end.type === "image")) blocks[blocks.length - 1] = { ...end, cache_control: { type: "ephemeral" } };
}

function addUsage(total: TokenUsage, u: TokenUsage | undefined): void {
  if (!u) return;
  total.input += u.input;
  total.cacheRead += u.cacheRead;
  total.cacheWrite += u.cacheWrite;
  total.output += u.output;
}

/** Short progress note on each successful tool result, so the next round sees what's left. */
function progress(state: CoachState): string {
  if (!state.goal) return " Goal: not chosen yet.";
  if (state.justFinished && !state.draft) return " Onboarding finished: ask the next thing the plan needs, or bridge into the plan with propose_plan.";
  const open = state.openRequired.map((q) => q.key).join(", ");
  return open ? ` Still open: ${open}.` : "";
}
