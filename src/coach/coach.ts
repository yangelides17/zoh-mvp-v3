import type Anthropic from "@anthropic-ai/sdk";
import {
  DraftDroppedError,
  settled,
  NoReplyTextError,
  type HeldNudge,
  toClaudeMessages,
  type DroppedDraft,
  type ClaudeModel,
  type ModelRequest,
  type ModelResponse,
  type NudgeRequest,
  type Replier,
  type ReplyInput,
  type TokenUsage,
} from "../claude/replier.js";
import { addSeen, allowance, linkKey, unseenLinks, withoutLinks } from "./links.js";
import { MAX_CONTINUATIONS, runWatchVideo, WATCH_VIDEO_TOOL, webBudget, webTools } from "./web.js";
import type { Db } from "../db/client.js";
import type { Tester } from "../db/schema.js";
import type { MediaStore } from "../media/storage.js";
import type { VideoWatcher } from "../video/gemini.js";
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
import { buildStateBlock, FIXED_INSTRUCTIONS, instructionsFor, PARTS, partsFor, type Part } from "./prompt.js";
import { loadCoachState, localTime, onboardingComplete, type CoachState } from "./state.js";
import { runTool, TOOL_DEFINITIONS } from "./tools.js";

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

/**
 * #131: told when a round writes text alongside tool calls. Only the final round's text is sent, but the
 * model sees its own earlier text in the history and took it as said ("still waiting on your answer" to a
 * step they never saw).
 */
export const NOT_SENT_NOTE =
  "[Nothing has gone out yet: they haven't seen the text you wrote with these tool calls. Only your final text is sent, so write your whole reply to them next. Don't mention this note.]";

/** #108: told once when a reply's text has a tool's name on its own line (it wrote the call instead of making it). */
export const TOOL_AS_TEXT_NOTE =
  "[Your text had a tool's name on its own line, which they'd see. If you meant to use it, call it now; then write only your text to them. Don't mention this note.]";

/**
 * #162: told once when a reply has a link it didn't see this turn (an invented one breaks their trust), or a video it
 * didn't watch. If it still has one after this, the link is taken out before sending.
 */
export function unseenLinkNote(links: string[]): string {
  return `[Your text has ${links.length === 1 ? "a link" : "links"} you didn't find, open or get from them in this reply: ${links.join(", ")}. Only links from your searches, pages you opened or the texts may go to them, and a YouTube link only once you've watched it this reply (watch_video). Look it up now if you need it, or write your text without it. Don't mention this note.]`;
}

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
  /** The voice, in place of the voice page's (tests); the rule sections always come from docs/coach-voice.md. */
  voice?: string;
  /** Focus plus maintenance goals a tester can have (`GOAL_CAP`); defaults to 3. */
  goalCap?: number;
  /** #163: our copies of their files, for open_file; without it, only what was read when they arrived. */
  media?: MediaStore;
  /** #163: re-watches a video for open_file, with their question. */
  watcher?: VideoWatcher;
  /**
   * #200: the status sheet goes at the end of the latest message, labelled as the app's, instead of last in the
   * system prompt (models attend most to what's nearest the end). Off unless wiring turns it on.
   */
  sheetInMessage?: boolean;
}

/**
 * The coach: one reply per inbound text, from a short tool loop. Tools save what it learns;
 * the app (not the model) moves the tester to `planning` once the goal and every required
 * plan question are saved, and tells the model to carry straight on into the plan.
 */
export function createCoach(opts: CoachOptions): Replier {
  const { db, model, goalCap } = opts;
  // The page is read when prompt.ts loads at startup, so a missing page stops the app, not a reply.
  /** #200: the cached instruction blocks: onboarding's own prompt, or the core and the parts loaded so far. */
  const instructions = (phase: Tester["phase"], parts: readonly Part[]): string[] => {
    if (phase === "onboarding") return [FIXED_INSTRUCTIONS];
    const { core, moments } = instructionsFor(phase, parts, opts.voice);
    return moments ? [core, moments] : [core];
  };
  /** One request's system and messages: the sheet last in the system prompt, or (the switch) last in their latest message. */
  const request = (blocks: string[], state: CoachState, memory: string | undefined, messages: Anthropic.MessageParam[]) =>
    opts.sheetInMessage
      ? { system: systemBlocks(blocks, undefined, memory), messages: withSheet(messages, state) }
      : { system: systemBlocks(blocks, state, memory), messages };
  return {
    async reply({ tester: initial, turns, now, messageId, onUsage, onAction, onSections, onActivity, onLookup, interrupted, signal, dropped, media }: ReplyInput) {
      const messages = toClaudeMessages(turns);
      if (messages.length === 0) throw new Error("Nothing to reply to");
      // #16: the reply that replaces dropped drafts hears what they did and wrote.
      const note = droppedDraftNote(dropped);
      if (note) (messages.at(-1)!.content as Anthropic.ContentBlockParam[]).push({ type: "text", text: note });
      /** Actions this draft finished, handed on if it's dropped. */
      const done: string[] = [];
      // #162: the links it may send: everything in the texts, what a dropped draft found or wrote, and (below) the
      // state, memory, tool results, searches, opened pages and videos it watches.
      const allowed = allowance();
      addSeen(allowed, ...turns.map((t) => t.text), ...(dropped?.found ?? []), dropped?.text ?? "");
      for (const w of dropped?.watched ?? []) allowed.watched.add(linkKey(w));
      /** #162: links this draft's searches and pages turned up, and videos it watched, handed on if it's dropped. */
      const found: string[] = [];
      const watched: string[] = [];
      /** #16: a safe point. They texted again: stop here, before the next call, action or send. */
      const checkpoint = (text?: string) => {
        if (interrupted?.()) throw new DraftDroppedError(handOn(text));
      };
      const handOn = (text?: string): DroppedDraft => ({
        actions: done,
        ...(text ? { text } : {}),
        ...(found.length ? { found } : {}),
        ...(watched.length ? { watched } : {}),
      });
      // Read once per reply: it only changes overnight (or on a preference or forget, which the tool result reports).
      const memory = usesMemory(initial) ? await memoryBlock(db, initial) : undefined;
      if (memory) addSeen(allowed, memory);
      const budget: LookupBudget = { lookups: 0, searches: 0 };
      const web = webBudget();
      const usage: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      /** #200: the parts this reply has loaded; a tool call can add one, never drop one. */
      let parts: Part[] = [];
      try {
        return await replyLoop();
      } finally {
        onUsage?.({ ...usage, watches: web.watches });
        onSections?.(loadedNames(initial.phase, parts));
      }

      /** Counts what a call used and keeps the links it found. */
      function account(r: ModelResponse): void {
        addUsage(usage, r.usage);
        web.searches += r.usage?.searches ?? 0;
        web.fetches += r.usage?.fetches ?? 0;
        for (const line of r.lookups ?? []) onLookup?.(line);
        for (const link of r.found ?? []) {
          found.push(link);
          allowed.seen.add(linkKey(link));
        }
      }

      /**
       * #162: one round's call. A search that pauses (`pause_turn`) is let go on, up to `MAX_CONTINUATIONS`: the same
       * request with what it wrote so far, which the API resumes. Not a round, and no new sheet.
       */
      async function ask(req: ModelRequest): Promise<ModelResponse> {
        let response = await model.create(req);
        account(response);
        for (let n = 0; response.stopReason === "pause_turn" && n < MAX_CONTINUATIONS; n++) {
          const sofar = response.raw ?? (response.content as Anthropic.ContentBlockParam[]);
          const next = await model.create({ ...req, messages: [...req.messages, { role: "assistant", content: sofar }], tools: [...req.tools.filter((t) => !isWebTool(t.name)), ...webTools(web)] });
          account(next);
          response = joinPaused(response, next);
        }
        if (response.stopReason === "pause_turn") onLookup?.(`search still paused after ${MAX_CONTINUATIONS} continuations`);
        return response;
      }

      async function replyLoop(): Promise<string> {
      const isFirstText = !turns.some((t) => t.role === "assistant");
      // Every text since ZOH's last reply: the model reads them as one message, so a commitment can be in any.
      const lastTesterText = turns
        .slice(turns.findLastIndex((t) => t.role === "assistant") + 1)
        .map((t) => t.text)
        .join("\n");
      // #157: what ZOH last said, so a deepen or upgrade is saved only once it was shown to them.
      const lastZohText = turns.findLast((t) => t.role === "assistant")?.text ?? "";

      let tester: Tester = initial;
      let justFinished = false;
      let state = await loadCoachState(db, tester, { now, isFirstText, lastTesterText, lastZohText, goalCap });
      // #162: the team's requests (and anything else on the sheet) may carry a link to pass on.
      addSeen(allowed, buildStateBlock(state));
      let fallbackText = "";
      // Fixed for the whole reply: changing tools mid-loop breaks the cache and the history's tool calls. #162: only the
      // web tools change, and only once a round used some of the reply's searches or pages (their caps go down).
      const ownTools = [...toolsFor(initial), ...(opts.watcher ? [WATCH_VIDEO_TOOL] : [])];
      // Onboarding keeps its condensed prompt so its rules stay sharp; afterwards, the core and what this moment needs.
      const reach = { media: !!media };
      parts = partsFor(state, reach);
      /** Tool names and outcomes per round (never their inputs), for the error if no text comes back. */
      const trail: string[] = [];
      let retried = false;
      let nudgedPastSave = false;
      let nudgedPastToolName = false;
      let nudgedPastLinks = false;
      const toolNames = ownTools.map((t) => t.name);

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const last = round === MAX_ROUNDS;
        checkpoint(fallbackText);
        // #162: the newest message is cached, so pages opened in one round are re-read from cache in the next.
        cacheNewest(messages);
        let response: ModelResponse;
        try {
          response = await ask({
            ...request(instructions(initial.phase, parts), state, memory, messages),
            tools: [...ownTools, ...webTools(web)],
            toolChoice: last ? "none" : "auto",
            ...(signal ? { signal } : {}),
            ...(onActivity ? { onActivity } : {}),
            // #162: once it has searched, a timed-out call isn't retried (each can take two minutes).
            noRetry: web.searches + web.fetches + web.watches > 0,
          });
        } catch (err) {
          // Cut off because they texted again: nothing from this call ran.
          if (signal?.aborted) throw new DraftDroppedError(handOn(fallbackText));
          throw err;
        }
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
          messages.push({ role: "assistant", content: settled(response.raw ?? (response.content as Anthropic.ContentBlockParam[])) });
          messages.push({ role: "user", content: [{ type: "text", text: TOOL_AS_TEXT_NOTE }] });
          continue;
        }
        // #37: after saving, a bare "Saved." left testers at a dead end: once, ask for the real reply.
        if (calls.length === 0 && !last && !nudgedPastSave && trail.some((r) => r.includes(":ok")) && onlySaveConfirmation(text)) {
          nudgedPastSave = true;
          trail.push("save-only");
          messages.push({ role: "assistant", content: settled(response.raw ?? (response.content as Anthropic.ContentBlockParam[])) });
          messages.push({ role: "user", content: [{ type: "text", text: SAVE_ONLY_NOTE }] });
          continue;
        }
        if (calls.length === 0 || last) {
          let reply = withoutToolNames(text, ALL_TOOL_NAMES) || fallbackText;
          // #162: a link it never saw this turn, or a video it didn't watch: once, ask it to look it up or drop it.
          const unseen = unseenLinks(reply, allowed);
          if (unseen.length && !last && !nudgedPastLinks) {
            nudgedPastLinks = true;
            trail.push("unseen-link");
            messages.push({ role: "assistant", content: settled(response.raw ?? (response.content as Anthropic.ContentBlockParam[])) });
            messages.push({ role: "user", content: [{ type: "text", text: unseenLinkNote(unseen) }] });
            continue;
          }
          // Still there (or no round left to ask): it's taken out, never sent.
          if (unseen.length) {
            reply = withoutLinks(reply, unseen);
            onLookup?.(`removed a link it never saw: ${unseen.join(" ")}`);
          }
          if (!reply) {
            throw new NoReplyTextError(`Claude returned no text (stop_reason: ${response.stopReason}; rounds: ${trail.join(" | ") || "none"})`);
          }
          checkpoint(reply);
          return reply;
        }
        if (text) fallbackText = withoutToolNames(text, ALL_TOOL_NAMES);

        const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
        for (const call of calls) {
          checkpoint(fallbackText);
          if (call.name === WATCH_VIDEO_TOOL.name) {
            const watchedNow = opts.watcher
              ? await runWatchVideo(opts.watcher, call.input, { budget: web, allowed, ...(onActivity ? { onActivity } : {}) })
              : ({ ok: false, error: "Videos can't be watched right now: say so if it matters." } as const);
            const url = String((call.input as { url?: unknown } | undefined)?.url ?? "");
            onLookup?.(watchedNow.ok ? `watched ${url}` : `couldn't watch ${url} (${(("cause" in watchedNow && watchedNow.cause) || watchedNow.error).slice(0, 120)})`);
            if (watchedNow.ok) {
              watched.push(url);
              const action = `watch_video (${watchedNow.message.split("\n")[0]!.slice(0, ACTION_RESULT_CHARS)})`;
              done.push(action);
              onAction?.(action);
            }
            results.push({ type: "tool_result", tool_use_id: call.id, ...(watchedNow.ok ? { content: watchedNow.message } : { content: watchedNow.error, is_error: true }) });
            continue;
          }
          const result = isMemoryTool(call.name)
            ? await runMemoryTool(db, tester, call.name, call.input, { at: now, budget, sourceMessageId: messageId, media: opts.media, watcher: opts.watcher })
            : await runTool(db, state, call.name, call.input, now);
          if (result.ok && "optedOut" in result && result.optedOut) return OPT_OUT_CONFIRMATION;
          if (result.ok) {
            const action = `${call.name} (${result.message.split("\n")[0]!.slice(0, ACTION_RESULT_CHARS)})`;
            done.push(action);
            onAction?.(action);
            // #162: a document or memory it opened may hold a link to pass on.
            addSeen(allowed, result.message);
            tester = result.tester;
            state = await loadCoachState(db, tester, { now, isFirstText, justFinished, lastTesterText, lastZohText, goalCap });
            if (tester.phase === "onboarding" && onboardingComplete(state)) {
              tester = await updateTester(db, tester.id, { phase: "planning" });
              justFinished = true;
              state = await loadCoachState(db, tester, { now, isFirstText, justFinished, lastTesterText, lastZohText, goalCap });
            }
            parts = grown(parts, partsFor(state, reach));
          }
          // #163: open_file hands back the file itself (a photo, a PDF) after its words.
          const files = result.ok && "blocks" in result ? (result.blocks ?? []) : [];
          const words = result.ok ? `${result.message}${progress(state)}` : "";
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            ...(result.ok
              ? { content: files.length ? [{ type: "text" as const, text: words }, ...files] : words }
              : { content: result.error, is_error: true }),
          });
        }

        trail.push(calls.map((c, i) => `${c.name}:${(results[i] as Anthropic.ToolResultBlockParam).is_error ? "error" : "ok"}`).join(","));
        // #131: text written with tool calls never reaches them; say so, so the next round doesn't treat it as seen.
        if (text) results.push({ type: "text", text: NOT_SENT_NOTE });
        // The model sometimes answers a forced-text round with nothing unless it's told why.
        if (round + 1 === MAX_ROUNDS) results.push({ type: "text", text: "No more tool calls for this reply: write your text to the tester now." });
        messages.push({ role: "assistant", content: settled(response.raw ?? (response.content as Anthropic.ContentBlockParam[])) });
        messages.push({ role: "user", content: results });
      }
      throw new Error("unreachable: the last round always returns");
      }
    },
    /**
     * A text ZOH starts itself: the same prompt, only `NUDGE_TOOLS` offered (after lock, so the
     * day's step can be saved first; #196: a tool it can't use isn't offered), and a note in place
     * of a tester text naming the moment (the state block says it too).
     */
    async nudge({ tester, turns, now, moment, previous, carry, mayskip, onSections }: NudgeRequest) {
      const fresh = previous ? ` Your last ${moment} text was: "${previous}". Make this one different: another opener, detail and shape.` : "";
      const carries = carry ? ` It also does what the state's "This text carries" says.` : "";
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
      const nudgeTools = toolsFor(tester).filter((t) => NUDGE_TOOLS.includes(t.name));
      // #200: exactly the parts its moment needs.
      let parts = partsFor(state);
      try {
        return await nudgeLoop();
      } finally {
        onSections?.(loadedNames(tester.phase, parts));
      }

      async function nudgeLoop() {
      let round = 1;
      let retried = false;
      for (;;) {
        const last = round >= rounds;
        const response = await model.create({
          ...request(instructions(tester.phase, parts), state, memory, messages),
          tools: nudgeTools,
          toolChoice: last ? "none" : "auto",
        });
        const calls = last ? [] : response.content.filter((b) => b.type === "tool_use");
        if (calls.length) {
          const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
          for (const call of calls) {
            const result = NUDGE_TOOLS.includes(call.name)
              ? await runTool(db, state, call.name, call.input, now)
              : ({ ok: false, error: `Only ${NUDGE_TOOLS.join(", ")} while writing a text you start.` } as const);
            if (result.ok) {
              state = await loadCoachState(db, result.tester, { now, isFirstText: false, nudgeMoment: moment, carry, goalCap });
              parts = grown(parts, partsFor(state));
            }
            results.push({ type: "tool_result", tool_use_id: call.id, ...(result.ok ? { content: result.message } : { content: result.error, is_error: true }) });
          }
          // #131: as in replies, text written with tool calls isn't sent.
          if (response.content.some((b) => b.type === "text" && b.text.trim())) results.push({ type: "text", text: NOT_SENT_NOTE });
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
        // #108: a tool's name on its own line never reaches them, offered or not.
        const clean = withoutToolNames(text, ALL_TOOL_NAMES);
        if (clean) return clean;
        // Rarely the answer comes back with no text (as in a reply's rounds): one more try before failing.
        if (retried) throw new NoReplyTextError(`Claude returned no nudge text (stop_reason: ${response.stopReason})`);
        retried = true;
      }
      }
    },
    check: () => model.check(),
  };
}

/**
 * Fixed instructions first, each block cached (tools are cached with the first; #200: the core, then the parts this
 * moment loads); then the memory block once the plan is locked, cached too (it changes overnight); the state block,
 * rebuilt every call, last, unless it rides in the latest message (`withSheet`).
 */
export function systemBlocks(fixed: string[], state: CoachState | undefined, memory?: string): Anthropic.TextBlockParam[] {
  return [
    ...fixed.map((text) => ({ type: "text" as const, text, cache_control: { type: "ephemeral" as const } })),
    ...(memory ? [{ type: "text" as const, text: memory, cache_control: { type: "ephemeral" as const } }] : []),
    ...(state ? [{ type: "text" as const, text: buildStateBlock(state) }] : []),
  ];
}

/** #200: what opens the status sheet when it rides in their latest message, so it's never read as their words. */
export const SHEET_LABEL = "[Written by the app, not by them: the status sheet for this text. They never see it.]";

/**
 * #200: the messages with the status sheet as the last thing in the latest one. Only this call's copy carries it, so
 * the conversation never holds an old sheet: there's exactly one, rebuilt every round.
 */
export function withSheet(messages: Anthropic.MessageParam[], state: CoachState): Anthropic.MessageParam[] {
  const last = messages.at(-1);
  if (!last) return messages;
  const content: Anthropic.ContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  // Same role as before, one more text block: the cast only re-joins the role and content the spread split apart.
  const withIt = { ...last, content: [...content, { type: "text", text: `${SHEET_LABEL}\n${buildStateBlock(state)}` }] } as Anthropic.MessageParam;
  return [...messages.slice(0, -1), withIt];
}

/** #108, #200: every tool's name, offered in this reply or not, so none written as text reaches them. */
const ALL_TOOL_NAMES = [...TOOL_DEFINITIONS, ...MEMORY_TOOL_DEFINITIONS, WATCH_VIDEO_TOOL].map((t) => t.name);

/** #162: Anthropic's web tools, whose caps change as a reply uses them. */
const isWebTool = (name: string) => name === "web_search" || name === "web_fetch";

/**
 * #162: a paused call and its continuation as one answer: everything it wrote, in order (sent back as one assistant
 * turn), the continuation's text if it wrote any, and every tool call.
 */
function joinPaused(paused: ModelResponse, next: ModelResponse): ModelResponse {
  const said = next.content.some((b) => b.type === "text");
  return {
    content: [...paused.content.filter((b) => b.type === "tool_use" || !said), ...next.content],
    raw: [...(paused.raw ?? (paused.content as Anthropic.ContentBlockParam[])), ...(next.raw ?? (next.content as Anthropic.ContentBlockParam[]))],
    stopReason: next.stopReason,
    found: [...(paused.found ?? []), ...(next.found ?? [])],
  };
}

/** #200: the parts loaded so far, plus any the reply can now reach; never fewer. */
const grown = (had: readonly Part[], now: readonly Part[]): Part[] => PARTS.filter((p) => had.includes(p) || now.includes(p));

/** #200: what a reply or text ZOH started read, for the log. */
const loadedNames = (phase: Tester["phase"], parts: readonly Part[]): string[] => (phase === "onboarding" ? ["onboarding"] : ["core", ...parts]);

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
 * Caches the conversation up to the newest message (their latest text, then each round's tool results): every later
 * round in the reply re-reads it from cache instead of paying for it again. #162: the marker moves to the newest
 * message each round (one breakpoint, as the API allows four and the system prompt uses up to three), so a page
 * opened in one round isn't paid for in full again. (The marker isn't visible to the model.)
 */
function cacheNewest(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const [i, b] of m.content.entries()) {
      if ("cache_control" in b && b.cache_control) {
        const { cache_control: _, ...rest } = b;
        (m.content as Anthropic.ContentBlockParam[])[i] = rest as Anthropic.ContentBlockParam;
      }
    }
  }
  const last = messages.at(-1);
  if (!last || typeof last.content === "string") return;
  const blocks = last.content as Anthropic.ContentBlockParam[];
  const end = blocks.at(-1);
  if (end && (end.type === "text" || end.type === "image" || end.type === "tool_result" || end.type === "document")) {
    blocks[blocks.length - 1] = { ...end, cache_control: { type: "ephemeral" } };
  }
}

function addUsage(total: TokenUsage, u: TokenUsage | undefined): void {
  if (!u) return;
  total.input += u.input;
  total.cacheRead += u.cacheRead;
  total.cacheWrite += u.cacheWrite;
  total.output += u.output;
  if (u.searches) total.searches = (total.searches ?? 0) + u.searches;
  if (u.fetches) total.fetches = (total.fetches ?? 0) + u.fetches;
}

/** Short progress note on each successful tool result, so the next round sees what's left. */
function progress(state: CoachState): string {
  if (!state.goal) return " Goal: not chosen yet.";
  if (state.justFinished && !state.draft) return " Onboarding finished: ask the next thing the plan needs, or bridge into the plan with propose_plan.";
  const open = state.openRequired.map((q) => q.key).join(", ");
  return open ? ` Still open: ${open}.` : "";
}
