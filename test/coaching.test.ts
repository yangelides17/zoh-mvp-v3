import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addGuidance } from "../src/coaching/coaching.js";
import { listGuidance } from "../src/coaching/guidance.js";
import { coachingHistory } from "../src/coaching/history.js";
import { buildStateBlock } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { addThreadLine } from "../src/console/requests.js";
import { consoleMessages, memoryFacts, messages, plans, testers, type Tester } from "../src/db/schema.js";
import { runMemoryTool, type LookupBudget } from "../src/memory/coach-tools.js";
import { memoryBlock } from "../src/memory/context.js";
import { runKeeperTool } from "../src/memory/keeper.js";
import { addFact, ensureCorePages, factRef } from "../src/memory/store.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { getTester, resetTester } from "../src/testers/testers.js";
import { ME, makeApp, type TestApp } from "./helpers.js";

// #158: the Coaching card: the team's lasting guidance, their own style requests, what ZOH learned, with a history.

const TZ = "America/New_York";
const SECRET = "coaching-test-secret";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);

let t: TestApp;
let now: Date;

beforeEach(async () => {
  now = at("2026-11-10", "12:00");
  t = await makeApp({ console: { password: "pw", sessionSecret: SECRET, names: ["Yanni", "Stamati"] }, now: () => now });
});
afterEach(async () => {
  await t.close();
});

const cookie = (name: string) => `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(now, name), SECRET))}`;
async function post(url: string, form: Record<string, string>, as = "Yanni") {
  // A minute between actions, as in real use, so the history has an order.
  now = new Date(now.getTime() + 60_000);
  return t.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(as) },
    payload: new URLSearchParams(form).toString(),
  });
}

/** Maya, in the given phase; active means a locked plan, every day at 7 pm. */
async function seed(phase: Tester["phase"] = "active"): Promise<Tester> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Maya",
      goalSlug: phase === "onboarding" ? null : "reading",
      phase,
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at("2026-11-01", "10:00"),
      contextStartedAt: at("2026-11-01", "10:00"),
    })
    .returning();
  if (phase === "active") {
    await t.db.insert(plans).values({
      testerId: tester!.id,
      goalSlug: "reading",
      status: "locked",
      version: 1,
      step: "10 pages",
      stepTime: "19:00",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      proof: "photo",
      reason: "Builds the habit.",
      startDate: "2026-11-02",
      lockedAt: at("2026-11-01", "12:00"),
    });
  }
  return tester!;
}

const fresh = async (tester: Tester) => (await getTester(t.db, tester.id))!;
async function sheet(tester: Tester, opts: { now?: Date; nudge?: boolean } = {}): Promise<string> {
  const state = await loadCoachState(t.db, await fresh(tester), {
    now: opts.now ?? now,
    isFirstText: false,
    ...(opts.nudge ? { nudgeMoment: "kickoff" as const } : {}),
  });
  return buildStateBlock(state);
}
const budget = (): LookupBudget => ({ lookups: 0, searches: 0 });
async function said(tester: Tester, content: string, when: Date) {
  const [m] = await t.db.insert(messages).values({ direction: "inbound", contactNumber: tester.phone, content, createdAt: when }).returning();
  return m!;
}
async function savePreference(tester: Tester, preference: string, extra: Record<string, unknown> = {}) {
  const m = await said(tester, preference, now);
  const result = await runMemoryTool(t.db, await fresh(tester), "save_preference", { preference, ...extra }, { at: now, budget: budget(), sourceMessageId: m.id });
  expect(result.ok).toBe(true);
}
const facts = async (tester: Tester, section: string) =>
  (await t.db.select().from(memoryFacts).where(and(eq(memoryFacts.testerId, tester.id), eq(memoryFacts.section, section)))).map((f) => f);

describe("team guidance on the Coaching card", () => {
  it("a line a founder adds is read on every text, in every phase, replies and scheduled texts alike; the history has their name", async () => {
    for (const phase of ["onboarding", "planning", "active"] as const) {
      await t.db.delete(testers);
      const tester = await seed(phase);
      const res = await post(`/console/testers/${tester.id}/coaching/guidance`, { text: "More curious with her: ask what she noticed" }, "Stamati");
      expect(res.statusCode).toBe(303);
      expect(await sheet(tester)).toContain("More curious with her: ask what she noticed");
      if (phase === "active") expect(await sheet(tester, { nudge: true })).toContain("More curious with her: ask what she noticed");
      expect(await coachingHistory(t.db, tester.id)).toMatchObject([{ area: "guidance", action: "add", to: "More curious with her: ask what she noticed", by: "Stamati" }]);
    }
  });

  it("the staging console can't change the coaching of a number production owns", async () => {
    await t.close();
    t = await makeApp({ appEnv: "staging", console: { password: "pw", sessionSecret: SECRET, names: ["Yanni", "Stamati"] }, now: () => now });
    const tester = await seed();
    const res = await post(`/console/testers/${tester.id}/coaching/guidance`, { text: "More curious with her" });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("on production right now");
    expect(await listGuidance(t.db, tester.id)).toEqual([]);
    expect(await coachingHistory(t.db, tester.id)).toEqual([]);
  });

  it("an edit or a removal is what the next text reads, and both are in the history", async () => {
    const tester = await seed();
    await post(`/console/testers/${tester.id}/coaching/guidance`, { text: "Push harder on weekends" });
    const [line] = await listGuidance(t.db, tester.id);
    await post(`/console/testers/${tester.id}/coaching/guidance/${line!.id}`, { text: "Push harder on Saturdays" }, "Stamati");
    expect(await sheet(tester)).toContain("Push harder on Saturdays");
    expect(await sheet(tester)).not.toContain("on weekends");
    await post(`/console/testers/${tester.id}/coaching/guidance/${line!.id}/remove`, {});
    expect(await sheet(tester)).not.toContain("Push harder");
    expect((await coachingHistory(t.db, tester.id)).map((c) => [c.action, c.from, c.to, c.by])).toEqual([
      ["remove", "Push harder on Saturdays", null, "Yanni"],
      ["edit", "Push harder on weekends", "Push harder on Saturdays", "Stamati"],
      ["add", null, "Push harder on weekends", "Yanni"],
    ]);
  });

  it("stays short: a line over 200 characters or an 11th line isn't saved, and the card says why", async () => {
    const tester = await seed();
    const long = await post(`/console/testers/${tester.id}/coaching/guidance`, { text: "x".repeat(201) });
    expect(long.statusCode).toBe(409);
    expect(long.body).toContain("200 characters");
    for (let i = 0; i < 10; i++) await addGuidance(t.db, tester, `Line ${i}`, "Yanni", now);
    const eleventh = await post(`/console/testers/${tester.id}/coaching/guidance`, { text: "One more" });
    expect(eleventh.statusCode).toBe(409);
    expect(await listGuidance(t.db, tester.id)).toHaveLength(10);
  });

  it("Make it lasting: the note becomes a line that's still read after 30 days and 10 newer notes, and the note isn't read twice", async () => {
    const tester = await seed();
    const note = await addThreadLine(t.db, { testerId: tester.id, kind: "note", author: "Yanni", body: "She does better with reasons than hype", at: now });
    expect(await sheet(tester)).toContain("FROM THE TEAM, notes:");
    await post(`/console/testers/${tester.id}/coaching/notes/${note.id}/lasting`, { text: "Reasons over hype with her" });
    expect(await listGuidance(t.db, tester.id)).toMatchObject([{ text: "Reasons over hype with her" }]);
    expect((await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, note.id)))[0]!.doneAt).not.toBeNull();
    expect(await sheet(tester)).not.toContain("She does better with reasons than hype");

    const later = new Date(now.getTime() + 31 * 86_400_000);
    for (let i = 0; i < 10; i++) await addThreadLine(t.db, { testerId: tester.id, kind: "note", author: "Yanni", body: `note ${i}`, at: new Date(later.getTime() - (10 - i) * 60_000) });
    expect(await sheet(tester, { now: later })).toContain("Reasons over hype with her");
  });

  it("Make it lasting on a note over 200 characters isn't saved until it's trimmed", async () => {
    const tester = await seed();
    const note = await addThreadLine(t.db, { testerId: tester.id, kind: "note", author: "Yanni", body: "y".repeat(300), at: now });
    const res = await post(`/console/testers/${tester.id}/coaching/notes/${note.id}/lasting`, { text: "y".repeat(300) });
    expect(res.statusCode).toBe(409);
    expect(await listGuidance(t.db, tester.id)).toEqual([]);
    expect((await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, note.id)))[0]!.doneAt).toBeNull();
  });

  it("the card shows guidance, their requests, learned preferences, notes and saved plan settings", async () => {
    const tester = await seed();
    await addGuidance(t.db, tester, "More curious with her", "Yanni", now);
    await savePreference(tester, "no emojis");
    const res = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}?tab=progress`, headers: { cookie: cookie("Yanni") } });
    expect(res.statusCode).toBe(200);
    for (const text of [">Coaching Preferences</h2>", "More curious with her", "no emojis", "texted", "Saved plan settings", "10 pages", "19:00", "photo"]) expect(res.body).toContain(text);
  });

  it("the card sits folded at the top of the Progress tab, not on Memory, and a change lands back on it", async () => {
    const tester = await seed();
    const tab = async (name: string) =>
      (await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}?tab=${name}`, headers: { cookie: cookie("Yanni") } })).body;
    const progress = await tab("progress");
    const card = progress.indexOf(`<details id="coaching"`);
    expect(card).toBeGreaterThan(-1);
    expect(progress.slice(card, progress.indexOf(">", card))).not.toContain(" open");
    expect(card).toBeLessThan(progress.indexOf("10 pages"));
    expect(await tab("memory")).not.toContain(`id="coaching"`);
    const res = await post(`/console/testers/${tester.id}/coaching/guidance`, { text: "More curious with her" });
    expect(res.headers.location).toBe(`/console/testers/${tester.id}?tab=progress#coaching`);
  });
});

describe("their style requests and learned preferences", () => {
  it("a style request they text is on the card and in the history as the tester's", async () => {
    const tester = await seed();
    await savePreference(tester, "no emojis");
    expect((await facts(tester, "stated")).map((f) => f.text)).toEqual(["no emojis"]);
    expect(await coachingHistory(t.db, tester.id)).toMatchObject([{ area: "style", action: "add", to: "no emojis", by: "tester" }]);
  });

  it("a founder removes one: the coach reads it nowhere, neither the state nor memory", async () => {
    const tester = await seed();
    await savePreference(tester, "no emojis");
    expect(await sheet(tester)).toContain("Style notes: no emojis");
    expect(await memoryBlock(t.db, await fresh(tester))).toContain("no emojis");
    const [fact] = await facts(tester, "stated");
    await post(`/console/testers/${tester.id}/coaching/facts/${fact!.id}/remove`, {}, "Stamati");
    expect(await sheet(tester)).toContain("Style notes: none");
    expect(await memoryBlock(t.db, await fresh(tester))).not.toContain("no emojis");
    expect((await coachingHistory(t.db, tester.id))[0]).toMatchObject({ area: "style", action: "remove", from: "no emojis", by: "Stamati" });
  });

  it("ZOH's own forget of a style request clears the tester's copy too", async () => {
    const tester = await seed();
    await savePreference(tester, "no emojis");
    const [fact] = await facts(tester, "stated");
    const result = await runMemoryTool(t.db, await fresh(tester), "forget", { facts: [factRef(fact!.id)] }, { at: now, budget: budget() });
    expect(result.ok).toBe(true);
    expect(await sheet(tester)).toContain("Style notes: none");
  });

  it("a deleted learned preference goes with its observations, so the next night can't learn it back from them", async () => {
    const tester = await seed();
    const { preferences } = await ensureCorePages(t.db, tester, now);
    const days = ["2026-11-05", "2026-11-06", "2026-11-07"];
    for (const day of days) {
      const m = await said(tester, "ignored the hype again", at(day, "20:00"));
      await addFact(t.db, preferences, { text: "no reply to a hype text", sourceMessageId: m.id, section: "observation", label: "hype", day }, at(day, "23:00"));
    }
    const ctx = { db: t.db, tester: await fresh(tester), date: "2026-11-08", at: at("2026-11-09", "03:00"), wroteDoc: false };
    expect((await runKeeperTool(ctx, "learn_preference", { pattern: "hype", text: "Calm beats hype with her" })).ok).toBe(true);
    expect(await memoryBlock(t.db, await fresh(tester))).toContain("Calm beats hype with her");

    const [learned] = await facts(tester, "learned");
    await post(`/console/testers/${tester.id}/coaching/facts/${learned!.id}/remove`, {});
    expect(await memoryBlock(t.db, await fresh(tester))).not.toContain("Calm beats hype");
    expect(await facts(tester, "observation")).toEqual([]);
    const nextNight = { ...ctx, date: "2026-11-09", at: at("2026-11-10", "03:00") };
    expect((await runKeeperTool(nextNight, "learn_preference", { pattern: "hype", text: "Calm beats hype with her" })).ok).toBe(false);
    expect((await coachingHistory(t.db, tester.id))[0]).toMatchObject({ area: "learned", action: "remove", by: "Yanni" });
  });
});

describe("a clash between their request and the team's guidance", () => {
  it("their request wins: the line is marked, the coach reads it as overridden, and the founders get an alert", async () => {
    const tester = await seed();
    const line = await addGuidance(t.db, tester, "Push harder on weekends", "Yanni", now);
    await savePreference(tester, "chill out pls", { overrides_guidance: [`g:${line.id.slice(0, 8)}`] });
    expect(await listGuidance(t.db, tester.id)).toMatchObject([{ overriddenBy: "chill out pls" }]);
    expect(await sheet(tester)).toContain('Push harder on weekends (overridden: they asked "chill out pls", which wins)');
    const alerts = await t.db.select().from(consoleMessages).where(and(eq(consoleMessages.testerId, tester.id), eq(consoleMessages.kind, "alert")));
    expect(alerts).toMatchObject([{ topic: "guidance_clash" }]);
    // A founder's edit settles it.
    await post(`/console/testers/${tester.id}/coaching/guidance/${line.id}`, { text: "Push harder on weekends, gently" });
    expect(await listGuidance(t.db, tester.id)).toMatchObject([{ overriddenBy: null }]);
  });
});

describe("clearing", () => {
  it("forget everything clears guidance, their requests and learned preferences; the history keeps no old wording", async () => {
    const tester = await seed();
    await addGuidance(t.db, tester, "Her dad's sick, go easy on misses", "Yanni", now);
    await savePreference(tester, "no emojis");
    const result = await runMemoryTool(t.db, await fresh(tester), "forget", { everything: true }, { at: now, budget: budget() });
    expect(result.ok).toBe(true);
    expect(await listGuidance(t.db, tester.id)).toEqual([]);
    expect(await facts(tester, "stated")).toEqual([]);
    expect((await fresh(tester)).styleNotes).toBe("");
    const history = await coachingHistory(t.db, tester.id);
    expect(history).toMatchObject([{ action: "clear" }]);
    expect(JSON.stringify(history)).not.toContain("dad");
  });

  it("a dev reset clears guidance and its history", async () => {
    const tester = await seed();
    await addGuidance(t.db, tester, "More curious with her", "Yanni", now);
    await resetTester(t.db, await fresh(tester), now);
    expect(await listGuidance(t.db, tester.id)).toEqual([]);
    expect(await coachingHistory(t.db, tester.id)).toEqual([]);
  });
});

describe("push levels are gone", () => {
  it("nothing the coach reads names a level", async () => {
    const tester = await seed();
    const { fullVoiceInstructions, FIXED_INSTRUCTIONS } = await import("../src/coach/prompt.js");
    for (const text of [fullVoiceInstructions(), FIXED_INSTRUCTIONS, await sheet(tester)]) expect(text).not.toMatch(/\b(Pushy|Steady|Gentle)\b|pushiness/);
  });
});

