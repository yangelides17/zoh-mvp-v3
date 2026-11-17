import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ModelTool, WebActivity } from "../claude/replier.js";
import { VideoWatchError, type VideoWatcher } from "../video/gemini.js";
import { linkKey, youtubeId, type LinkAllowance } from "./links.js";

/**
 * #162: what ZOH can look up beyond memory: Anthropic's web search and web fetch (they run on Anthropic's side, inside
 * the reply's Claude call) and `watch_video`, ours, which has Gemini watch a YouTube video. Capped per reply in code.
 */

/** Per reply (spec #162): searches, pages opened, videos watched. */
export const MAX_WEB_SEARCHES = 5;
export const MAX_PAGES = 5;
export const MAX_WATCHES = 2;
/** An opened page is cut to this many tokens, so a long one can't swamp the reply (or its cost). */
export const PAGE_MAX_TOKENS = 8_000;
/** A search that pauses (`pause_turn`) is let go on at most this many times per round, apart from the round cap. */
export const MAX_CONTINUATIONS = 2;

/** What one reply has used. */
export interface WebBudget {
  searches: number;
  fetches: number;
  watches: number;
}

export function webBudget(): WebBudget {
  return { searches: 0, fetches: 0, watches: 0 };
}

/**
 * The web tools for a call, each capped at what's left of the reply's allowance (Anthropic counts per call, and a reply
 * makes several). A spent one is left out, so the next call can't use it.
 */
export function webTools(budget: WebBudget): ModelTool[] {
  const searches = MAX_WEB_SEARCHES - budget.searches;
  const pages = MAX_PAGES - budget.fetches;
  return [
    ...(searches > 0 ? [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: searches }] : []),
    ...(pages > 0 ? [{ type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: pages, max_content_tokens: PAGE_MAX_TOKENS }] : []),
  ];
}

export const WATCH_VIDEO_TOOL: Anthropic.Tool = {
  name: "watch_video",
  description: `YouTube links only (any other page: web_fetch). Watch a video (a link they sent, or one your search or an opened page turned up) and get an account of what it actually shows and teaches, answering your question. Before you recommend, sum up or answer about any video. At most ${MAX_WATCHES} a reply.`,
  input_schema: {
    type: "object",
    properties: { url: { type: "string" }, question: { type: "string", description: "What you need from it (their question, or whether it fits their step)" } },
    required: ["url"],
  },
};

const watchInput = z.object({ url: z.string().trim().min(1).max(500), question: z.string().trim().min(1).max(300).optional() }).strict();

/**
 * Runs `watch_video`: only a YouTube link seen this turn, at most `MAX_WATCHES` a reply. A watched video is
 * recorded in `allowed`, so the link guard lets it through. Never throws: the coach gets the error back.
 */
export async function runWatchVideo(
  watcher: VideoWatcher,
  rawInput: unknown,
  ctx: { budget: WebBudget; allowed: LinkAllowance; step?: string; onActivity?: (kind: WebActivity) => void },
): Promise<{ ok: true; message: string } | { ok: false; error: string; cause?: string }> {
  const parsed = watchInput.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  const { url, question } = parsed.data;
  if (!youtubeId(url)) return { ok: false, error: "Only YouTube links can be watched." };
  const key = linkKey(url);
  if (!ctx.allowed.seen.has(key)) return { ok: false, error: "Only a link they sent or your search or a page turned up can be watched." };
  if (ctx.budget.watches >= MAX_WATCHES) return { ok: false, error: `Video limit reached for this reply (${MAX_WATCHES}): answer with what you have.` };
  ctx.budget.watches += 1;
  ctx.onActivity?.("watching");
  try {
    const watched = await watcher.watch({ youtubeUrl: url, ...(ctx.step ? { step: ctx.step } : {}), ...(question ? { question } : {}) });
    ctx.allowed.watched.add(key);
    return { ok: true, message: `Watched ${url}:\n${watched.account}` };
  } catch (err) {
    // Gemini couldn't open it (private, removed, region-locked, or down): say so, never pretend. The cause is for the
    // record, not the coach: a bad key or no credit looks the same to it as a private video.
    const cause = err instanceof VideoWatchError ? `${err.reason}: ${err.message}` : err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${url} couldn't be watched. Don't recommend or describe it as if you'd seen it; say plainly it wouldn't open if it matters.`, cause };
  }
}
