import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBlocks } from "../src/claude/replier.js";
import { createCoach, MAX_ROUNDS, SHEET_LABEL } from "../src/coach/coach.js";
import { MAX_WATCHES, PAGE_MAX_TOKENS } from "../src/coach/web.js";
import { lookupLine } from "../src/console/views/threads.js";
import { messages } from "../src/db/schema.js";
import { HOLDING_AFTER_MS, STATUS_TEXTS } from "../src/pipeline/inbound.js";
import { VideoWatchError } from "../src/video/gemini.js";
import { FakeClaudeModel, FakeWatcher, ME, inboundEvent, makeApp, makeDb, postWebhook, type TestApp } from "./helpers.js";

/** #162: web search, opened pages, YouTube watching, the link guard and status texts, through the real coach. */

let t: TestApp;
let model: FakeClaudeModel;
let watcher: FakeWatcher;

async function text(content: string) {
  const res = await postWebhook(t, inboundEvent({ content }));
  expect(res.statusCode).toBe(200);
  await t.queue.idle();
}

async function post(content: string) {
  expect((await postWebhook(t, inboundEvent({ content }))).statusCode).toBe(200);
}

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sent = () => t.sendblue.sends.map((s) => s.content ?? "");
/** The real replies, without status texts. */
const replies = () => sent().filter((s) => !Object.values(STATUS_TEXTS).includes(s));
const toolsOf = (i: number) => model.requests[i]!.tools as { name: string; max_uses?: number; max_content_tokens?: number }[];
const webToolOf = (i: number, name: string) => toolsOf(i).find((x) => x.name === name);
/** Every tool result the coach was given, in order. */
const toolResults = () =>
  model.requests
    .at(-1)!
    .messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");

beforeEach(async () => {
  const { db } = await makeDb();
  model = new FakeClaudeModel();
  watcher = new FakeWatcher();
  t = await makeApp({ replier: createCoach({ db, model, watcher }), watcher });
});
afterEach(async () => {
  await t.close();
});

describe("searching and sending what it found", () => {
  it("offers web search and web fetch, and a link from a search result reaches them", async () => {
    model.script({
      web: [{ search: "cold call openers", results: ["https://hbr.org/2024/cold-calls", "https://example.com/other"] }],
      preamble: "Let me look that up.",
      cited: ["Found a solid one: ", "https://hbr.org/2024/cold-calls", ". The bit on opening with their problem fits your Tuesday call."],
    });
    await text("any good guide on cold-call openers?");
    expect(webToolOf(0, "web_search")).toMatchObject({ max_uses: 5 });
    expect(webToolOf(0, "web_fetch")).toMatchObject({ max_uses: 5, max_content_tokens: PAGE_MAX_TOKENS });
    // The cited pieces join cleanly; the preamble before the search never goes out.
    expect(replies()).toEqual(["Found a solid one: https://hbr.org/2024/cold-calls. The bit on opening with their problem fits your Tuesday call."]);
  });

  it("reads only the text after the last search as the answer", () => {
    const { content, found } = readBlocks([
      { type: "text", text: "Looking." } as never,
      { type: "server_tool_use", id: "s1", name: "web_search", input: {} } as never,
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://a.com/x", title: "A", encrypted_content: "", page_age: null }] } as never,
      { type: "text", text: "Here's " } as never,
      { type: "text", text: "the answer." } as never,
    ]);
    expect(content).toEqual([{ type: "text", text: "Here's the answer." }]);
    expect(found).toEqual(["https://a.com/x"]);
  });

  it("never sends a link it didn't see: one nudge to fix it, then it's taken out", async () => {
    model.script("Try this guide: https://made.up/cold-calls. Want to use it today?", "Try this guide: https://made.up/cold-calls. Want to use it today?");
    await text("any good guide on cold calls?");
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("https://made.up/cold-calls");
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("watch_video");
    expect(model.requests).toHaveLength(2);
    expect(replies()).toEqual(["Try this guide. Want to use it today?"]);
  });

  it("lets through a link they sent, and their own earlier link from ZOH", async () => {
    model.script({ web: [{ fetch: "https://blog.example.com/deep-work", text: "Block your first hour before email." }], text: "Read it 📖 Their main point (https://blog.example.com/deep-work): block your first hour before email." });
    await text("thoughts on this? https://blog.example.com/deep-work");
    expect(webToolOf(0, "web_fetch")).toBeDefined();
    expect(replies()).toEqual(["Read it 📖 Their main point (https://blog.example.com/deep-work): block your first hour before email."]);
  });

  it("tells the coach a page that won't open, without crashing", async () => {
    model.script({ web: [{ fetch: "https://paywalled.example.com/a", error: "url_not_accessible" }], text: "That page wouldn't open for me. What did it say?" });
    await text("read this https://paywalled.example.com/a");
    expect(replies()).toEqual(["That page wouldn't open for me. What did it say?"]);
  });
});

describe("YouTube", () => {
  it("watches a YouTube link they sent through Gemini with its link, then may send it", async () => {
    model.script(
      { tools: [{ name: "watch_video", input: { url: "https://youtu.be/abc123", question: "is the opener any good?" } }] },
      "Watched it: the opener at 1:30 is exactly your Tuesday call https://youtu.be/abc123",
    );
    await text("is this any good? https://www.youtube.com/watch?v=abc123");
    expect(watcher.requests).toEqual([{ youtubeUrl: "https://youtu.be/abc123", question: "is the opener any good?" }]);
    expect(toolResults().at(-1)!.content).toContain(watcher.account);
    expect(replies()).toEqual(["Watched it: the opener at 1:30 is exactly your Tuesday call https://youtu.be/abc123"]);
  });

  it("watches a video a search turned up before recommending it", async () => {
    model.script(
      { web: [{ search: "cold call video", results: ["https://www.youtube.com/watch?v=vid42"] }], tools: [{ name: "watch_video", input: { url: "https://www.youtube.com/watch?v=vid42" } }] },
      "Found one, 4 min: https://youtu.be/vid42",
    );
    await text("any good video on cold calls?");
    expect(watcher.requests).toEqual([{ youtubeUrl: "https://www.youtube.com/watch?v=vid42" }]);
    expect(replies()).toEqual(["Found one, 4 min: https://youtu.be/vid42"]);
  });

  it("takes out a YouTube link it found but didn't watch", async () => {
    const unwatched = { web: [{ search: "cold call video", results: ["https://www.youtube.com/watch?v=vid42"] }], text: "Found one: https://www.youtube.com/watch?v=vid42" };
    model.script(unwatched, "Found one: https://www.youtube.com/watch?v=vid42");
    await text("any good video on cold calls?");
    expect(watcher.requests).toEqual([]);
    expect(replies()).toEqual(["Found one"]);
  });

  it("refuses a video it never saw a link to, and tells the coach one that won't play", async () => {
    watcher.fail = new VideoWatchError("failed", "private video");
    model.script({ tools: [{ name: "watch_video", input: { url: "https://youtu.be/never" } }, { name: "watch_video", input: { url: "https://youtu.be/priv8" } }] }, "That one wouldn't play for me.");
    await text("check https://youtu.be/priv8");
    const [never, priv8] = toolResults();
    expect(never).toMatchObject({ is_error: true });
    expect(priv8).toMatchObject({ is_error: true, content: expect.stringContaining("couldn't be watched") });
    expect(watcher.requests).toEqual([{ youtubeUrl: "https://youtu.be/priv8" }]);
    expect(replies()).toEqual(["That one wouldn't play for me."]);
  });

  it(`refuses the ${MAX_WATCHES + 1}rd watch in one reply`, async () => {
    const links = ["https://youtu.be/a1", "https://youtu.be/b2", "https://youtu.be/c3"];
    model.script({ tools: links.map((url) => ({ name: "watch_video", input: { url } })) }, "Two were enough.");
    await text(`which of these? ${links.join(" ")}`);
    expect(watcher.requests).toHaveLength(MAX_WATCHES);
    expect(toolResults().at(-1)).toMatchObject({ is_error: true, content: expect.stringContaining("Video limit") });
  });
});

describe("caps per reply", () => {
  it("after 5 searches the next call can't search, and pages keep their own cap", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ search: `q${i}`, results: [`https://site${i}.com/a`] }));
    model.script({ web: five, tools: [{ name: "save_name", input: { name: "Sam" } }] }, { web: [{ fetch: "https://site1.com/a" }], text: "Done." });
    await text("I'm Sam, teach me cold calls");
    expect(webToolOf(0, "web_search")).toMatchObject({ max_uses: 5 });
    expect(webToolOf(1, "web_search")).toBeUndefined();
    expect(webToolOf(1, "web_fetch")).toMatchObject({ max_uses: 5 });
    // The tool list changes only when a cap goes down: a round that didn't search keeps it as it was.
    expect(model.requests).toHaveLength(2);
  });

  it("records searches, pages and watches with the message, and the console shows them with a rough cost", async () => {
    model.script({ web: [{ search: "q", results: ["https://a.com/x"] }, { fetch: "https://a.com/x" }], tools: [{ name: "watch_video", input: { url: "https://youtu.be/abc" } }] }, "Here https://a.com/x");
    await text("teach me https://youtu.be/abc");
    const [inbound] = await t.db.select().from(messages).where(and(eq(messages.direction, "inbound")));
    expect(inbound!.timings).toMatchObject({ web_searches: 1, web_pages: 1, video_watches: 1 });
    // What it asked and found, for the record (and the eval's grader).
    expect((inbound!.timings as { lookups: string }).lookups.split("\n")).toEqual(['searched "q": https://a.com/x', "opened https://a.com/x", "watched https://youtu.be/abc"]);
    const [reply] = await t.db.select().from(messages).where(eq(messages.content, "Here https://a.com/x"));
    expect(lookupLine(reply!.timings)).toBe("🔎 1 · 📖 1 · 👀 1 · ~8¢");
    expect(lookupLine(null)).toBe("");
  });
});

describe("a search that never ran", () => {
  it("isn't sent back: a search started alongside ZOH's own tool call has no result, which Anthropic rejects", async () => {
    model.script({ web: [], unrun: true, tools: [{ name: "save_name", input: { name: "Dana" } }] }, "Got it, Dana. Here's a good one to start with.");
    await text("I'm Dana, any good video on squat form?");
    const sentBack = model.requests[1]!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const uses = sentBack.filter((b) => b.type === "server_tool_use").map((b) => (b as { id: string }).id);
    const results = new Set(sentBack.filter((b) => b.type.endsWith("_tool_result") && b.type !== "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id));
    expect(uses.every((id) => results.has(id))).toBe(true);
    expect(sentBack.some((b) => b.type === "tool_use")).toBe(true);
    expect(replies()).toEqual(["Got it, Dana. Here's a good one to start with."]);
  });
});

describe("a paused search (pause_turn)", () => {
  it("goes on where it stopped, without a round or a new sheet", async () => {
    const { db } = await makeDb();
    await t.close();
    model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db, model, sheetInMessage: true }) });
    model.script({ web: [{ search: "q1", results: ["https://a.com/1"] }], pause: true }, { web: [{ search: "q2", results: ["https://b.com/2"] }], text: "Both: https://a.com/1 and https://b.com/2" });
    await text("research this for me");
    expect(model.requests).toHaveLength(2);
    const resumed = model.requests[1]!;
    expect(resumed.messages.at(-1)!.role).toBe("assistant");
    expect(JSON.stringify(resumed.messages).split(SHEET_LABEL)).toHaveLength(2);
    // Its first part's search counts: 4 left.
    expect(webToolOf(1, "web_search")).toMatchObject({ max_uses: 4 });
    expect(replies()).toEqual(["Both: https://a.com/1 and https://b.com/2"]);
  });

  it(`is let go on at most twice, and never counts as one of the ${MAX_ROUNDS} rounds`, async () => {
    const pause = { web: [{ search: "q", results: ["https://a.com/1"] }], pause: true };
    model.script(pause, pause, pause, "Here's what I found so far.");
    await text("research this");
    // The first call and two continuations; the round then has no text, so it's asked again as the next round.
    expect(model.requests[1]!.messages.at(-1)!.role).toBe("assistant");
    expect(model.requests[2]!.messages.at(-1)!.role).toBe("assistant");
    expect(model.requests[3]!.messages.at(-1)!.role).toBe("user");
    expect(replies()).toEqual(["Here's what I found so far."]);
  });
});

describe("status texts", () => {
  it("says it's looking something up the moment a search starts, before the reply", async () => {
    model.script({ web: [{ search: "q", results: ["https://a.com/x"] }], text: "Here: https://a.com/x" });
    await text("how do I open a cold call?");
    expect(sent()).toEqual([STATUS_TEXTS.search, "Here: https://a.com/x"]);
    // Not one of ZOH's real texts in its state.
    const status = (await t.db.select().from(messages).where(eq(messages.content, STATUS_TEXTS.search)))[0];
    expect(status!.timings).toMatchObject({ holding: 1 });
    // The typing bubble comes back after it.
    const calls = t.sendblue.calls.map((c) => (c.kind === "send" ? c.content : c.kind));
    expect(calls.indexOf(STATUS_TEXTS.search)).toBeLessThan(calls.lastIndexOf("typing"));
  });

  it("sends none for a reply that looks nothing up", async () => {
    model.script("Nice, how did it go?");
    await text("did my run");
    expect(sent()).toEqual(["Nice, how did it go?"]);
  });

  it("sends at most two, one per kind", async () => {
    model.script(
      { web: [{ search: "q", results: ["https://youtu.be/v1"] }, { search: "q2", results: ["https://a.com/x"] }, { fetch: "https://a.com/x" }], tools: [{ name: "watch_video", input: { url: "https://youtu.be/v1" } }] },
      "Here: https://youtu.be/v1",
    );
    await text("find me a video on this");
    expect(sent()).toEqual([STATUS_TEXTS.search, STATUS_TEXTS.reading, "Here: https://youtu.be/v1"]);
  });

  it("a video they send gets 'watching it now' at once, and it counts toward the two", async () => {
    const { db } = await makeDb();
    await t.close();
    model = new FakeClaudeModel();
    t = await makeApp({
      replier: createCoach({ db, model, watcher }),
      watcher,
      holdingAfterMs: HOLDING_AFTER_MS,
      fetchMedia: async () => ({ bytes: new Uint8Array([0, 0, 0]), contentType: "video/quicktime" }),
    });
    model.script({ web: [{ search: "squat depth", results: ["https://a.com/x"] }, { fetch: "https://a.com/x" }], text: "Good depth on the last one." });
    const res = await postWebhook(t, inboundEvent({ content: "form check?", media_url: "https://cdn.example.com/squat.mov" }));
    expect(res.statusCode).toBe(200);
    await t.queue.idle();
    expect(sent()).toEqual([STATUS_TEXTS.watching, STATUS_TEXTS.search, "Good depth on the last one."]);
  });

  it("a redraft after they text again says nothing new, and can still send what the dropped draft found", async () => {
    model.script({ web: [{ search: "q", results: ["https://hbr.org/x"] }], tools: [{ name: "save_name", input: { name: "Sam" } }] }, { web: [{ search: "q", results: ["https://other.org/y"] }], text: "Here's the one I found: https://hbr.org/x" });
    // Draft 1's second call waits, so their "ok" lands mid-draft.
    let n = 0;
    const create = model.create.bind(model);
    let gate: ReturnType<FakeClaudeModel["pause"]> | undefined;
    model.create = async (req) => {
      if (++n === 2) gate = model.pause();
      return create(req);
    };
    await post("I'm Sam, any good article on cold calls?");
    await until(() => gate !== undefined);
    await gate!.reached;
    await post("ok");
    await t.queue.idle();
    expect(sent()).toEqual([STATUS_TEXTS.search, "Here's the one I found: https://hbr.org/x"]);
  });
});
