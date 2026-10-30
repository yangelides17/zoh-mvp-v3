import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStateBlock } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { learnings, weekStart } from "../src/coach/week.js";
import { messages, nudges, plans, stepDays, takeaways, testers, type Plan, type Tester } from "../src/db/schema.js";
import { dueNudge, zonedTime, type NudgeInput } from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { startPause } from "../src/testers/pauses.js";
import { getTester, updateTester } from "../src/testers/testers.js";
import { LINE, ME, makeApp, type TestApp } from "./helpers.js";

/** The Sunday look-back (#78): the 6 pm recap's timing and guards, "understood", and the state block. */

const TZ = "America/New_York";
const SUN = "2026-11-01";
const MON = "2026-11-02";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const SAT = "2026-11-07";
const SUN2 = "2026-11-08";
const SUN3 = "2026-11-15";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
const WEEK = [MON, "2026-11-03", WED, THU, FRI, SAT];

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

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

/** Sam: reading at 7 pm, Monday to Saturday (Sunday a rest day) unless `days` says otherwise; quiet hours 10 pm to 9 am. */
async function setup(o: { days?: Plan["days"]; time?: string; minutes?: number; destination?: string } = {}): Promise<Tester> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Sam",
      goalSlug: "reading",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at(SUN, "10:00"),
      contextStartedAt: at(SUN, "10:00"),
    })
    .returning();
  await t.db.insert(plans).values({
    testerId: tester!.id,
    goalSlug: "reading",
    status: "locked",
    version: 1,
    step: "10 pages of Dune",
    stepTime: o.time ?? "19:00",
    days: o.days ?? ["mon", "tue", "wed", "thu", "fri", "sat"],
    proof: "photo",
    reason: "Ten pages a night builds the habit.",
    minutes: o.minutes ?? 20,
    destination: o.destination ?? null,
    startDate: MON,
    lockedAt: at(SUN, "12:00"),
  });
  await say(tester!, "inbound", at(SUN, "11:59"), "I'm in");
  await say(tester!, "outbound", at(SUN, "12:00"), "LET'S GO");
  return tester!;
}

async function say(tester: Tester, direction: "inbound" | "outbound", when: Date, content: string) {
  await t.db.insert(messages).values({ direction, contactNumber: tester.phone, content, createdAt: when, sentAt: when });
}

/** Step days done, as the coach marks them. */
async function done(tester: Tester, ...dates: string[]) {
  const [plan] = await t.db.select().from(plans);
  await t.db.insert(stepDays).values(dates.map((date) => ({ testerId: tester.id, date, planId: plan!.id, status: "done" as const })));
}

/** Ticks every 5 minutes from one local time to another and returns what went out, with times. */
async function day(date: string, from: string, to: string): Promise<string[]> {
  const out: string[] = [];
  for (let ms = at(date, from).getTime(); ms <= at(date, to).getTime(); ms += 5 * 60_000) {
    const before = t.replier.nudges.length;
    await scheduler.tick(new Date(ms));
    for (const n of t.replier.nudges.slice(before)) {
      out.push(`${n.moment}@${new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms))}`);
    }
  }
  return out;
}

const me = async () => (await getTester(t.db, (await t.db.select().from(testers))[0]!.id))!;
const state = async (now: Date, nudgeMoment?: "lookback") => loadCoachState(t.db, await me(), { now, isFirstText: false, ...(nudgeMoment ? { nudgeMoment } : {}) });
const block = async (now: Date, nudgeMoment?: "lookback") => buildStateBlock(await state(now, nudgeMoment));
const tool = async (name: string, input: unknown, now: Date) => runTool(t.db, await state(now), name, input, now);

describe("the 6 pm Sunday recap", () => {
  it("goes at 6 pm on Sunday, once a week, and is recorded as the week's lookback", async () => {
    const sam = await setup();
    // The first Sunday is before day 1: nothing.
    expect(await day(SUN, "12:05", "21:55")).toEqual([]);
    await done(sam, ...WEEK);
    expect(await day(SUN2, "09:00", "21:55")).toEqual(["rest_day@09:00", "lookback@18:00"]);
    const rows = await t.db.select().from(nudges).where(eq(nudges.kind, "lookback"));
    expect(rows.map((r) => [r.date, r.moment, r.status])).toEqual([[SUN2, "lookback", "sent"]]);
    // A restarted scheduler doesn't send it again.
    expect(await day(SUN2, "18:05", "21:55")).toEqual([]);
    // Never on another day of the week.
    expect((await day(MON, "17:55", "18:30")).filter((m) => m.startsWith("lookback"))).toEqual([]);
  });

  it("not after the recap happened in conversation", async () => {
    const sam = await setup();
    await done(sam, ...WEEK);
    expect(await tool("record_week_recap", {}, at(SUN2, "16:00"))).toMatchObject({ ok: true });
    expect(await t.db.select().from(nudges)).toMatchObject([{ date: SUN2, kind: "lookback", status: "skipped" }]);
    expect(await day(SUN2, "16:05", "21:55")).toEqual([]);
    // Recording it twice changes nothing; on any other day it's refused.
    expect(await tool("record_week_recap", {}, at(SUN2, "16:10"))).toMatchObject({ ok: true });
    expect(await t.db.select().from(nudges)).toHaveLength(1);
    expect(await tool("record_week_recap", {}, at(SAT, "16:00"))).toMatchObject({ ok: false, error: "The week's recap is on Sundays." });
  });

  it("not when paused, on a break, stopped or at the unanswered cap", async () => {
    const sam = await setup();
    await done(sam, ...WEEK);
    await updateTester(t.db, sam.id, { autoTextsPausedAt: at(SAT, "22:00") });
    expect(await day(SUN2, "17:55", "18:30")).toEqual([]);
    await updateTester(t.db, sam.id, { autoTextsPausedAt: null });
    await startPause(t.db, sam, { at: at(SAT, "20:00"), reason: "family visit" });
    expect(await day(SUN2, "17:55", "18:30")).toEqual([]);

    const base: NudgeInput = {
      now: at(SUN2, "18:00"),
      tester: { timeZone: TZ, quietHoursStart: "22:00", quietHoursEnd: "09:00", phase: "active", pushiness: "pushy", stoppedAt: null, autoTextsPausedAt: null },
      plan: { stepTime: "19:00", days: ["mon", "tue", "wed", "thu", "fri", "sat"], startDate: MON, minutes: 20, lockedAt: at(SUN, "12:00") },
      claimedToday: ["kickoff"],
      nudgesSinceReply: 1,
      stallsSinceReply: 0,
      closedStepDays: 6,
    };
    expect(dueNudge(base)).toEqual({ action: "send", nudge: { kind: "lookback", moment: "lookback", date: SUN2 } });
    expect(dueNudge({ ...base, tester: { ...base.tester, stoppedAt: at(SAT, "10:00") } })).toMatchObject({ action: "none", reason: "stopped" });
    expect(dueNudge({ ...base, tester: { ...base.tester, autoTextsPausedAt: at(SAT, "10:00") } })).toMatchObject({ action: "none", reason: "paused" });
    expect(dueNudge({ ...base, nudgesSinceReply: 3 })).toMatchObject({ action: "none" });
    // Gentle's own cap is 1, but the recap's is the spec's 3.
    expect(dueNudge({ ...base, tester: { ...base.tester, pushiness: "gentle" } })).toMatchObject({ action: "send" });
    // On the slip ladder, its one text a day stays the only one.
    expect(dueNudge({ ...base, missesInARow: 2 })).toMatchObject({ action: "none" });
    expect(dueNudge({ ...base, claimedToday: ["kickoff", "lookback"] })).toMatchObject({ action: "none" });
  });

  it("waits while they're talking: the coach can turn to the week itself", async () => {
    const sam = await setup();
    await done(sam, ...WEEK);
    await say(sam, "inbound", at(SUN2, "17:55"), "what should I read after Dune?");
    await say(sam, "outbound", at(SUN2, "17:56"), "Foundation, easy pick.");
    expect(await day(SUN2, "17:55", "18:00")).toEqual([]);
    expect(await day(SUN2, "18:05", "18:10")).toEqual(["lookback@18:05"]);
  });

  it("fewer than 3 step days since they started: skipped, and the first comes the next Sunday", async () => {
    const sam = await setup();
    await done(sam, FRI, SAT);
    expect(await day(SUN2, "09:00", "21:55")).toEqual(["rest_day@09:00"]);
    await done(sam, "2026-11-09");
    expect(await day(SUN3, "17:55", "18:00")).toEqual(["lookback@18:00"]);
  });
});

describe("the recap's time on a Sunday step day", () => {
  it("a late Sunday step: 30 minutes after its follow-up, even into quiet hours", async () => {
    // Every day at 9 pm for 30 minutes: the follow-up time is 10 pm, so the recap goes at 10:30 pm.
    const sam = await setup({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time: "21:00", minutes: 30 });
    await done(sam, ...WEEK);
    expect(await day(SUN2, "09:00", "21:35")).toEqual(["kickoff@09:00", "checkin@20:50"]);
    await done(sam, SUN2);
    expect(await day(SUN2, "21:40", "23:55")).toEqual(["lookback@22:30"]);
  });

  it("an evening step whose follow-up is after 6 pm: the recap waits for it, outside quiet hours", async () => {
    const sam = await setup({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] });
    await done(sam, ...WEEK);
    // 7 pm, 20 minutes: follow-up time 7:50 pm, recap 8:20 pm, not 6 pm.
    expect(await day(SUN2, "09:00", "19:25")).toEqual(["kickoff@09:00", "checkin@18:50"]);
    await done(sam, SUN2);
    await say(sam, "inbound", at(SUN2, "19:30"), "done! 12 pages");
    await say(sam, "outbound", at(SUN2, "19:31"), "Let's go!");
    expect(await day(SUN2, "19:30", "21:55")).toEqual(["lookback@20:20"]);
  });

  it("an ordinary Sunday: quiet hours hold, even after downtime", async () => {
    const sam = await setup();
    await done(sam, ...WEEK);
    expect(await day(SUN2, "22:00", "23:55")).toEqual([]);
    expect(await t.db.select().from(nudges).orderBy(asc(nudges.createdAt))).toEqual([]);
  });
});

describe("what counts as understood", () => {
  const row = (text: string, evidence: "explained" | "applied" | "recalled", day: string) => ({ text, evidence, day });

  it("only lessons applied or recalled; explained once isn't enough", () => {
    const { understood, explained } = learnings(
      [
        row("Slow enough to talk is the right pace", "explained", MON),
        row("slow enough to talk is the right pace!", "applied", WED),
        row("Breathe out on the hill", "explained", THU),
        row("Read before the phone", "recalled", FRI),
      ],
      MON,
    );
    expect(understood).toEqual([
      { text: "Slow enough to talk is the right pace", evidence: [{ kind: "explained", day: MON }, { kind: "applied", day: WED }] },
      { text: "Read before the phone", evidence: [{ kind: "recalled", day: FRI }] },
    ]);
    expect(explained).toEqual([{ text: "Breathe out on the hill", evidence: [{ kind: "explained", day: THU }] }]);
  });

  it("this week's understood leaves out a lesson shown only before the week", () => {
    const rows = [row("Old lesson", "explained", "2026-10-26"), row("Old lesson", "recalled", "2026-10-28")];
    expect(learnings(rows, MON)).toEqual({ understood: [], explained: [] });
    // With no window (the console), it's understood.
    expect(learnings(rows).understood.map((l) => l.text)).toEqual(["Old lesson"]);
  });

  it("weeks start on Monday", () => {
    expect(weekStart(SUN2)).toBe(MON);
    expect(weekStart(MON)).toBe(MON);
    expect(weekStart(SAT)).toBe(MON);
  });
});

describe("the state block on Sunday", () => {
  it("lists the week, what's understood with evidence, what's only explained, and the destination; then says the recap is done", async () => {
    const sam = await setup({ destination: "finish Dune by Dec 1" });
    await done(sam, ...WEEK.slice(0, 5));
    await t.db.insert(takeaways).values([
      { testerId: sam.id, goalSlug: "reading", day: MON, text: "Phone in the other room", evidence: "explained", createdAt: at(MON, "20:00") },
      { testerId: sam.id, goalSlug: "reading", day: THU, text: "Phone in the other room", evidence: "applied", createdAt: at(THU, "20:00") },
      { testerId: sam.id, goalSlug: "reading", day: FRI, text: "Summarize each chapter in a line", evidence: "explained", createdAt: at(FRI, "20:00") },
    ]);
    expect(await block(at(SAT, "18:00"))).not.toContain("WEEK LOOK-BACK");
    const sunday = await block(at(SUN2, "17:00"));
    expect(sunday).toContain(
      "WEEK LOOK-BACK, Mon 2026-11-02 to today: Not given yet: turn to the week once today's talk allows, then record_week_recap.\n" +
        "This week: 5 step days done, 0 missed (each day in Recent step days and Today above).\n" +
        'Understood this week (applied or recalled; only these count as understood or "can do"):\n- "Phone in the other room" (explained Mon 2026-11-02, applied Thu 2026-11-05)\n' +
        'Only explained so far (starting to click):\n- "Summarize each chapter in a line" (explained Fri 2026-11-06)\n' +
        "Their destination: finish Dune by Dec 1 (say where they stand vs. it).",
    );
    expect(await block(at(SUN2, "18:00"), "lookback")).toContain("WEEK LOOK-BACK, Mon 2026-11-02 to today: This text is the recap.");
    await tool("record_week_recap", {}, at(SUN2, "17:05"));
    expect(await block(at(SUN2, "17:10"))).toContain("The recap is done for this week (in conversation or its own text): never again today");
  });

  it("nothing understood yet says so, and no block before 3 step days", async () => {
    const sam = await setup();
    await done(sam, FRI, SAT);
    expect(await block(at(SUN2, "17:00"))).not.toContain("WEEK LOOK-BACK");
    await done(sam, THU);
    const sunday = await block(at(SUN2, "17:00"));
    expect(sunday).toContain('only these count as understood or "can do"):\n- none yet');
    expect(sunday).not.toContain("Their destination:");
  });
});
