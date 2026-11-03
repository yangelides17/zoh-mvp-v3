import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStateBlock } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { learnings, weekStart } from "../src/coach/week.js";
import { messages, nudges, plans, stepDays, takeaways, testers, type Plan, type Tester } from "../src/db/schema.js";
import { dueNudge, zonedTime, type NudgeInput, type NudgeMoment } from "../src/nudges/schedule.js";
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
    // Inside a text ZOH starts, only the recap's own text may call it (a no-op there: its slot is the record).
    const kickoff = await loadCoachState(t.db, await me(), { now: at(SUN2, "09:00"), isFirstText: false, nudgeMoment: "rest_day" });
    expect(await runTool(t.db, kickoff, "record_week_recap", {}, at(SUN2, "09:00"))).toMatchObject({ ok: false });
    expect(await runTool(t.db, await state(at(SUN2, "18:00"), "lookback"), "record_week_recap", {}, at(SUN2, "18:00"))).toMatchObject({ ok: true });
  });

  it("not when paused, on a break or stopped; owed to Monday at the unanswered cap (#110)", async () => {
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
    // #110: at the cap it's owed to Monday, only once it would go (not before 6 pm, not when stopped or paused).
    expect(dueNudge({ ...base, nudgesSinceReply: 3 })).toEqual({ action: "owe", date: SUN2 });
    expect(dueNudge({ ...base, nudgesSinceReply: 3, now: at(SUN2, "17:55") })).toMatchObject({ action: "none" });
    expect(dueNudge({ ...base, nudgesSinceReply: 3, tester: { ...base.tester, stoppedAt: at(SAT, "10:00") } })).toMatchObject({ action: "none" });
    expect(dueNudge({ ...base, nudgesSinceReply: 3, tester: { ...base.tester, autoTextsPausedAt: at(SAT, "10:00") } })).toMatchObject({ action: "none" });
    // Gentle's own cap is 1, but the recap's is the spec's 3.
    expect(dueNudge({ ...base, tester: { ...base.tester, pushiness: "gentle" } })).toMatchObject({ action: "send" });
    // On the slip ladder, its one text a day stays the only one: never owed either.
    expect(dueNudge({ ...base, missesInARow: 2 })).toMatchObject({ action: "none" });
    expect(dueNudge({ ...base, missesInARow: 2, nudgesSinceReply: 3 })).toMatchObject({ action: "none" });
    // Fewer than 3 step days: nothing to owe.
    expect(dueNudge({ ...base, closedStepDays: 2, nudgesSinceReply: 3 })).toMatchObject({ action: "none" });
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
  it("a late Sunday step: an hour after it should be done, even into quiet hours", async () => {
    // Every day at 9 pm for 30 minutes: done by 9:30, the follow-up at 9:35, the recap at 10:30 pm (#71).
    const sam = await setup({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time: "21:00", minutes: 30 });
    await done(sam, ...WEEK);
    expect(await day(SUN2, "09:00", "21:30")).toEqual(["kickoff@09:00", "checkin@20:50"]);
    await done(sam, SUN2);
    expect(await day(SUN2, "21:40", "23:55")).toEqual(["lookback@22:30"]);
  });

  it("an evening step whose follow-up is after 6 pm: the recap waits for it, outside quiet hours", async () => {
    const sam = await setup({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] });
    await done(sam, ...WEEK);
    // 7 pm, 20 minutes: done by 7:20, follow-up 7:25 pm, recap 8:20 pm, not 6 pm.
    expect(await day(SUN2, "09:00", "19:20")).toEqual(["kickoff@09:00", "checkin@18:50"]);
    await done(sam, SUN2);
    await say(sam, "inbound", at(SUN2, "19:30"), "done! 12 pages");
    await say(sam, "outbound", at(SUN2, "19:31"), "Let's go!");
    expect(await day(SUN2, "19:30", "21:55")).toEqual(["lookback@20:20"]);
  });

  it("a 7:30 pm Sunday step lasting 10 minutes, no reply: follow-up 7:45, recap text 8:40 (#71)", async () => {
    const sam = await setup({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time: "19:30", minutes: 10 });
    await done(sam, ...WEEK);
    // A morning reply, then nothing: the check-in, the follow-up and the recap are the day's texts after it.
    expect(await day(SUN2, "09:00", "09:00")).toEqual(["kickoff@09:00"]);
    await say(sam, "inbound", at(SUN2, "09:30"), "on it tonight");
    await say(sam, "outbound", at(SUN2, "09:31"), "Love it");
    expect(await day(SUN2, "09:35", "21:55")).toEqual(["checkin@19:20", "followup@19:45", "lookback@20:40"]);
  });

  it("an ordinary Sunday: quiet hours hold, even after downtime", async () => {
    const sam = await setup();
    await done(sam, ...WEEK);
    expect(await day(SUN2, "22:00", "23:55")).toEqual([]);
    expect(await t.db.select().from(nudges).orderBy(asc(nudges.createdAt))).toEqual([]);
  });
});

describe("a silent Sunday: the recap moves to Monday's morning text (#110)", () => {
  const MON2 = "2026-11-09";
  const TUE2 = "2026-11-10";
  const EVERY_DAY: Plan["days"] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  /** Every day at 6:30 pm for 5 minutes: check-in 6:20, follow-up 6:40, the recap due at 7:35 pm. */
  const runner = () => setup({ days: EVERY_DAY, time: "18:30", minutes: 5, destination: "a mile by Nov 14" });
  const lookbackRow = async () => (await t.db.select().from(nudges).where(eq(nudges.kind, "lookback")))[0];
  const stateAt = async (now: Date, nudgeMoment?: NudgeMoment) =>
    buildStateBlock(await loadCoachState(t.db, await me(), { now, isFirstText: false, ...(nudgeMoment ? { nudgeMoment } : {}) }));

  it("pushy and silent all Sunday: no fourth text; Monday's kickoff opens with last week's recap, once", async () => {
    const sam = await runner();
    await done(sam, ...WEEK);
    expect(await day(SUN2, "09:00", "23:55")).toEqual(["kickoff@09:00", "checkin@18:20", "followup@18:40"]);
    expect(await lookbackRow()).toMatchObject({ date: SUN2, status: "owed", messageId: null });
    // Still owed, not given: talking Sunday night they'd get it then.
    expect(await stateAt(at(SUN2, "21:00"))).toContain("WEEK LOOK-BACK, Mon 2026-11-02 to today: Not given yet");

    // Monday: Sunday closes as missed; the morning text (after a miss) gives the recap.
    await day(MON2, "08:55", "08:55");
    const kickoff = await stateAt(at(MON2, "09:00"), "after_miss");
    expect(kickoff).toContain("LAST WEEK'S LOOK-BACK, Mon 2026-11-02 to Sun 2026-11-08: owed: they didn't answer Sunday's texts");
    expect(kickoff).toContain("This text (not sent yet) opens with the recap (WEEK LOOK-BACK), minus its question about the week");
    expect(kickoff).toContain("Last week: 6 done in full, 0 smaller, 1 missed");
    expect(kickoff).toContain("Their destination: a mile by Nov 14");
    expect(kickoff).not.toContain("WEEK LOOK-BACK, Mon 2026-11-09");
    expect(await day(MON2, "09:00", "09:00")).toEqual(["after_miss@09:00"]);
    const [text] = await t.db.select().from(messages).where(eq(messages.content, "Yo, after_miss text"));
    expect(await lookbackRow()).toMatchObject({ status: "skipped", messageId: text!.id });

    // Given: a reply about it is the week talk; nothing more goes out for it, and Tuesday has no trace.
    expect(await stateAt(at(MON2, "10:00"))).toContain("Given today: never again; their replies about last week are the week talk");
    expect((await day(MON2, "09:05", "23:55")).filter((m) => m.startsWith("lookback"))).toEqual([]);
    expect(await stateAt(at(TUE2, "10:00"))).not.toContain("LOOK-BACK");
  });

  it("steady, or a Sunday with a reply: the recap goes Sunday evening as before, and Monday is a normal one", async () => {
    const sam = await runner();
    await updateTester(t.db, sam.id, { pushiness: "steady" });
    await done(sam, ...WEEK);
    expect(await day(SUN2, "09:00", "23:55")).toEqual(["kickoff@09:00", "followup@18:40", "lookback@19:35"]);
    expect(await stateAt(at(MON2, "09:00"), "after_miss")).not.toContain("LAST WEEK'S LOOK-BACK");
  });

  it("pushy with one Sunday morning reply: the recap goes Sunday evening", async () => {
    const sam = await runner();
    await done(sam, ...WEEK);
    expect(await day(SUN2, "09:00", "09:00")).toEqual(["kickoff@09:00"]);
    await say(sam, "inbound", at(SUN2, "09:30"), "yep, tonight");
    expect(await day(SUN2, "09:35", "23:55")).toEqual(["checkin@18:20", "followup@18:40", "lookback@19:35"]);
    expect(await lookbackRow()).toMatchObject({ status: "sent" });
  });

  it("a recap ZOH declined, or a Sunday evening the app missed: nothing on Monday", async () => {
    const sam = await runner();
    await updateTester(t.db, sam.id, { pushiness: "steady" });
    await done(sam, ...WEEK);
    t.replier.holdNudges = ["lookback"];
    await day(SUN2, "09:00", "23:55");
    expect(await lookbackRow()).toMatchObject({ status: "held" });
    await day(MON2, "08:55", "08:55");
    expect(await stateAt(at(MON2, "09:00"), "after_miss")).not.toContain("LAST WEEK'S LOOK-BACK");
  });

  it("the app down Sunday evening: no slot, nothing on Monday", async () => {
    const sam = await runner();
    await done(sam, ...WEEK);
    await day(SUN2, "09:00", "18:45");
    await day(MON2, "08:55", "08:55");
    expect(await lookbackRow()).toBeUndefined();
    expect(await stateAt(at(MON2, "09:00"), "after_miss")).not.toContain("LAST WEEK'S LOOK-BACK");
  });

  it("paused, stopped, on the slip ladder or under 3 step days: never owed", async () => {
    // Paused over Sunday.
    let sam = await runner();
    await done(sam, ...WEEK);
    await startPause(t.db, sam, { at: at(SAT, "20:00"), reason: "family visit" });
    await day(SUN2, "09:00", "23:55");
    expect(await lookbackRow()).toBeUndefined();

    // Stopped.
    await t.close();
    t = await makeApp();
    scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME], lineNumber: LINE });
    sam = await runner();
    await done(sam, ...WEEK);
    await updateTester(t.db, sam.id, { stoppedAt: at(SAT, "22:00") });
    await day(SUN2, "09:00", "23:55");
    expect(await lookbackRow()).toBeUndefined();

    // Slip ladder: Friday and Saturday missed, so Sunday's one text is the only one.
    await t.close();
    t = await makeApp();
    scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME], lineNumber: LINE });
    sam = await runner();
    await done(sam, MON, "2026-11-03", WED, THU);
    const [plan] = await t.db.select().from(plans);
    await t.db.insert(stepDays).values([FRI, SAT].map((date) => ({ testerId: sam.id, date, planId: plan!.id, status: "missed" as const })));
    await day(SUN2, "09:00", "23:55");
    expect(await lookbackRow()).toBeUndefined();

    // Under 3 step days.
    await t.close();
    t = await makeApp();
    scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME], lineNumber: LINE });
    sam = await runner();
    await done(sam, FRI, SAT);
    await day(SUN2, "09:00", "23:55");
    expect(await lookbackRow()).toBeUndefined();
  });

  it("a slip-ladder Monday (Saturday and Sunday missed): its texts and replies don't carry the recap", async () => {
    const sam = await runner();
    await done(sam, MON, "2026-11-03", WED, THU, FRI);
    const [plan] = await t.db.select().from(plans);
    await t.db.insert(stepDays).values({ testerId: sam.id, date: SAT, planId: plan!.id, status: "missed" });
    await day(SUN2, "09:00", "23:55");
    expect(await lookbackRow()).toMatchObject({ status: "owed" });
    await day(MON2, "08:55", "08:55");
    expect(await stateAt(at(MON2, "10:00"))).not.toContain("LAST WEEK'S LOOK-BACK");
    expect((await day(MON2, "09:00", "18:30")).filter((m) => !m.startsWith("one_a_day"))).toEqual([]);
    expect(await lookbackRow()).toMatchObject({ status: "owed" });
  });

  it("talking Sunday night after it was owed: the recap goes then, and Monday's kickoff is a normal one", async () => {
    const sam = await runner();
    await done(sam, ...WEEK);
    await day(SUN2, "09:00", "20:00");
    expect(await lookbackRow()).toMatchObject({ status: "owed" });
    expect(await tool("record_week_recap", {}, at(SUN2, "21:00"))).toMatchObject({ ok: true });
    expect(await lookbackRow()).toMatchObject({ status: "skipped" });
    await day(MON2, "08:55", "08:55");
    expect(await stateAt(at(MON2, "09:00"), "after_miss")).not.toContain("LAST WEEK'S LOOK-BACK");
  });

  it("they text Monday before the kickoff: the reply gives the recap; an unrecorded one keeps the kickoff from being skipped", async () => {
    const sam = await runner();
    await done(sam, ...WEEK);
    await day(SUN2, "09:00", "23:55");
    await day(MON2, "08:00", "08:00");
    await say(sam, "inbound", at(MON2, "08:30"), "morning!");
    expect(await stateAt(at(MON2, "08:31"))).toContain("Not given yet: open this reply with the recap (WEEK LOOK-BACK)");
    // The reply that hasn't recorded it: the kickoff still goes, even though they texted today.
    t.replier.skipWhenAllowed = true;
    expect(await day(MON2, "09:00", "09:00")).toEqual(["after_miss@09:00"]);
    expect(t.replier.nudges.at(-1)?.mayskip).toBeUndefined();
    expect(await lookbackRow()).toMatchObject({ status: "skipped" });
  });

  it("a Monday reply records the owed recap, and the reply is the recap", async () => {
    const sam = await runner();
    await done(sam, ...WEEK);
    await day(SUN2, "09:00", "23:55");
    await day(MON2, "08:00", "08:00");
    expect(await tool("record_week_recap", {}, at(MON2, "08:31"))).toMatchObject({ ok: true, message: expect.stringContaining("your text now gives the recap") });
    expect(await lookbackRow()).toMatchObject({ status: "skipped" });
    expect(await stateAt(at(MON2, "08:31"))).toContain("LAST WEEK'S LOOK-BACK, Mon 2026-11-02 to Sun 2026-11-08: This text (not sent yet) is the recap.");
    // The morning text that follows is a normal one, and may be skipped like any other.
    expect(await stateAt(at(MON2, "09:00"), "after_miss")).toContain("Given today");
    expect(await tool("record_week_recap", {}, at(MON2, "08:40"))).toMatchObject({ ok: false, error: "The week's recap is on Sundays." });
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
      "WEEK LOOK-BACK, Mon 2026-11-02 to today: Not given yet: once today's talk settles, or when they ask how they did (WEEK LOOK-BACK), with record_week_recap.\n" +
        // #103: the tally is the only count ZOH may give, and "each" only for what's true of every day.
        'This week: 5 done in full, 0 smaller, 0 missed, today included (each day in Recent step days and Today above). Use these numbers exactly; "every" or "each" only for what\'s true of every one of those days.\n' +
        'Understood this week (applied or recalled; only these count as understood or "can do"):\n- "Phone in the other room" (explained Mon 2026-11-02, applied Thu 2026-11-05)\n' +
        'Only explained so far (starting to click):\n- "Summarize each chapter in a line" (explained Fri 2026-11-06)\n' +
        "Their destination: finish Dune by Dec 1 (say where they stand vs. it).",
    );
    expect(await block(at(SUN2, "18:00"), "lookback")).toContain("WEEK LOOK-BACK, Mon 2026-11-02 to today: This text (not sent yet) is the recap. The app records it: no tool call.");
    // Recorded in this reply (the tool runs before the text is written): this text still gives it.
    expect(await tool("record_week_recap", {}, at(SUN2, "17:05"))).toMatchObject({ message: expect.stringContaining("your text now gives the recap") });
    expect(await block(at(SUN2, "17:05"))).toContain("WEEK LOOK-BACK, Mon 2026-11-02 to today: This text (not sent yet) is the recap.");
    // Any later reply: it's done.
    expect(await block(at(SUN2, "17:10"))).toContain("The recap is done for this week (in conversation or its own text): never again today");
  });

  it("after a Sunday step, the reflection's wrap-up turns to the week, and the next step waits for the week talk", async () => {
    const sam = await setup({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] });
    await done(sam, ...WEEK);
    await t.db.insert(messages).values({ direction: "inbound", contactNumber: ME, content: "", mediaUrl: "https://cdn.example/p.jpg", mediaContentType: "image/jpeg", createdAt: at(SUN2, "19:25"), sentAt: at(SUN2, "19:25") });
    expect(await tool("mark_step_done", { how: "full", proof: "clear", seen: "Dune open at page 120" }, at(SUN2, "19:26"))).toMatchObject({ ok: true });
    const first = await block(at(SUN2, "19:27"));
    expect(first).toContain("This reply is your 1st text since their proof today: celebrate and ask one question (how it went; or, if their proof already says, a gap that matters or deeper on something they said); the week (WEEK LOOK-BACK) waits for a later text");
    expect(first).toContain("Not given yet: not in this text (it celebrates their proof); turn to the week at the reflection's wrap-up");
    // The text that celebrates their proof can't record the recap; the next one can.
    expect(await tool("record_week_recap", {}, at(SUN2, "19:27"))).toMatchObject({ ok: false, error: expect.stringContaining("today's reflection first") });
    await say(sam, "outbound", at(SUN2, "19:28"), "Page 120! How did it feel?");
    const second = await block(at(SUN2, "19:30"));
    expect(second).toContain("Not given yet: turn to the week at the reflection's wrap-up, in place of the next step");
    // #102: the text that ends the reflection carries the recap, even when they're done or rushed.
    expect(second).toContain("then the week (WEEK LOOK-BACK) in that same text, even when they're done or rushed");
    expect(await tool("record_week_recap", {}, at(SUN2, "19:35"))).toMatchObject({ ok: true });
    // Saturday: the usual wrap-up, the next step.
    expect(await block(at(SAT, "19:27"))).not.toContain("then the week");
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
