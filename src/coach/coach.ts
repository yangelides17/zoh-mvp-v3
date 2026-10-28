import type Anthropic from "@anthropic-ai/sdk";
import {
  NoReplyTextError,
  toClaudeMessages,
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
}

/**
 * The coach: one reply per inbound text, from a short tool loop. Tools save what it learns;
 * the app (not the model) moves the tester to `planning` once the goal and every required
 * plan question are saved, and tells the model to carry straight on into the plan.
 */
export function createCoach(opts: CoachOptions): Replier {
  const { db, model } = opts;
  // Read at startup (wiring builds the coach then), so a missing page stops the app, not a reply.
  const afterOnboarding = fullVoiceInstructions(opts.voice ?? loadVoiceDoc());
  return {
    async reply({ tester: initial, turns, now, messageId, onUsage }: ReplyInput) {
      const messages = toClaudeMessages(turns);
      if (messages.length === 0) throw new Error("Nothing to reply to");
      markCached(messages);
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
      let state = await loadCoachState(db, tester, { now, isFirstText, lastTesterText });
      let fallbackText = "";
      // Fixed for the whole reply: changing tools mid-loop breaks the cache and the history's tool calls.
      const tools = toolsFor(initial);
      // Onboarding keeps its condensed prompt so its rules stay sharp; afterwards, the whole voice page.
      const fixed = initial.phase === "onboarding" ? FIXED_INSTRUCTIONS : afterOnboarding;
      /** Tool names and outcomes per round (never their inputs), for the error if no text comes back. */
      const trail: string[] = [];
      let retried = false;

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const last = round === MAX_ROUNDS;
        const response = await model.create({
          system: systemBlocks(fixed, state, memory),
          messages,
          tools,
          toolChoice: last ? "none" : "auto",
        });
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
        if (calls.length === 0 || last) {
          const reply = text || fallbackText;
          if (!reply) {
            throw new NoReplyTextError(`Claude returned no text (stop_reason: ${response.stopReason}; rounds: ${trail.join(" | ") || "none"})`);
          }
          return reply;
        }
        if (text) fallbackText = text;

        const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
        for (const call of calls) {
          const result = isMemoryTool(call.name)
            ? await runMemoryTool(db, tester, call.name, call.input, { at: now, budget, sourceMessageId: messageId })
            : await runTool(db, state, call.name, call.input, now);
          if (result.ok && "optedOut" in result && result.optedOut) return OPT_OUT_CONFIRMATION;
          if (result.ok) {
            tester = result.tester;
            state = await loadCoachState(db, tester, { now, isFirstText, justFinished, lastTesterText });
            if (tester.phase === "onboarding" && onboardingComplete(state)) {
              tester = await updateTester(db, tester.id, { phase: "planning" });
              justFinished = true;
              state = await loadCoachState(db, tester, { now, isFirstText, justFinished, lastTesterText });
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
     * A text ZOH starts itself: one call with the same prompt and tools (so the cache holds), no
     * tool use, and a note in place of a tester text naming the moment (the state block says it too).
     */
    async nudge({ tester, turns, now, moment }: NudgeRequest) {
      const note = `[No new text from them. It's ${localTime(now, tester.timeZone)}. Write the ${moment} text now.]`;
      const messages = toClaudeMessages([...turns, { role: "user", text: note }]);
      const state = await loadCoachState(db, tester, { now, isFirstText: false, nudgeMoment: moment });
      const memory = usesMemory(tester) ? await memoryBlock(db, tester) : undefined;
      const response = await model.create({
        system: systemBlocks(tester.phase === "onboarding" ? FIXED_INSTRUCTIONS : afterOnboarding, state, memory),
        messages,
        tools: toolsFor(tester),
        toolChoice: "none",
      });
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) throw new NoReplyTextError(`Claude returned no nudge text (stop_reason: ${response.stopReason})`);
      return text;
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
