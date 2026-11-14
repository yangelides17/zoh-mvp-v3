import { ApiError, type GoogleGenAI } from "@google/genai";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadProof } from "../src/coach/state.js";
import { consoleMessages, messages, plans, testers } from "../src/db/schema.js";
import { runMemoryTool } from "../src/memory/coach-tools.js";
import { messageRef } from "../src/memory/store.js";
import { serviceDate } from "../src/nudges/schedule.js";
import { createGeminiWatcher, VideoWatchError, videoSeconds } from "../src/video/gemini.js";
import { FakeWatcher, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

const CLIP = "https://cdn.sendblue.test/v/squat.mov";
const videoFetcher = async () => ({ bytes: new Uint8Array([0, 0, 0, 7]), contentType: "video/quicktime" });

describe("#163: Gemini watches videos", () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  async function withPlan() {
    await postWebhook(t, inboundEvent({ content: "hi" }));
    await t.queue.idle();
    const tester = (await t.db.select().from(testers))[0]!;
    await t.db.update(testers).set({ phase: "active", goalSlug: "reading" }).where(eq(testers.id, tester.id));
    await t.db.insert(plans).values({
      testerId: tester.id, goalSlug: "reading", status: "locked", version: 1, step: "3 sets of 10 squats", stepTime: "07:00", minutes: 15,
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], proof: "photo", reason: "Habit.", startDate: "2026-01-01", lockedAt: new Date("2026-01-01T12:00:00Z"),
    });
    return tester;
  }

  it("watches a video against today's step, shows the coach the account, keeps it, and counts it as proof", async () => {
    const watcher = new FakeWatcher();
    t = await makeApp({ watcher, fetchMedia: videoFetcher });
    const tester = await withPlan();
    await postWebhook(t, inboundEvent({ content: "last set", media_url: CLIP }));
    await t.queue.idle();

    expect(watcher.requests[0]).toMatchObject({ video: new Uint8Array([0, 0, 0, 7]), contentType: "video/quicktime", caption: "last set" });
    expect(watcher.requests[0]!.step).toContain("3 sets of 10 squats (15 min)");
    expect(t.replier.received.at(-1)!.at(-1)!.text).toBe(`[Sent a video. Watched for you, what it shows:]\n${watcher.account}\nlast set`);
    const [stored] = await t.db.select().from(messages).where(eq(messages.mediaUrl, CLIP));
    expect(stored!.transcript).toBe(watcher.account);
    expect(stored!.description).toBe("Three squats in a garage");
    const now = new Date();
    expect((await loadProof(t.db, tester, serviceDate(now, tester), now)).today).toBe(1);
  });

  it("tells the coach a long video was clipped to its first 20 minutes", async () => {
    const watcher = new FakeWatcher();
    watcher.clipped = true;
    t = await makeApp({ watcher, fetchMedia: videoFetcher });
    await postWebhook(t, inboundEvent({ content: "", media_url: CLIP }));
    await t.queue.idle();
    expect(t.replier.received[0]!.at(-1)!.text).toContain("[Sent a video (over 20 minutes: the first 20 were watched).");
  });

  it("says it couldn't be watched when Gemini fails, and alerts the founders only for a key or credit problem", async () => {
    const watcher = new FakeWatcher();
    watcher.fail = new VideoWatchError("key_or_credit", "402 no credit");
    t = await makeApp({ watcher, fetchMedia: videoFetcher });
    await postWebhook(t, inboundEvent({ content: "", media_url: CLIP }));
    await t.queue.idle();
    expect(t.replier.received[0]!.at(-1)!.text).toBe("[Sent a video that couldn't be watched: a photo or voice note would work]");
    const alerts = await t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "alert"));
    expect(alerts.map((a) => a.body).join(" ")).toContain("GEMINI_API_KEY");

    watcher.fail = new VideoWatchError("failed", "500");
    await postWebhook(t, inboundEvent({ content: "", media_url: CLIP }));
    await t.queue.idle();
    expect((await t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "alert"))).length).toBe(alerts.length);
  });

  it("says it couldn't be watched when there's no Gemini key", async () => {
    t = await makeApp({ fetchMedia: videoFetcher });
    await postWebhook(t, inboundEvent({ content: "", media_url: CLIP }));
    await t.queue.idle();
    expect(t.replier.received[0]!.at(-1)!.text).toBe("[Sent a video that couldn't be watched: a photo or voice note would work]");
  });

  it("keeps the account in the next reply, and open_file re-watches it with their question", async () => {
    const watcher = new FakeWatcher();
    t = await makeApp({ watcher, fetchMedia: videoFetcher });
    await postWebhook(t, inboundEvent({ content: "", media_url: CLIP }));
    await t.queue.idle();
    await postWebhook(t, inboundEvent({ content: "were my knees ok?" }));
    await t.queue.idle();
    expect(t.replier.received[1]!.map((x) => x.text).join("\n")).toContain(`[Sent a video earlier. What it showed:]\n${watcher.account}`);

    const tester = (await t.db.select().from(testers))[0]!;
    const [video] = await t.db.select().from(messages).where(eq(messages.mediaUrl, CLIP));
    watcher.account = "Knees track over toes on all three; slight cave on the last (0:52).";
    const ctx = { at: new Date(), budget: { lookups: 0, searches: 0 }, media: t.media, watcher };
    const result = await runMemoryTool(t.db, tester, "open_file", { ref: messageRef(video!.id), question: "did the knees cave?" }, ctx);
    expect(watcher.requests.at(-1)).toMatchObject({ question: "did the knees cave?", video: new Uint8Array([0, 0, 0, 7]) });
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("slight cave on the last") });
  });
});

describe("#163: the Gemini client", () => {
  /** Just enough of the SDK for one call. */
  function client(generate: () => Promise<unknown>): GoogleGenAI {
    return { models: { generateContent: generate, get: async () => ({}) }, files: {} } as unknown as GoogleGenAI;
  }
  const req = { video: new Uint8Array([1]), contentType: "video/mp4" };

  it("returns the account and summary Gemini writes", async () => {
    const watcher = createGeminiWatcher({ apiKey: "k", model: "m", client: client(async () => ({ text: '{"account":"A squat set.","summary":"Squats"}' })) });
    expect(await watcher.watch(req)).toEqual({ account: "A squat set.", summary: "Squats", clipped: false });
  });

  it("tells a key or credit problem apart from any other failure", async () => {
    const fail = (status: number, message: string) =>
      createGeminiWatcher({ apiKey: "k", model: "m", client: client(async () => { throw new ApiError({ status, message }); }) }).watch(req);
    await expect(fail(402, "payment required")).rejects.toMatchObject({ reason: "key_or_credit" });
    await expect(fail(403, "API key not valid")).rejects.toMatchObject({ reason: "key_or_credit" });
    await expect(fail(500, "internal")).rejects.toMatchObject({ reason: "failed" });
  });

  it("reads a QuickTime or MP4 video's length from its header", () => {
    const mvhd = new Uint8Array(40);
    const view = new DataView(mvhd.buffer);
    mvhd.set([0x6d, 0x76, 0x68, 0x64], 4); // "mvhd", version 0
    view.setUint32(20, 600); // timescale
    view.setUint32(24, 600 * 1500); // 25 minutes
    expect(videoSeconds(mvhd)).toBe(1500);
    expect(videoSeconds(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
