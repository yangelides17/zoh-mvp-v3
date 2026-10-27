import type Anthropic from "@anthropic-ai/sdk";
import { toClaudeMessages, type ClaudeModel, type Replier, type ReplyInput } from "../claude/replier.js";
import type { Db } from "../db/client.js";
import type { Tester } from "../db/schema.js";
import { OPT_OUT_CONFIRMATION } from "../testers/commands.js";
import { updateTester } from "../testers/testers.js";
import { buildStateBlock, FIXED_INSTRUCTIONS } from "./prompt.js";
import { loadCoachState, onboardingComplete, type CoachState } from "./state.js";
import { runTool, TOOL_DEFINITIONS } from "./tools.js";

/** Claude calls per reply. The last one can't use tools, so it always ends in text. */
export const MAX_ROUNDS = 4;

/**
 * Messages the coach sees during onboarding and planning: the whole conversation since the
 * tester's context started, capped for safety. Feature 8 replaces this with summaries.
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
}

/**
 * The coach: one reply per inbound text, from a short tool loop. Tools save what it learns;
 * the app (not the model) moves the tester to `planning` once the goal and every required
 * plan question are saved, and tells the model that this reply is the recap.
 */
export function createCoach(opts: CoachOptions): Replier {
  const { db, model } = opts;
  return {
    async reply({ tester: initial, turns, now }: ReplyInput) {
      const messages = toClaudeMessages(turns);
      if (messages.length === 0) throw new Error("Nothing to reply to");
      const isFirstText = !turns.some((t) => t.role === "assistant");

      let tester: Tester = initial;
      let justFinished = false;
      let state = await loadCoachState(db, tester, { now, isFirstText });
      let fallbackText = "";
      // Fixed for the whole reply: changing tools mid-loop breaks the cache and the history's tool calls.
      const tools = toolsFor(initial);
      /** Tool names and outcomes per round (never their inputs), for the error if no text comes back. */
      const trail: string[] = [];
      let retried = false;

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const last = round === MAX_ROUNDS;
        const response = await model.create({
          system: systemBlocks(state),
          messages,
          tools,
          toolChoice: last ? "none" : "auto",
        });
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
            throw new Error(`Claude returned no text (stop_reason: ${response.stopReason}; rounds: ${trail.join(" | ") || "none"})`);
          }
          return reply;
        }
        if (text) fallbackText = text;

        const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
        for (const call of calls) {
          const result = await runTool(db, state, call.name, call.input, now);
          if (result.ok && result.optedOut) return OPT_OUT_CONFIRMATION;
          if (result.ok) {
            tester = result.tester;
            state = await loadCoachState(db, tester, { now, isFirstText, justFinished });
            if (tester.phase === "onboarding" && onboardingComplete(state)) {
              tester = await updateTester(db, tester.id, { phase: "planning" });
              justFinished = true;
              state = await loadCoachState(db, tester, { now, isFirstText, justFinished });
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
    },
    check: () => model.check(),
  };
}

/** Fixed instructions first, cached (tools are cached with them); the state block after. */
export function systemBlocks(state: CoachState): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: FIXED_INSTRUCTIONS, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildStateBlock(state) },
  ];
}

function toolsFor(tester: Tester): Anthropic.Tool[] {
  return tester.phase === "onboarding" ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((t) => t.name !== "choose_goal");
}

/** Short progress note on each successful tool result, so the next round sees what's left. */
function progress(state: CoachState): string {
  if (!state.goal) return " Goal: not chosen yet.";
  if (state.justFinished) return " Onboarding finished: this reply is the recap and plan-is-coming line.";
  const open = state.openRequired.map((q) => q.key).join(", ");
  return open ? ` Still open: ${open}.` : "";
}
