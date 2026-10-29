import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { testerPage } from "../src/console/data.js";
import { engagement, metricsPage, retention, rollup, testerMetrics, weekStart } from "../src/console/metrics.js";
import { TOOL_RULES } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { BACK_OFF_FLAG, runTool } from "../src/coach/tools.js";
import { flags, messages, pauses, plans, stepDays, testerGoals, testers, type Plan, type Tester } from "../src/db/schema.js";
import { addDays, zonedTime } from "../src/nudges/schedule.js";
import { optOut } from "../src/testers/commands.js";
import { getTester, updateTester } from "../src/testers/testers.js";
import { DEV, ME, WESTERN, makeApp, type TestApp } from "./helpers.js";

/** Metrics (spec: GitHub issue "Metrics"): the console's beta numbers. */

const TZ = "America/New_York";
const PACIFIC = "America/Los_Angeles";
const at = (date: string, hhmm: string, zone = TZ) => zonedTime(date, hhmm, zone);
const days = (...list: string[]) => new Set(list);
const never = () => false;
const SECRET = "metrics-secret";

describe("retention", () => {
  it("keeps a run going through gaps under 3 days", () => {
    const r = retention(days("2026-10-01", "2026-10-04"), "2026-10-01", "2026-10-04", never);
    expect(r).toMatchObject({ comebacks: 0, total: 4, current: { from: "2026-10-01", to: "2026-10-04", days: 4 } });
    expect(r.runs).toHaveLength(1);
  });

  it("ends a run after 3 silent days and counts a comeback when they text again", () => {
    const r = retention(days("2026-10-01", "2026-10-02", "2026-10-06"), "2026-10-01", "2026-10-06", never);
    expect(r.runs).toEqual([
      { from: "2026-10-01", to: "2026-10-02", days: 2 },
      { from: "2026-10-06", to: "2026-10-06", days: 1 },
    ]);
    expect(r).toMatchObject({ comebacks: 1, total: 3 });
  });

  it("has no current run once they've been silent 3 full days; today doesn't count toward silence", () => {
    expect(retention(days("2026-10-01"), "2026-10-01", "2026-10-05", never).current).toBeUndefined();
    expect(retention(days("2026-10-01"), "2026-10-01", "2026-10-05", never).total).toBe(1);
    // Silent Oct 2 and 3, today is Oct 4: still going, every day counted.
    expect(retention(days("2026-10-01"), "2026-10-01", "2026-10-04", never).current).toMatchObject({ days: 4 });
  });

  it("leaves paused days out: a week's pause is no silence and no comeback", () => {
    const paused = (d: string) => d >= "2026-10-03" && d <= "2026-10-09";
    const r = retention(days("2026-10-01", "2026-10-02", "2026-10-10"), "2026-10-01", "2026-10-10", paused);
    expect(r).toMatchObject({ comebacks: 0, total: 3, current: { from: "2026-10-01", days: 3 } });
  });
});

describe("engagement", () => {
  it("counts a new touch point after 30 minutes or a new local day", () => {
    const texts = [at("2026-10-01", "09:00"), at("2026-10-01", "09:29"), at("2026-10-01", "09:58"), at("2026-10-01", "10:29"), at("2026-10-02", "08:00")];
    // 9:00 and 9:29 one touch (29 min); 9:58 is 29 min after 9:29 (same); 10:29 is 31 min later (new); next day (new).
    expect(engagement(texts, TZ, "2026-10-01", "2026-10-03", never)).toEqual({ activeDays: 2, ofDays: 3, touchPoints: 3, messages: 5 });
  });

  it("uses the tester's local day: late-night Pacific texts stay on that day", () => {
    const texts = [at("2026-10-01", "23:30", PACIFIC), at("2026-10-01", "23:50", PACIFIC)];
    expect(engagement(texts, PACIFIC, "2026-10-01", "2026-10-01", never)).toMatchObject({ activeDays: 1, ofDays: 1, touchPoints: 1 });
  });

  it("leaves paused days out of active days unless they texted", () => {
    const paused = (d: string) => d === "2026-10-02" || d === "2026-10-03";
    const texts = [at("2026-10-01", "09:00"), at("2026-10-03", "09:00")];
    expect(engagement(texts, TZ, "2026-10-01", "2026-10-04", paused)).toMatchObject({ activeDays: 2, ofDays: 3 });
  });

  it("weeks start on Monday", () => {
    expect(weekStart("2026-11-01")).toBe("2026-10-26"); // a Sunday
    expect(weekStart("2026-11-02")).toBe("2026-11-02");
  });
});

describe("rollup", () => {
  it('says "no testers yet" (zero testers) instead of 0% or NaN', () => {
    const r = rollup([]);
    expect(r.testers).toBe(0);
    expect(r.activeShare).toBeUndefined();
    expect(r.hitRate).toBeUndefined();
  });
});

describe("Metrics page", () => {
  let t: TestApp;
  /** Tue Nov 10 2026, noon Eastern. */
  let now: Date;

  beforeEach(async () => {
    now = at("2026-11-10", "12:00");
    t = await makeApp({ console: { password: "pw", sessionSecret: SECRET, names: ["Yanni"] }, now: () => now });
  });
  afterEach(async () => {
    await t.close();
  });

  const cookie = () => `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(now, "Yanni"), SECRET))}`;
  const get = (url: string, withCookie = true) => t.app.inject({ method: "GET", url, headers: withCookie ? { cookie: cookie() } : {} });

  async function tester(phone: string, name: string, extra: Partial<Tester> = {}): Promise<Tester> {
    const [row] = await t.db
      .insert(testers)
      .values({ phone, name, goalSlug: "reading", phase: "active", timeZone: TZ, timeZoneStatus: "assumed_eastern", consentAt: at("2026-11-02", "08:00"), contextStartedAt: at("2026-11-02", "08:00"), ...extra })
      .returning();
    return row!;
  }

  async function text(phone: string, when: Date, content = "hi") {
    await t.db.insert(messages).values({ direction: "inbound", contactNumber: phone, content, createdAt: when, sentAt: when });
  }

  /**
   * Sam: texts Nov 2 to 10, reading focus from Nov 3 (v1), deepened Nov 8 (v2), exercise added on top;
   * proof verdicts of every kind; a pause, a back_off flag and two stops.
   */
  async function seedSam(): Promise<Tester> {
    const sam = await tester(ME, "Sam");
    for (let d = "2026-11-02"; d <= "2026-11-10"; d = addDays(d, 1)) await text(ME, at(d, "09:00"));
    const base = { testerId: sam.id, goalSlug: "reading", status: "locked" as const, proof: "photo" as const, stepTime: "19:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as Plan["days"], reason: "Habit." };
    const [v1] = await t.db.insert(plans).values({ ...base, version: 1, step: "10 pages", startDate: "2026-11-03", lockedAt: at("2026-11-02", "12:00") }).returning();
    await t.db.insert(plans).values({ ...base, version: 2, step: "15 pages", changeKind: "deepen", startDate: "2026-11-08", lockedAt: at("2026-11-08", "12:00") });
    await t.db.insert(testerGoals).values({ testerId: sam.id, goalSlug: "reading", role: "focus", roleSince: at("2026-11-02", "12:00"), createdAt: at("2026-11-02", "12:00") });
    await t.db.insert(testerGoals).values({ testerId: sam.id, goalSlug: "exercise", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2, roleSince: at("2026-11-09", "12:00"), createdAt: at("2026-11-09", "12:00") });
    await t.db.insert(stepDays).values([
      { testerId: sam.id, date: "2026-11-03", planId: v1!.id, status: "done", proofVerdict: "clear" },
      { testerId: sam.id, date: "2026-11-04", planId: v1!.id, status: "done_reduced", proofVerdict: "plausible" },
      { testerId: sam.id, date: "2026-11-05", planId: v1!.id, status: "missed" },
      { testerId: sam.id, date: "2026-11-06", planId: v1!.id, status: "done", proofVerdict: "unclear" },
      { testerId: sam.id, date: "2026-11-09", planId: v1!.id, status: "done", proofVerdict: "clear" },
      { testerId: sam.id, date: "2026-11-10", planId: v1!.id, status: "done", proofVerdict: "doesnt_match" },
    ]);
    await t.db.insert(pauses).values({ testerId: sam.id, startedAt: at("2026-11-07", "10:00"), endedAt: at("2026-11-08", "10:00"), endedBy: "tester", reason: "trip" });
    await t.db.insert(flags).values({ testerId: sam.id, kind: BACK_OFF_FLAG, detail: "too many texts", createdAt: at("2026-11-06", "09:01") });
    return sam;
  }

  it("verified steps count only clear or plausible proof, this week from Monday", async () => {
    const sam = await seedSam();
    const m = await testerMetrics(t.db, sam, now);
    // Nov 3 clear, Nov 4 plausible, Nov 9 clear: 3 verified; Nov 9 and 10 are this week (from Mon Nov 9).
    expect(m.verified).toMatchObject({ total: 3, thisWeek: 1 });
    expect(m.verified!.perWeek).toBeCloseTo(3 / (8 / 7));
  });

  it("shows the same streak and hit rate as the tester page", async () => {
    const sam = await seedSam();
    const m = await testerMetrics(t.db, sam, now);
    const page = await testerPage(t.db, sam.id, now);
    const focus = page!.goals.find((g) => g.goal.role === "focus")!;
    expect(m.hitRate).toEqual(focus.hitRate);
    expect(m.streak).toEqual(focus.current);
    const res = await get("/console/metrics");
    expect(res.body).toContain(`${focus.hitRate.done} / ${focus.hitRate.closed}`);
  });

  it("shows progression with dates, and a goal switch isn't progress", async () => {
    const sam = await seedSam();
    const m = await testerMetrics(t.db, sam, now);
    expect(m.progression.deepened).toEqual(at("2026-11-08", "12:00"));
    expect(m.progression.upgraded).toBeUndefined();
    expect(m.progression.addedGoal).toEqual(at("2026-11-09", "12:00"));
    expect((await get("/console/metrics")).body).toContain("deepened Nov 8, added a goal Nov 9");

    // A switch drops the old goal: one live goal, nothing added.
    await t.db.update(testerGoals).set({ role: "dropped" }).where(eq(testerGoals.goalSlug, "reading"));
    expect((await testerMetrics(t.db, sam, now)).progression.addedGoal).toBeUndefined();
  });

  it("counts pauses and back_off flags as back-off, and every stop even after they come back", async () => {
    let sam = await seedSam();
    sam = await optOut(t.db, sam, at("2026-11-09", "20:00"));
    sam = await updateTester(t.db, sam.id, { stoppedAt: null });
    sam = await optOut(t.db, sam, at("2026-11-10", "08:00"));
    sam = await updateTester(t.db, sam.id, { stoppedAt: null });
    const m = await testerMetrics(t.db, sam, now);
    expect(m.backOff).toEqual({ pauses: 1, flags: 1 });
    expect(m.stops).toBe(2);
  });

  it("leaves the paused day out of retention and active days", async () => {
    const sam = await seedSam();
    // Paused Nov 7 10:00 to Nov 8 10:00: Nov 7's day end (10 pm) fell inside it.
    const m = await testerMetrics(t.db, sam, now);
    expect(m.engagement).toMatchObject({ activeDays: 9, ofDays: 9 });
    await t.db.delete(messages).where(eq(messages.createdAt, at("2026-11-07", "09:00")));
    const again = await testerMetrics(t.db, sam, now);
    expect(again.engagement).toMatchObject({ activeDays: 8, ofDays: 8 });
    expect(again.retention).toMatchObject({ comebacks: 0, total: 8 });
  });

  it("a jumped dev account's numbers run on their clock (#14)", async () => {
    let sam = await seedSam();
    // Saved on Sam's clock once jumped: a day after real now, so it only counts from there.
    await text(ME, at("2026-11-11", "09:00"));
    const real = await testerMetrics(t.db, sam, now);
    sam = await updateTester(t.db, sam.id, { clockOffsetMs: 2 * 24 * 60 * 60_000 });
    const jumped = await testerMetrics(t.db, sam, now);
    expect(jumped.engagement!.messages).toBe(real.engagement!.messages + 1);
    expect(jumped.engagement!.ofDays).toBe(real.engagement!.ofDays + 2);
  });

  it("leaves test accounts out unless the toggle is on", async () => {
    await seedSam();
    await tester(DEV, "Dev", { isTestUser: true });
    await text(DEV, at("2026-11-09", "09:00"));
    expect((await metricsPage(t.db, now, { includeTest: false })).rows.map((r) => r.tester.name)).toEqual(["Sam"]);
    expect((await metricsPage(t.db, now, { includeTest: true })).rows.map((r) => r.tester.name)).toEqual(["Sam", "Dev"]);
    const off = await get("/console/metrics");
    expect(off.body).not.toContain(">Dev<");
    expect(off.body).toContain("days they texted only");
    expect((await get("/console/metrics?test=1")).body).toContain(">Dev<");
  });

  it("shows dashes for a tester with no texts, and the averages skip them", async () => {
    await seedSam();
    await tester(WESTERN, "New");
    const { rows, rollup: u } = await metricsPage(t.db, now, { includeTest: false });
    const fresh = rows.find((r) => r.tester.name === "New")!;
    expect(fresh.start).toBeUndefined();
    expect(fresh.engagement).toBeUndefined();
    expect(u.testers).toBe(2);
    expect(u.messagesPerDay).toBe(1);
  });

  it('says "No testers yet" with nobody to count', async () => {
    const res = await get("/console/metrics");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("No testers yet.");
    expect(res.body).not.toContain("NaN");
  });

  it("shows nothing without the password", async () => {
    await seedSam();
    const res = await get("/console/metrics", false);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("Sam");
  });

  it("links Metrics from the tester list", async () => {
    expect((await get("/console")).body).toContain('href="/console/metrics"');
  });
});

describe("flag_back_off", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it("saves a back_off flag for the founders", async () => {
    const [row] = await t.db
      .insert(testers)
      .values({ phone: ME, name: "Sam", phase: "onboarding", timeZone: TZ, timeZoneStatus: "assumed_eastern", consentAt: new Date(), contextStartedAt: new Date() })
      .returning();
    const tester = (await getTester(t.db, row!.id))!;
    const now = new Date();
    const state = await loadCoachState(t.db, tester, { now, isFirstText: false, lastTesterText: "" });
    expect(await runTool(t.db, state, "flag_back_off", { reason: "too many texts" }, now)).toMatchObject({ ok: true });
    const saved = await t.db.select().from(flags).where(eq(flags.testerId, row!.id));
    expect(saved).toMatchObject([{ kind: BACK_OFF_FLAG, detail: "too many texts" }]);
  });

  it("saves on a jumped dev account's clock, like every other flag (#14)", async () => {
    const [row] = await t.db
      .insert(testers)
      .values({ phone: DEV, name: "Dev", phase: "onboarding", timeZone: TZ, timeZoneStatus: "assumed_eastern", consentAt: new Date(), contextStartedAt: new Date(), isTestUser: true, clockOffsetMs: 3 * 60 * 60_000 })
      .returning();
    const tester = (await getTester(t.db, row!.id))!;
    const ahead = new Date(Date.now() + 3 * 60 * 60_000);
    const state = await loadCoachState(t.db, tester, { now: ahead, isFirstText: false, lastTesterText: "" });
    await runTool(t.db, state, "flag_back_off", { reason: "too many texts" }, ahead);
    const [saved] = await t.db.select().from(flags).where(eq(flags.testerId, row!.id));
    expect(saved!.createdAt).toEqual(ahead);
  });

  it("is in the every-phase rules, and stopping is for good", () => {
    expect(TOOL_RULES).toContain("flag_back_off");
    expect(TOOL_RULES).toContain("stop hearing from you for good");
  });
});
