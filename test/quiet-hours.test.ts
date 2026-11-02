import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStateBlock } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { messages, plans, stepDays, testers, type Tester } from "../src/db/schema.js";
import { withDaySteps } from "../src/nudges/quiet.js";
import {
  addDays,
  CHECKIN_LEAD_MS,
  FOLLOWUP_AFTER_MS,
  QUIET_AFTER_FOLLOWUP_MS,
  quietNow,
  quietOn,
  serviceDate,
  zonedTime,
} from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { setFocusGoal } from "../src/testers/goals.js";
import { getTester, updateTester } from "../src/testers/testers.js";
import { LINE, ME, makeApp, type TestApp } from "./helpers.js";

/**
 * #48: quiet hours move to fit the step time. Expected times come from the scheduler's own settings
 * (FOLLOWUP_AFTER_MS, QUIET_AFTER_FOLLOWUP_MS, CHECKIN_LEAD_MS), so changing one (#71) moves these with it.
 */

const TZ = "America/New_York";
const SUN = "2026-11-01";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const THU = "2026-11-05";
const MIN = 60_000;
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
/** Local "HH:MM" of an instant. */
const clock = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

let t: TestApp;
let scheduler: NudgeScheduler;

beforeEach(async () => {
  t = await makeApp();
  scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME], lineNumber: LINE });
});
afterEach(async () => {
  await scheduler.stop();
  await t.close();
});

/** Sam: a locked plan from Monday, every day, at `time` for `minutes`. Default quiet hours unless given. */
async function setup(o: { time: string; minutes: number; chosen?: { start: string; end: string } }): Promise<Tester> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Sam",
      goalSlug: "bedtime",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at(SUN, "10:00"),
      contextStartedAt: at(SUN, "10:00"),
      ...(o.chosen ? { quietHoursStart: o.chosen.start, quietHoursEnd: o.chosen.end, quietHoursChosen: true } : {}),
    })
    .returning();
  await t.db.insert(plans).values({
    testerId: tester!.id,
    goalSlug: "bedtime",
    status: "locked",
    version: 1,
    step: "Phone on the charger in the kitchen, lights out",
    stepTime: o.time,
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    proof: "photo",
    reason: "Sleep before scrolling.",
    minutes: o.minutes,
    startDate: MON,
    commitment: "I'm in",
    lockedAt: at(SUN, "12:00"),
  });
  await setFocusGoal(t.db, tester!.id, "bedtime", at(SUN, "12:00"), "remove");
  await t.db.insert(messages).values({ direction: "inbound", contactNumber: ME, content: "I'm in", createdAt: at(SUN, "11:59"), sentAt: at(SUN, "11:59") });
  await t.db.insert(messages).values({ direction: "outbound", contactNumber: ME, content: "LET'S GO", createdAt: at(SUN, "12:00"), sentAt: at(SUN, "12:00") });
  return tester!;
}

const me = async () => (await getTester(t.db, (await t.db.select().from(testers))[0]!.id))!;
const row = async (date: string) => (await t.db.select().from(stepDays).where(eq(stepDays.date, date)))[0];

/** Ticks every 5 minutes from a local time for `minutes`, and returns what went out, as "moment@HH:MM". */
async function run(date: string, from: string, minutes: number): Promise<string[]> {
  const out: string[] = [];
  const start = at(date, from).getTime();
  for (let ms = start; ms <= start + minutes * MIN; ms += 5 * MIN) {
    const before = t.replier.nudges.length;
    await scheduler.tick(new Date(ms));
    for (const n of t.replier.nudges.slice(before)) out.push(`${n.moment}@${clock(ms)}`);
  }
  return out;
}

/** The first 5-minute tick at or after an instant, as local "HH:MM". */
const tick = (ms: number) => clock(Math.ceil(ms / (5 * MIN)) * 5 * MIN);

describe("a day's quiet hours (pure)", () => {
  const stored = { timeZone: TZ, quietHoursStart: "22:00", quietHoursEnd: "09:00" };

  it("a night step inside default quiet hours moves their start to just after its follow-up", () => {
    const q = quietOn(MON, { ...stored, steps: { [MON]: { time: "23:50", minutes: 20 } } });
    const followup = at(MON, "23:50").getTime() + 20 * MIN + FOLLOWUP_AFTER_MS;
    expect(q).toEqual({ start: clock(followup + QUIET_AFTER_FOLLOWUP_MS), end: "09:00" });
  });

  it("a morning step moves their end to its heads-up", () => {
    const q = quietOn(TUE, { ...stored, steps: { [TUE]: { time: "06:00", minutes: 30 } } });
    expect(q).toEqual({ start: "22:00", end: clock(at(TUE, "06:00").getTime() - CHECKIN_LEAD_MS) });
  });

  it("a step outside quiet hours, a day with no step, or hours they chose: unchanged", () => {
    expect(quietOn(MON, { ...stored, steps: { [MON]: { time: "19:00", minutes: 60 } } })).toEqual({ start: "22:00", end: "09:00" });
    expect(quietOn(TUE, { ...stored, steps: { [MON]: { time: "23:50", minutes: 20 } } })).toEqual({ start: "22:00", end: "09:00" });
    expect(quietOn(MON, { ...stored, quietHoursChosen: true, steps: { [MON]: { time: "23:50", minutes: 20 } } })).toEqual({ start: "22:00", end: "09:00" });
  });

  it("past midnight still belongs to that night, and it isn't quiet yet", () => {
    const t0 = { ...stored, steps: { [MON]: { time: "23:50", minutes: 20 } } };
    // 11:50 pm + 20 minutes: the follow-up at 12:15 am, quiet from 12:30 (#71: 20 minutes after it should be done).
    expect(serviceDate(at(TUE, "00:20"), t0)).toBe(MON);
    expect(quietNow(at(TUE, "00:20"), t0)).toBe(false);
    expect(quietOn(MON, t0).start).toBe("00:30");
    expect(quietNow(at(TUE, "03:00"), t0)).toBe(true);
    // Without the step, 12:30 am is quiet and belongs to Tuesday, as before.
    expect(serviceDate(at(TUE, "00:30"), stored)).toBe(TUE);
    expect(quietNow(at(TUE, "00:30"), stored)).toBe(true);
  });
});

describe("nudges around a step inside default quiet hours", () => {
  it("an 11:50 pm step: the heads-up and the follow-up both go, and the day ends after the follow-up, past midnight", async () => {
    await setup({ time: "23:50", minutes: 20 });
    const followup = at(MON, "23:50").getTime() + 20 * MIN + FOLLOWUP_AFTER_MS;
    const sent = await run(MON, "21:00", 5 * 60);
    expect(sent).toEqual([`checkin@${tick(at(MON, "23:50").getTime() - CHECKIN_LEAD_MS)}`, `followup@${tick(followup)}`]);
    // Nothing done: a miss once the stretched quiet hours start, not at 10 pm.
    expect(await row(MON)).toMatchObject({ status: "missed" });
  });

  it("the day isn't closed as a miss between 10 pm and the follow-up", async () => {
    await setup({ time: "23:50", minutes: 20 });
    await run(MON, "21:00", 3 * 60);
    expect((await row(MON))?.status ?? null).toBeNull();
  });

  it("a 6 am step: the 5:50 heads-up goes", async () => {
    const tester = await setup({ time: "06:00", minutes: 30 });
    await t.db.insert(stepDays).values({ testerId: tester.id, date: MON, status: "done" });
    const sent = await run(TUE, "05:00", 90);
    expect(sent).toEqual([`kickoff_checkin@${clock(at(TUE, "06:00").getTime() - CHECKIN_LEAD_MS)}`]);
  });

  it("a step outside quiet hours changes nothing", async () => {
    const tester = await setup({ time: "19:00", minutes: 60 });
    const withSteps = await withDaySteps(t.db, tester, at(MON, "12:00"));
    expect(quietOn(MON, withSteps)).toEqual({ start: "22:00", end: "09:00" });
    // The usual 10 pm start holds: nothing goes after it.
    expect(await run(MON, "22:00", 60)).toEqual([]);
  });

  it("quiet hours they chose aren't stretched: no heads-up inside them", async () => {
    await setup({ time: "23:50", minutes: 20, chosen: { start: "23:00", end: "08:00" } });
    expect(await run(MON, "22:00", 4 * 60)).toEqual([]);
  });
});

describe("temporary time changes stretch only their own days", () => {
  it("a time moved for today only", async () => {
    const tester = await setup({ time: "19:00", minutes: 30 });
    await t.db.insert(stepDays).values({ testerId: tester.id, date: WED, movedTime: "23:30" });
    const steps = await withDaySteps(t.db, await me(), at(WED, "12:00"));
    expect(quietOn(WED, steps).start).toBe(clock(at(WED, "23:30").getTime() + 30 * MIN + FOLLOWUP_AFTER_MS + QUIET_AFTER_FOLLOWUP_MS));
    expect(quietOn(THU, steps)).toEqual({ start: "22:00", end: "09:00" });
    expect(quietOn(TUE, steps)).toEqual({ start: "22:00", end: "09:00" });
    expect(await run(WED, "23:00", 30)).toEqual([`checkin@${clock(at(WED, "23:30").getTime() - CHECKIN_LEAD_MS)}`]);
  });

  it("a temporary plan with an end date", async () => {
    const tester = await setup({ time: "19:00", minutes: 30 });
    await t.db.insert(plans).values({
      testerId: tester.id,
      goalSlug: "bedtime",
      status: "locked",
      version: 2,
      step: "Lights out after the late shift",
      stepTime: "23:45",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      proof: "photo",
      reason: "Late shifts this week.",
      minutes: 15,
      startDate: MON,
      endsOn: TUE,
      lockedAt: at(MON, "12:00"),
    });
    const steps = await withDaySteps(t.db, await me(), at(TUE, "12:00"));
    expect(quietOn(TUE, steps).start).not.toBe("22:00");
    expect(quietOn(WED, steps)).toEqual({ start: "22:00", end: "09:00" });
    expect(quietOn(addDays(WED, 1), steps)).toEqual({ start: "22:00", end: "09:00" });
  });
});

describe("what the coach is told", () => {
  const state = async (now: Date, lastTesterText = "") => loadCoachState(t.db, await me(), { now, isFirstText: false, lastTesterText });
  const tool = async (name: string, input: unknown, now: Date) => runTool(t.db, await state(now), name, input, now);

  it("default hours: today's quiet hours show as moved, and after lock it's told nothing to ask", async () => {
    await setup({ time: "23:50", minutes: 20 });
    const block = buildStateBlock(await state(at(MON, "20:00")));
    expect(block).toMatch(/Quiet hours: \d\d:\d\d to 09:00 \(today's, moved to fit the step; usually 22:00 to 09:00\)/);
    expect(block).not.toContain("ask once whether to move them");
  });

  it("a plan change to a time inside default hours: mention it in a few words, no question", async () => {
    await setup({ time: "19:00", minutes: 20 });
    const result = await tool("change_plan", { time: "23:30" }, at(MON, "15:00"));
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("with no question about it") });
    expect(result).toMatchObject({ message: expect.stringContaining(`heads-up at ${clock(at(MON, "23:30").getTime() - CHECKIN_LEAD_MS)}`) });
  });

  it("hours they chose aren't moved without a yes, and the coach asks only once per step time", async () => {
    await setup({ time: "22:30", minutes: 20, chosen: { start: "22:00", end: "08:00" } });
    expect(buildStateBlock(await state(at(MON, "15:00")))).toContain("The step time 22:30 is inside the quiet hours they chose");
    // A no: kept, and not asked again for 22:30.
    expect(await tool("keep_quiet_hours", {}, at(MON, "15:05"))).toMatchObject({ ok: true });
    expect(await me()).toMatchObject({ quietHoursStart: "22:00", quietHoursEnd: "08:00", quietHoursAskedFor: "22:30" });
    expect(buildStateBlock(await state(at(MON, "15:10")))).not.toContain("inside the quiet hours they chose");
    // A new step time asks once again; a yes moves them and answers it.
    const changed = await tool("change_plan", { time: "23:00" }, at(MON, "16:00"));
    expect(changed).toMatchObject({ message: expect.stringContaining("ask once whether to move them") });
    expect(buildStateBlock(await state(at(MON, "16:01")))).toContain("The step time 23:00 is inside the quiet hours they chose");
    expect(await tool("set_quiet_hours", { start: "23:45", end: "08:00" }, at(MON, "16:05"))).toMatchObject({ ok: true });
    expect(await me()).toMatchObject({ quietHoursStart: "23:45", quietHoursChosen: true, quietHoursAskedFor: "23:00" });
    expect(buildStateBlock(await state(at(MON, "16:10")))).not.toContain("inside the quiet hours they chose");
  });

  it("quiet hours they set themselves count as chosen", async () => {
    await setup({ time: "19:00", minutes: 20 });
    await tool("set_quiet_hours", { start: "21:00", end: "08:00" }, at(MON, "15:00"));
    expect(await me()).toMatchObject({ quietHoursChosen: true });
    await updateTester(t.db, (await me()).id, { quietHoursAskedFor: null });
    expect(buildStateBlock(await state(at(MON, "15:05")))).toContain("Quiet hours: 21:00 to 08:00 (they chose these)");
  });
});
