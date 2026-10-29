import Anthropic from "@anthropic-ai/sdk";
import type { Tester } from "../db/schema.js";
import type { NudgeCarry, NudgeMoment } from "../nudges/schedule.js";

/** One turn of the text conversation, already flattened to what Claude should see. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  /** Image to show Claude (only for the latest inbound photo), already converted to JPEG. */
  image?: { mediaType: "image/jpeg"; data: string };
}

export interface ReplyInput {
  tester: Tester;
  /**
   * The texts the coach reads word for word, oldest first, ending with their text: the whole
   * conversation before the plan locks; after it, the last two days (memory covers the rest).
   */
  turns: Turn[];
  now: Date;
  /** The stored text being answered: what a preference saved in this reply cites. */
  messageId?: string;
  /** Called once per reply with the tokens it used, for the message's timings. */
  onUsage?: (usage: TokenUsage) => void;
}

/** Tokens one reply used across its Claude calls. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Claude answered but wrote nothing to send (a refusal or an empty turn), as opposed to failing. */
export class NoReplyTextError extends Error {
  override name = "NoReplyTextError";
}

/** A text ZOH starts itself (src/nudges): no new text from the tester. */
export interface NudgeRequest {
  tester: Tester;
  /** The conversation since the tester's context started, oldest first. */
  turns: Turn[];
  now: Date;
  /** Which nudge to write (kickoff, rest_day, checkin…); the coach's prompt defines each. */
  moment: NudgeMoment;
  /** The last text ZOH sent them for this same moment, so this one reads differently. */
  previous?: string;
  /** A kickoff that also raises an approved next step or asks a maintenance check-in. */
  carry?: NudgeCarry;
  /** They've already texted today: the coach may skip a kickoff the conversation already covered (#42). */
  mayskip?: boolean;
}

/** What the pipeline asks for a reply. The coach (src/coach) is the real one; tests fake it. */
export interface Replier {
  reply(input: ReplyInput): Promise<string>;
  /** Writes a nudge; repliers without it never start texts. Null: skipped (only when `mayskip`). */
  nudge?(input: NudgeRequest): Promise<string | null>;
  /** Cheap connectivity check for /health?deep=1. */
  check(): Promise<void>;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };

/**
 * Turns into Claude messages: starts with a user turn, merges consecutive
 * same-role turns, and ends with a user turn.
 */
export function toClaudeMessages(turns: Turn[]): Anthropic.MessageParam[] {
  const out: { role: "user" | "assistant"; content: ContentBlock[] }[] = [];
  for (const turn of turns) {
    const blocks: ContentBlock[] = [];
    if (turn.image) {
      blocks.push({ type: "image", source: { type: "base64", media_type: turn.image.mediaType, data: turn.image.data } });
    }
    if (turn.text.trim()) blocks.push({ type: "text", text: turn.text });
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) last.content.push(...blocks);
    else out.push({ role: turn.role, content: blocks });
  }
  while (out[0]?.role === "assistant") out.shift();
  while (out.length > 0 && out[out.length - 1]?.role === "assistant") out.pop();
  return out as Anthropic.MessageParam[];
}

/** One Claude call with tools, narrowed to what the coach uses. */
export interface ModelRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  /** "none" forces a text answer (the coach's last tool round). */
  toolChoice?: "auto" | "none";
}

export type ModelBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ModelResponse {
  content: ModelBlock[];
  /** Every block as returned, thinking included: tool loops must send these back unchanged. */
  raw?: Anthropic.ContentBlockParam[];
  stopReason: string | null;
  usage?: TokenUsage;
}

/** The seam between the coach and Anthropic's API; `test/helpers.ts` has a scripted fake. */
export interface ClaudeModel {
  create(req: ModelRequest): Promise<ModelResponse>;
  check(): Promise<void>;
}

export interface ClaudeModelOptions {
  apiKey: string;
  model: string;
  /** Includes thinking tokens, so leave room beyond the visible reply. */
  maxTokens: number;
  /** Thinking depth (the coach uses "medium"). */
  effort?: "low" | "medium" | "high";
  /** Per request; defaults to 30 s (a reply). The overnight memory pass writes more and gets longer. */
  timeoutMs?: number;
  client?: Anthropic;
}

export function createClaudeModel(opts: ClaudeModelOptions): ClaudeModel {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: opts.timeoutMs ?? 30_000 });
  return {
    async create(req) {
      const withTools = req.tools.length > 0;
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: req.system,
        messages: req.messages,
        ...(withTools ? { tools: req.tools } : {}),
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
        ...(withTools && req.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}),
      });
      const content: ModelBlock[] = [];
      for (const b of response.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      const u = response.usage;
      const usage: TokenUsage = {
        input: u.input_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens,
      };
      return { content, raw: response.content as Anthropic.ContentBlockParam[], stopReason: response.stop_reason, usage };
    },
    async check() {
      await client.models.retrieve(opts.model);
    },
  };
}
