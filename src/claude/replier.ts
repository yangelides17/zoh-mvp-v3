import Anthropic from "@anthropic-ai/sdk";
import type { Tester } from "../db/schema.js";
import type { NudgeCarry, NudgeMoment } from "../nudges/schedule.js";

/** One turn of the text conversation, already flattened to what Claude should see. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  /** Image to show Claude (only for the latest inbound photo), already converted to JPEG. */
  image?: { mediaType: "image/jpeg"; data: string };
  /** #163: a PDF to show Claude (only for a document in the texts being answered), base64. */
  pdf?: string;
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
  /**
   * #16: true once they've texted again (or stopped) since this draft began. The coach checks it
   * between steps and gives up with `DraftDroppedError`, never mid-action.
   */
  interrupted?: () => boolean;
  /** Aborts a Claude call in flight when the draft is interrupted (no side effects yet). */
  signal?: AbortSignal;
  /**
   * #132: told each action as it finishes (the same line a dropped draft hands on), so a draft that
   * finished but is dropped before sending (a text during the grace or a hold) still hands on what it did.
   */
  onAction?: (action: string) => void;
  /** What earlier drafts of this reply did before they were dropped: the coach is told, so it doesn't redo it. */
  dropped?: DroppedDraft;
  /** #200: a photo, voice note, video or file is among the texts being answered (its proof rules load). */
  media?: boolean;
  /** #200: told once, at the end, which parts of the instructions the reply loaded, for the log. */
  onSections?: (sections: string[]) => void;
  /** #162: told the moment a web search, page read or video watch starts, for a status text. */
  onActivity?: (kind: WebActivity) => void;
  /** #162: told each search, page and video as it finishes (a line on what it asked and found), for the record. */
  onLookup?: (line: string) => void;
}

/** #162: what ZOH is doing that takes a while: searching, reading a page, watching a video. */
export type WebActivity = "search" | "reading" | "watching";

/** What a draft did before it was dropped (#16): actions it saved and words it had written. */
export interface DroppedDraft {
  /** One line per action that finished: the tool and its result. */
  actions: string[];
  /** The text it had written, never sent. */
  text?: string;
  /** #162: links its searches and opened pages turned up, which the redraft may still send. */
  found?: string[];
  /** #162: YouTube links it watched, which the redraft may still send. */
  watched?: string[];
}

/** Thrown by a reply that was interrupted at a safe point (#16): it carries what the draft did. */
export class DraftDroppedError extends Error {
  override name = "DraftDroppedError";
  constructor(readonly draft: DroppedDraft) {
    super("Draft dropped: they texted again before it was sent");
  }
}

/** Tokens one reply used across its Claude calls. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** #162: web searches, pages opened and videos watched (counted for cost, not tokens). */
  searches?: number;
  fetches?: number;
  watches?: number;
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
  /** #200: told once, at the end, which parts of the instructions the text loaded, for the log. */
  onSections?: (sections: string[]) => void;
}

/** #109: the coach declined a text it was asked to start (a SKIP, or words about not sending): never sent. */
export interface HeldNudge {
  held: true;
  /** What it wrote instead, for the log only. */
  wrote: string;
}

/** What the pipeline asks for a reply. The coach (src/coach) is the real one; tests fake it. */
export interface Replier {
  reply(input: ReplyInput): Promise<string>;
  /**
   * Writes a nudge; repliers without it never start texts. Null: skipped because today's talk covered it
   * (only when `mayskip`). `HeldNudge`: the coach declined to send it (#109); nothing goes out.
   */
  nudge?(input: NudgeRequest): Promise<string | null | HeldNudge>;
  /** Cheap connectivity check for /health?deep=1. */
  check(): Promise<void>;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

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
    if (turn.pdf) blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: turn.pdf } });
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

/** The coach's own tools, plus (#162) Anthropic's web search and web fetch, which run on Anthropic's side. */
export type ModelTool = Anthropic.Tool | Anthropic.WebSearchTool20260209 | Anthropic.WebFetchTool20260209;

/** One Claude call with tools, narrowed to what the coach uses. */
export interface ModelRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: ModelTool[];
  /** "none" forces a text answer (the coach's last tool round). */
  toolChoice?: "auto" | "none";
  /** Cuts the call off (#16: the draft was interrupted). */
  signal?: AbortSignal;
  /** #162: told when a web search or page read starts (the call streams, so it's the moment it happens). */
  onActivity?: (kind: WebActivity) => void;
  /** #162: no retry of a timed-out call: once a search ran, a retry could double a minutes-long wait. */
  noRetry?: boolean;
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
  /** #162: every link a search result or an opened page in this call turned up. */
  found?: string[];
  /** #162: a line per search or page ("searched "…": links", "opened link"), for the message's record. */
  lookups?: string[];
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
  /**
   * Per request; defaults to 30 s. The overnight memory pass writes more and gets longer, and so does a reply or a
   * console answer that can search the web (#162: 20 to 60 s is normal).
   */
  timeoutMs?: number;
  client?: Anthropic;
}

/** #162: a reply or console answer that may search and open pages waits this long per call. */
export const WEB_TIMEOUT_MS = 120_000;

export function createClaudeModel(opts: ClaudeModelOptions): ClaudeModel {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 1, timeout: opts.timeoutMs ?? 30_000 });
  return {
    async create(req) {
      const withTools = req.tools.length > 0;
      // Streamed (#162): a search or page read is known the moment it starts, for the status text.
      const stream = client.messages.stream(
        {
          model: opts.model,
          max_tokens: opts.maxTokens,
          system: req.system,
          messages: req.messages,
          ...(withTools ? { tools: req.tools } : {}),
          ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
          ...(withTools && req.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}),
        },
        { ...(req.signal ? { signal: req.signal } : {}), ...(req.noRetry ? { maxRetries: 0 } : {}) },
      );
      const told = req.onActivity;
      if (told) {
        stream.on("streamEvent", (event) => {
          if (event.type !== "content_block_start" || event.content_block.type !== "server_tool_use") return;
          if (event.content_block.name === "web_search") told("search");
          else if (event.content_block.name === "web_fetch") told("reading");
        });
      }
      const response = await stream.finalMessage();
      const u = response.usage;
      const usage: TokenUsage = {
        input: u.input_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens,
        searches: u.server_tool_use?.web_search_requests ?? 0,
        fetches: u.server_tool_use?.web_fetch_requests ?? 0,
      };
      return { ...readBlocks(response.content), raw: response.content as Anthropic.ContentBlockParam[], stopReason: response.stop_reason, usage };
    },
    async check() {
      await client.models.retrieve(opts.model);
    },
  };
}

/**
 * #162: the blocks the coach acts on, from a response that may hold searches and opened pages. Only the text after the
 * last server tool's result is the answer (before it is preamble: "let me look that up"), and a search splits its
 * answer into cited pieces, so those join with nothing between them. Without one, text blocks stay as they came.
 */
export function readBlocks(blocks: readonly { type: string }[]): { content: ModelBlock[]; found: string[]; lookups: string[] } {
  const calls: ModelBlock[] = [];
  const found: string[] = [];
  const lookups: string[] = [];
  /** What each search asked, by its id, for the lookup lines. */
  const asked = new Map<string, string>();
  let texts: string[] = [];
  let searched = false;
  for (const b of blocks) {
    if (b.type === "text") texts.push((b as Anthropic.TextBlock).text);
    else if (b.type === "tool_use") {
      const t = b as Anthropic.ToolUseBlock;
      calls.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
    } else if (b.type === "server_tool_use") {
      const s = b as Anthropic.ServerToolUseBlock;
      const input = (s.input ?? {}) as { query?: unknown; url?: unknown };
      asked.set(s.id, String(input.query ?? input.url ?? ""));
    } else if (b.type.endsWith("_tool_result")) {
      searched = true;
      texts = [];
      const links = foundIn(b);
      found.push(...links);
      const line = lookupLine(b, asked.get((b as { tool_use_id?: string }).tool_use_id ?? "") ?? "", links);
      if (line) lookups.push(line);
    }
  }
  const joined = texts.join("");
  const text: ModelBlock[] = searched ? (joined.trim() ? [{ type: "text", text: joined }] : []) : texts.map((t) => ({ type: "text" as const, text: t }));
  return { content: [...text, ...calls], found, lookups };
}

/** #162: one line on a search or page, for the message's record (the console and the eval's grader read it). */
function lookupLine(block: { type: string }, asked: string, links: string[]): string | undefined {
  const content = (block as { content?: unknown }).content;
  const error = content && !Array.isArray(content) && typeof content === "object" && "error_code" in content ? String((content as { error_code: unknown }).error_code) : undefined;
  if (block.type === "web_search_tool_result") return error ? `search for "${asked}" failed (${error})` : `searched "${asked}": ${links.join(" ") || "nothing found"}`;
  if (block.type === "web_fetch_tool_result") return error ? `couldn't open ${asked} (${error})` : `opened ${links[0] ?? asked}`;
  return undefined;
}

/** The links a search result or an opened page holds; an error holds none. */
function foundIn(block: { type: string }): string[] {
  if (block.type === "web_search_tool_result") {
    const content = (block as Anthropic.WebSearchToolResultBlock).content;
    return Array.isArray(content) ? content.map((r) => r.url) : [];
  }
  if (block.type === "web_fetch_tool_result") {
    const content = (block as Anthropic.WebFetchToolResultBlock).content;
    return content.type === "web_fetch_result" ? [content.url] : [];
  }
  return [];
}
