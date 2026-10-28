import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoach } from "../src/coach/coach.js";
import { buildStateBlock, NUDGES } from "../src/coach/prompt.js";
import { loadCoachState, loadCurrentPlan } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { flags, messages, nudges, plans, stepDays, testers, type Plan, type Tester } from "../src/db/schema.js";
import { dueNudge, serviceDate, zonedTime, type NudgeInput } from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import { summarizeDays } from "../src/nudges/streak.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { getTester, resetTester, updateTester } from "../src/testers/testers.js";
import { DEV, FakeClaudeModel, LINE, ME, STRANGER, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

const TZ = "America/New_York";
/** A Monday; quiet hours end at 9 am, start at 10 pm. */
const SUN = "2026-11-01";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

let t: TestApp;
let scheduler: NudgeScheduler;

beforeEach(async () => {
  t = await makeApp();
  scheduler = newScheduler();
});
afterEach(async () => {
  await scheduler.stop();
  await t.close();
});

function newScheduler(): NudgeScheduler {
  return createNudgeScheduler({
    db: t.db,
    log: silent,
    sendblue: t.sendblue,
    replier: t.replier,
    allowedNumbers: [ME, DEV],
    lineNumber: LINE,
  });
}

interface Setup {
  phone?: string;
  phase?: Tester["phase"];
  quiet?: [string, string];
  pushiness?: string;
  days?: Plan["days"];
  time?: string;
  minutes?: number | null;
  startDate?: string;
  lockedAt?: Date;
  /** No plan row at all (onboarding or planning). */
  noPlan?: boolean;
}

/** A tester with a locked reading plan (every day at 7 pm, 20 minutes, from Monday), locked Sunday noon. */
async function setup(o: Setup = {}): Promise<Tester> {
  const lockedAt = o.lockedAt ?? at(SUN, "12:00");
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: o.phone ?? ME,
      name: "Sam",
      goalSlug: "reading",
      phase: o.phase ?? "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      quietHoursStart: o.quiet?.[0] ?? "22:00",
      quietHoursEnd: o.quiet?.[1] ?? "09:00",
      pushiness: o.pushiness ?? "pushy",
      consentAt: at(SUN, "10:00"),
      contextStartedAt: at(SUN, "10:00"),
    })
    .returning();
  if (!o.noPlan) {
    await t.db.insert(plans).values({
      testerId: tester!.id,
      goalSlug: "reading",
      status: "locked",
      version: 1,
      step: "10 pages of Dune",
      place: "the couch",
      stepTime: o.time ?? "19:00",
      days: o.days ?? ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      proof: "photo",
      reason: "Ten pages a night builds the habit.",
      minutes: o.minutes === undefined ? 20 : o.minutes,
      startDate: o.startDate ?? MON,
      commitment: "I'm in",
      lockedAt,
    });
  }
  await say(tester!, "inbound", new Date(lockedAt.getTime() - 60_000), "I'm in");
  await say(tester!, "outbound", lockedAt, "LET'S GO");
  return tester!;
}

/** A text in the log at a given time (the webhook stores real times; these use the fake clock). */
async function say(tester: Tester, direction: "inbound" | "outbound", when: Date, content: string) {
  await t.db.insert(messages).values({ direction, contactNumber: tester.phone, content, createdAt: when, sentAt: when });
}

/** Ticks at a local time and returns the moments of the nudges sent by that tick. */
async function tick(date: string, hhmm: string): Promise<string[]> {
  const before = t.replier.nudges.length;
  const sendsBefore = t.sendblue.sends.length;
  await scheduler.tick(at(date, hhmm));
  const asked = t.replier.nudges.slice(before).map((n) => n.moment);
  expect(t.sendblue.sends.length - sendsBefore).toBe(asked.length);
  return asked;
}

/**
 * Ticks every 5 minutes (production ticks every minute; slots here fall on 5-minute marks) from one
 * local time to another, inclusive, and returns what went out, with times.
 */
async function day(date: string, from: string, to: string, endDate = date): Promise<string[]> {
  const out: string[] = [];
  for (let ms = at(date, from).getTime(); ms <= at(endDate, to).getTime(); ms += 5 * 60_000) {
    const before = t.replier.nudges.length;
    await scheduler.tick(new Date(ms));
    for (const n of t.replier.nudges.slice(before)) {
      out.push(`${n.moment}@${new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms))}`);
    }
  }
  return out;
}

async function stepDay(tester: Tester, date: string) {
  const [row] = await t.db.select().from(stepDays).where(and(eq(stepDays.testerId, tester.id), eq(stepDays.date, date)));
  return row;
}

async function tool(name: string, input: unknown, now: Date) {
  const tester = (await getTester(t.db, (await t.db.select().from(testers).where(eq(testers.phone, ME)))[0]!.id))!;
  const state = await loadCoachState(t.db, tester, { now, isFirstText: false });
  return runTool(t.db, state, name, input, now);
}

describe("a step day", () => {
  it("Pushy: kickoff when quiet hours end, check-in 10 minutes before, follow-up after step time + minutes + 30", async () => {
    await setup();
    expect(await day(MON, "08:00", "21:59")).toEqual(["kickoff@09:00", "checkin@18:50", "followup@19:50"]);
    const rows = await t.db.select().from(nudges).orderBy(asc(nudges.createdAt));
    expect(rows.map((r) => [r.date, r.kind, r.status])).toEqual([
      [MON, "kickoff", "sent"],
      [MON, "checkin", "sent"],
      [MON, "followup", "sent"],
    ]);
    const out = await t.db.select().from(messages).where(eq(messages.content, "Yo, kickoff text"));
    expect(out[0]).toMatchObject({ direction: "outbound", inReplyTo: null, lineNumber: LINE, contactNumber: ME });
    expect(rows[0]!.messageId).toBe(out[0]!.id);
    expect(t.sendblue.sends.map((s) => s.number)).toEqual([ME, ME, ME]);
  });

  it("hands the coach its last text for the same moment, so the next one reads differently", async () => {
    const sam = await setup();
    await tick(MON, "09:00");
    expect(t.replier.nudges[0]!.previous).toBeUndefined();
    await t.db.insert(stepDays).values({ testerId: sam.id, date: MON, status: "done" });
    await tick(TUE, "09:00");
    const tuesday = t.replier.nudges.at(-1)!;
    expect(tuesday.moment).toBe("kickoff");
    expect(tuesday.previous).toBe("Yo, kickoff text");
  });

  it("uses 60 minutes when the plan doesn't say how long the step takes", async () => {
    await setup({ minutes: null });
    expect(await day(MON, "19:00", "21:00")).toEqual(["followup@20:30"]);
  });

  it("merges kickoff and check-in when the step is within an hour of quiet hours ending", async () => {
    await setup({ time: "09:45" });
    expect(await day(MON, "08:00", "21:59")).toEqual(["kickoff_checkin@09:00", "followup@10:35"]);
  });

  it("gives the coach the conversation and the moment", async () => {
    await setup();
    await tick(MON, "09:00");
    const asked = t.replier.nudges[0]!;
    expect(asked.moment).toBe("kickoff");
    expect(asked.tester.phone).toBe(ME);
    expect(asked.turns.map((x) => x.text)).toEqual(["I'm in", "LET'S GO"]);
  });
});

describe("rule 1: never in quiet hours, never after stop", () => {
  it("respects custom quiet hours", async () => {
    // The follow-up (9:20 pm) falls inside their quiet hours, so it never goes.
    await setup({ quiet: ["21:00", "10:30"], time: "20:30" });
    expect(await day(MON, "08:00", "23:59")).toEqual(["kickoff@10:30", "checkin@20:20"]);
  });

  it("respects quiet hours that start after midnight: the evening's slots still belong to that day", async () => {
    await setup({ quiet: ["01:00", "11:00"], time: "23:30", minutes: 30 });
    expect(await day(MON, "10:00", "02:00", TUE)).toEqual(["kickoff@11:00", "checkin@23:20", "followup@00:30"]);
    const rows = await t.db.select().from(nudges);
    expect(rows.every((r) => r.date === MON)).toBe(true);
    // Monday ends at 1 am Tuesday: that's when its miss is recorded.
    expect(await stepDay((await t.db.select().from(testers))[0]!, MON)).toMatchObject({ status: "missed" });
  });

  it("sends nothing in quiet hours that cross midnight, and nothing to a stopped tester", async () => {
    const tester = await setup();
    expect(await day(MON, "00:00", "08:59")).toEqual([]);
    await updateTester(t.db, tester.id, { stoppedAt: at(MON, "08:00") });
    expect(await day(MON, "09:00", "21:59")).toEqual([]);
  });

  it("only texts numbers on ALLOWED_NUMBERS", async () => {
    await setup({ phone: STRANGER });
    expect(await day(MON, "09:00", "09:05")).toEqual([]);
  });

  it("waits while a reply to their text is being written", async () => {
    const tester = await setup();
    await say(tester, "inbound", at(MON, "08:59"), "morning!");
    expect(await tick(MON, "09:00")).toEqual([]);
    expect(await tick(MON, "09:01")).toEqual(["kickoff"]);
  });
});

describe("rule 3: once today is done, nothing more", () => {
  it("full or reduced", async () => {
    await setup();
    expect(await tick(MON, "09:00")).toEqual(["kickoff"]);
    expect(await tool("mark_step_done", { how: "reduced", note: "5 pages" }, at(MON, "12:00"))).toMatchObject({ ok: true });
    expect(await day(MON, "12:05", "23:59")).toEqual([]);
    const tester = (await t.db.select().from(testers))[0]!;
    expect(await stepDay(tester, MON)).toMatchObject({ status: "done_reduced", note: "5 pages" });
  });
});

describe("rule 2: step days and rest days", () => {
  it("check-ins and follow-ups only on step days; rest days get the light kickoff and are never misses", async () => {
    const tester = await setup({ days: ["mon", "wed", "fri"] });
    expect(await day(TUE, "08:00", "23:59")).toEqual(["rest_day@09:00"]);
    expect(await stepDay(tester, TUE)).toBeUndefined();
    // Monday (day 1, never ticked) was closed as a miss; the rest day in between doesn't break the ladder.
    expect(await stepDay(tester, MON)).toMatchObject({ status: "missed" });
    expect(await day(WED, "08:00", "21:59")).toEqual(["after_miss@09:00", "checkin@18:50", "followup@19:50"]);
  });
});

describe("rule 4: never more than 3 unanswered texts in a row", () => {
  it("Pushy: chatting with ZOH doesn't count toward the 3; only texts ZOH started do", async () => {
    const tester = await setup();
    await say(tester, "inbound", at(MON, "08:00"), "up early");
    await say(tester, "outbound", at(MON, "08:00"), "Love it");
    expect(await day(MON, "08:30", "21:59")).toEqual(["kickoff@09:00", "checkin@18:50", "followup@19:50"]);
  });

  it("three unanswered nudges stop the day; their text resets the count", async () => {
    const tester = await setup({ days: ["mon"] });
    for (const kind of ["a", "b", "c"]) {
      await t.db.insert(nudges).values({ testerId: tester.id, date: MON, kind, moment: "kickoff", status: "sent", createdAt: at(MON, "09:00") });
    }
    expect(await day(MON, "09:00", "21:59")).toEqual([]);
    await say(tester, "inbound", at(MON, "19:30"), "reading now");
    await say(tester, "outbound", at(MON, "19:30"), "Let's go");
    expect(await day(MON, "19:35", "21:59")).toEqual(["followup@19:50"]);
  });

  it("Steady: kickoff and follow-up", async () => {
    await setup({ pushiness: "steady" });
    expect(await day(MON, "08:00", "21:59")).toEqual(["kickoff@09:00", "followup@19:50"]);
  });

  it("Steady: an early chat still leaves kickoff and follow-up", async () => {
    const tester = await setup({ pushiness: "steady" });
    await say(tester, "inbound", at(MON, "08:00"), "up early");
    await say(tester, "outbound", at(MON, "08:00"), "Love it");
    expect(await day(MON, "08:30", "21:59")).toEqual(["kickoff@09:00", "followup@19:50"]);
  });

  it("Gentle: kickoff only", async () => {
    await setup({ pushiness: "gentle" });
    expect(await day(MON, "08:00", "21:59")).toEqual(["kickoff@09:00"]);
  });
});

describe("rule 5: a miss is nothing done on a step day by the start of quiet hours", () => {
  it("records the miss at quiet-hours start, and closes yesterday after a restart", async () => {
    const tester = await setup({ days: ["mon", "tue", "thu"] });
    await scheduler.tick(at(MON, "21:59"));
    expect(await stepDay(tester, MON)).toBeUndefined();
    await scheduler.tick(at(MON, "22:00"));
    expect(await stepDay(tester, MON)).toMatchObject({ status: "missed" });

    // Down all Tuesday evening: Wednesday's first tick closes Tuesday.
    await scheduler.tick(at(WED, "09:00"));
    expect(await stepDay(tester, TUE)).toMatchObject({ status: "missed" });
    expect(await stepDay(tester, WED)).toBeUndefined();
  });

  it("a done day is not a miss", async () => {
    const tester = await setup();
    await tool("mark_step_done", { how: "full" }, at(MON, "19:30"));
    await scheduler.tick(at(MON, "22:30"));
    expect(await stepDay(tester, MON)).toMatchObject({ status: "done" });
  });
});

describe("rule 8: the latest locked plan", () => {
  it("uses the newest version, and skips a temporary one once its end date has passed", async () => {
    const tester = await setup();
    const base = (await t.db.select().from(plans))[0]!;
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = base;
    await t.db.insert(plans).values({ ...copy, version: 2, stepTime: "12:00", lockedAt: at(SUN, "13:00") });
    await t.db.insert(plans).values({ ...copy, version: 3, stepTime: "15:00", endsOn: SUN, lockedAt: at(SUN, "14:00") });
    expect((await loadCurrentPlan(t.db, tester, MON))?.version).toBe(2);
    expect((await loadCurrentPlan(t.db, tester, SUN))?.version).toBe(3);
    expect(await day(MON, "11:00", "11:55")).toEqual(["kickoff@11:00", "checkin@11:50"]);
    const state = await loadCoachState(t.db, tester, { now: at(MON, "11:00"), isFirstText: false });
    expect(state.plan?.version).toBe(2);
  });
});

describe("before the plan is locked", () => {
  it.each(["onboarding", "planning"] as const)("%s: 3 hours after ZOH's last unanswered text, then daily, then pause and flag", async (phase) => {
    const tester = await setup({ phase, noPlan: true });
    await say(tester, "inbound", at(MON, "12:00"), "hmm let me think");
    await say(tester, "outbound", at(MON, "12:00"), "Which book are you starting with?");
    expect(await day(MON, "12:05", "21:59")).toEqual(["stall@15:00"]);
    expect(await day(TUE, "08:00", "21:59")).toEqual(["stall@09:00"]);
    expect(await day(WED, "08:00", "21:59")).toEqual(["stall@09:00"]);
    expect(await tick(THU, "09:00")).toEqual([]);
    const paused = (await getTester(t.db, tester.id))!;
    expect(paused.autoTextsPausedAt).toEqual(at(THU, "09:00"));
    const flagged = await t.db.select().from(flags).where(eq(flags.testerId, tester.id));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ kind: "went_quiet" });
    expect(await day(FRI, "09:00", "09:10")).toEqual([]);

    // Texting again lifts the pause.
    await postWebhook(t, inboundEvent({ content: "sorry, crazy week" }));
    await t.queue.idle();
    expect((await getTester(t.db, tester.id))!.autoTextsPausedAt).toBeNull();
  });

  it("leaves a tester alone while their own text is the latest", async () => {
    const tester = await setup({ phase: "planning", noPlan: true });
    await say(tester, "outbound", at(MON, "11:00"), "Which book?");
    await say(tester, "inbound", at(MON, "12:00"), "Dune");
    expect(await day(MON, "15:00", "15:05")).toEqual([]);
  });

  it("a 3-hour mark inside quiet hours goes out when they end", async () => {
    const tester = await setup({ phase: "onboarding", noPlan: true });
    await say(tester, "inbound", at(MON, "20:00"), "ok");
    await say(tester, "outbound", at(MON, "20:00"), "What time works for you?");
    expect(await day(MON, "20:05", "08:55", TUE)).toEqual([]);
    expect(await tick(TUE, "09:00")).toEqual(["stall"]);
  });
});

describe("day 1", () => {
  it("locked today before step time: no kickoff, but today's check-in and follow-up", async () => {
    await setup({ startDate: MON, lockedAt: at(MON, "11:00") });
    expect(await day(MON, "11:00", "21:59")).toEqual(["checkin@18:50", "followup@19:50"]);
  });

  it("locked for tomorrow: nothing today, and no miss, until tomorrow's kickoff", async () => {
    const tester = await setup({ startDate: TUE, lockedAt: at(MON, "11:00") });
    expect(await day(MON, "11:00", "22:05")).toEqual([]);
    expect(await stepDay(tester, MON)).toBeUndefined();
    expect(await tick(TUE, "09:00")).toEqual(["kickoff"]);
  });

  it("a one-off time for day 1 moves the check-in and follow-up, and skips slots from before the lock", async () => {
    await setup({ time: "07:30", startDate: MON, lockedAt: at(MON, "11:00") });
    expect(await tool("move_today", { time: "20:00" }, at(MON, "11:00"))).toMatchObject({ ok: true });
    expect(await day(MON, "11:00", "21:59")).toEqual(["checkin@19:50", "followup@20:50"]);
  });

  it("day 1 today on one of their off days works once it has a time", async () => {
    const tester = await setup({ days: ["wed", "fri", "sun"], startDate: MON, lockedAt: at(MON, "11:00") });
    expect(await tool("move_today", { time: "20:00" }, at(MON, "11:00"))).toMatchObject({ ok: true });
    expect(await day(MON, "11:00", "22:00")).toEqual(["checkin@19:50", "followup@20:50"]);
    expect(await stepDay(tester, MON)).toMatchObject({ status: "missed", movedTime: "20:00" });
  });
});

describe("moving today and saying they're on it", () => {
  it("move_today moves the check-in and follow-up", async () => {
    await setup();
    expect(await tick(MON, "09:00")).toEqual(["kickoff"]);
    await tool("move_today", { time: "21:00" }, at(MON, "12:00"));
    expect(await day(MON, "12:05", "21:59")).toEqual(["checkin@20:50", "followup@21:50"]);
  });

  it("move_today is refused on a rest day", async () => {
    await setup({ days: ["wed", "fri", "sun"] });
    expect(await tool("move_today", { time: "20:00" }, at(TUE, "12:00"))).toMatchObject({ ok: false });
  });

  it("mark_on_it skips the check-in but not the follow-up", async () => {
    const tester = await setup();
    await say(tester, "inbound", at(MON, "18:30"), "heading to the couch now");
    await tool("mark_on_it", {}, at(MON, "18:30"));
    await say(tester, "outbound", at(MON, "18:30"), "Let's go!");
    expect(await day(MON, "18:35", "21:59")).toEqual(["followup@19:50"]);
  });

  it("an unrelated text 5 minutes before skips nothing", async () => {
    const tester = await setup();
    await say(tester, "inbound", at(MON, "18:45"), "what's a good snack lol");
    await say(tester, "outbound", at(MON, "18:45"), "Ha, no idea. Ten pages at 7?");
    expect(await day(MON, "18:50", "21:59")).toEqual(["checkin@18:50", "followup@19:50"]);
  });
});

describe("restarts and failures", () => {
  it("two ticks for the same slot send once, and a restarted scheduler doesn't send it again", async () => {
    await setup();
    await Promise.all([scheduler.tick(at(MON, "09:00")), scheduler.tick(at(MON, "09:00"))]);
    const other = newScheduler();
    await other.tick(at(MON, "09:01"));
    expect(t.replier.nudges).toHaveLength(1);
    expect(t.sendblue.sends).toHaveLength(1);
  });

  it("a slot missed by downtime goes out inside its window, and is skipped after it", async () => {
    await setup();
    expect(await tick(MON, "11:59")).toEqual(["kickoff"]);
    expect(await tick(MON, "18:55")).toEqual(["checkin"]);
    expect(await tick(MON, "21:59")).toEqual(["followup"]);
  });

  it("a slot whose window passed during downtime is skipped", async () => {
    await setup();
    expect(await tick(MON, "12:00")).toEqual([]);
    expect(await tick(MON, "19:00")).toEqual([]);
    expect(await tick(MON, "19:50")).toEqual(["followup"]);
  });

  it("if writing the nudge fails, the slot is freed and the next tick tries again; never the system-down text", async () => {
    await setup();
    t.replier.nudgeFailures.push(new Error("Claude down"));
    await scheduler.tick(at(MON, "09:00"));
    expect(t.sendblue.sends).toHaveLength(0);
    expect(await t.db.select().from(nudges)).toHaveLength(0);
    expect(await tick(MON, "09:01")).toEqual(["kickoff"]);
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["Yo, kickoff text"]);
  });

  it("a failed send is recorded and not retried", async () => {
    await setup();
    t.sendblue.failSend = true;
    await scheduler.tick(at(MON, "09:00"));
    t.sendblue.failSend = false;
    await scheduler.tick(at(MON, "09:01"));
    expect(t.sendblue.sends).toHaveLength(1);
    const [row] = await t.db.select().from(nudges);
    expect(row).toMatchObject({ kind: "kickoff", status: "failed" });
    const [out] = await t.db.select().from(messages).where(eq(messages.status, "SEND_FAILED"));
    expect(out!.id).toBe(row!.messageId);
  });
});

describe("reset", () => {
  it("clears step days, nudges and the pause", async () => {
    const tester = await setup();
    await tick(MON, "09:00");
    await tool("mark_step_done", { how: "full" }, at(MON, "12:00"));
    await updateTester(t.db, tester.id, { autoTextsPausedAt: at(MON, "12:00") });
    const fresh = await resetTester(t.db, (await getTester(t.db, tester.id))!, at(MON, "13:00"));
    expect(fresh.autoTextsPausedAt).toBeNull();
    expect(await t.db.select().from(stepDays)).toHaveLength(0);
    expect(await t.db.select().from(nudges)).toHaveLength(0);
  });
});

describe("dueNudge", () => {
  const base: NudgeInput = {
    now: at(MON, "09:00"),
    tester: {
      timeZone: TZ,
      quietHoursStart: "22:00",
      quietHoursEnd: "09:00",
      phase: "active",
      pushiness: "pushy",
      stoppedAt: null,
      autoTextsPausedAt: null,
    },
    plan: { stepTime: "19:00", days: ["mon"], startDate: MON, minutes: 20, lockedAt: at(SUN, "12:00") },
    claimedToday: [],
    nudgesSinceReply: 0,
    stallsSinceReply: 0,
  };

  it("says why nothing is due", () => {
    expect(dueNudge(base)).toEqual({ action: "send", nudge: { kind: "kickoff", moment: "kickoff", date: MON } });
    expect(dueNudge({ ...base, now: at(MON, "08:59") })).toMatchObject({ reason: "quiet hours" });
    expect(dueNudge({ ...base, tester: { ...base.tester, autoTextsPausedAt: at(SUN, "09:00") } })).toMatchObject({ reason: "paused" });
    expect(dueNudge({ ...base, today: { status: "done", movedTime: null, onItAt: null } })).toMatchObject({ reason: "today is done" });
    expect(dueNudge({ ...base, nudgesSinceReply: 3 })).toMatchObject({ reason: "unanswered cap" });
    expect(dueNudge({ ...base, claimedToday: ["kickoff"] })).toMatchObject({ reason: "no slot open" });
  });

  it("puts the small hours in yesterday when quiet hours start after midnight", () => {
    expect(serviceDate(at(TUE, "00:30"), { timeZone: TZ, quietHoursStart: "01:00" })).toBe(MON);
    expect(serviceDate(at(TUE, "00:30"), { timeZone: TZ, quietHoursStart: "22:00" })).toBe(TUE);
  });
});

describe("the coach writing a nudge", () => {
  it("one call, no tools, the moment in the state block and a note in place of a tester text", async () => {
    const tester = await setup();
    const model = new FakeClaudeModel();
    model.script("Kalimera Sam! Ten pages of Dune on the couch at 7 tonight. Still on?");
    const coach = createCoach({ db: t.db, model });
    const text = await coach.nudge!({
      tester,
      turns: [
        { role: "user", text: "I'm in" },
        { role: "assistant", text: "LET'S GO" },
      ],
      now: at(MON, "09:00"),
      moment: "kickoff",
    });
    expect(text).toBe("Kalimera Sam! Ten pages of Dune on the couch at 7 tonight. Still on?");
    expect(model.requests).toHaveLength(1);
    const req = model.requests[0]!;
    expect(req.toolChoice).toBe("none");
    expect(req.tools.map((x) => x.name)).toContain("mark_step_done");
    expect(req.system[0]!.text).toContain(NUDGES);
    expect(model.stateOf()).toContain("NUDGE MOMENT: kickoff");
    expect(model.stateOf()).toContain("Today: Mon 2026-11-02, a step day at 19:00. Today's step: not marked done yet.");
    expect(model.stateOf()).toContain("Next step day: Tue 2026-11-03.");
    expect(model.stateOf()).toContain('Their words when they committed: "I\'m in"');
    const last = req.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("[No new text from them. It's Mon 9:00 AM. Write the kickoff text now.]");
  });

  it("an empty answer is an error, so the slot is retried", async () => {
    const tester = await setup();
    const model = new FakeClaudeModel();
    model.script("");
    const coach = createCoach({ db: t.db, model });
    await expect(coach.nudge!({ tester, turns: [], now: at(MON, "09:00"), moment: "kickoff" })).rejects.toThrow(/no nudge text/);
  });
});

describe("the state block for an active tester", () => {
  it("shows today's moved time, status and on-it, and day 1 when it hasn't started", async () => {
    const tester = await setup({ days: ["mon", "wed", "fri"] });
    await tool("move_today", { time: "20:15" }, at(MON, "12:00"));
    await tool("mark_on_it", {}, at(MON, "20:10"));
    const state = await loadCoachState(t.db, tester, { now: at(MON, "20:12"), isFirstText: false });
    const block = buildStateBlock(state);
    expect(block).toContain("Today: Mon 2026-11-02, a step day at 20:15 (moved for today only; usually 19:00). Today's step: not marked done yet. They said they're on it (Mon 8:10 PM).");
    expect(block).toContain("Next step day: Wed 2026-11-04.");
    await tool("mark_step_done", { how: "full", note: "10 pages" }, at(MON, "20:40"));
    expect(buildStateBlock(await loadCoachState(t.db, tester, { now: at(MON, "20:41"), isFirstText: false }))).toContain("Today's step: done.");
    expect(buildStateBlock(await loadCoachState(t.db, tester, { now: at(TUE, "10:00"), isFirstText: false }))).toContain(
      "Today: Tue 2026-11-03, a rest day (no step).",
    );
    await t.db.update(plans).set({ startDate: WED });
    expect(buildStateBlock(await loadCoachState(t.db, tester, { now: at(TUE, "10:00"), isFirstText: false }))).toContain(
      "Day 1 is Wed 2026-11-04: nothing to do yet.",
    );
  });

  it("saves how long the step takes with the plan", async () => {
    const tester = await setup();
    await updateTester(t.db, tester.id, { phase: "active" });
    expect(await tool("change_plan", { minutes: 30 }, at(MON, "12:00"))).toMatchObject({ ok: true });
    const latest = await loadCurrentPlan(t.db, tester, MON);
    expect(latest).toMatchObject({ version: 2, minutes: 30 });
    expect(await tool("change_plan", { minutes: 900 }, at(MON, "12:00"))).toMatchObject({ ok: false });
  });
});

describe("the slip ladder", () => {
  it("miss → harder kickoff → one text a day → day-3 check-in → pause and flag; texting again lifts it", async () => {
    const tester = await setup();
    // Monday: kickoff, check-in, follow-up, no reply: a miss at 10 pm.
    expect(await day(MON, "09:00", "22:05")).toEqual(["kickoff@09:00", "checkin@18:50", "followup@19:50"]);
    expect(await stepDay(tester, MON)).toMatchObject({ status: "missed" });
    // The day after a miss: the kickoff pushes harder; the rest of the day as usual.
    expect(await day(TUE, "09:00", "22:05")).toEqual(["after_miss@09:00", "checkin@18:50", "followup@19:50"]);
    // Two misses in a row: one text a day at their usual time.
    expect(await day(WED, "09:00", "22:05")).toEqual(["one_a_day@18:50"]);
    // Three: that text is the honest day-3 check-in.
    expect(await day(THU, "09:00", "22:05")).toEqual(["day_three@18:50"]);
    // No reply by the next step day's slot: no text; ZOH pauses and flags it.
    expect(await day(FRI, "09:00", "18:45")).toEqual([]);
    expect((await getTester(t.db, tester.id))!.autoTextsPausedAt).toBeNull();
    expect(await day(FRI, "18:50", "22:05")).toEqual([]);
    expect((await getTester(t.db, tester.id))!.autoTextsPausedAt).not.toBeNull();
    expect(await t.db.select().from(flags).where(eq(flags.kind, "went_quiet"))).toHaveLength(1);
    // Texting again lifts the pause.
    const res = await postWebhook(t, inboundEvent({ content: "sorry, rough week" }));
    expect(res.statusCode).toBe(200);
    await t.queue.idle();
    expect((await getTester(t.db, tester.id))!.autoTextsPausedAt).toBeNull();
  });

  it("a reply after the day-3 check-in keeps the one text a day going instead of a pause", async () => {
    const tester = await setup();
    await day(MON, "09:00", "22:05");
    await day(TUE, "09:00", "22:05");
    await day(WED, "09:00", "22:05");
    expect(await day(THU, "09:00", "19:00")).toEqual(["day_three@18:50"]);
    await say(tester, "inbound", at(THU, "19:10"), "yeah I still want this");
    await say(tester, "outbound", at(THU, "19:10"), "Then let's go. Tomorrow, full ten.");
    expect(await day(THU, "19:15", "22:05")).toEqual([]);
    expect(await day(FRI, "09:00", "22:05")).toEqual(["one_a_day@18:50"]);
    expect((await getTester(t.db, tester.id))!.autoTextsPausedAt).toBeNull();
  });

  it("a done day ends the ladder: back to the normal day", async () => {
    await setup();
    await day(MON, "09:00", "22:05");
    await day(TUE, "09:00", "22:05");
    expect(await day(WED, "09:00", "18:55")).toEqual(["one_a_day@18:50"]);
    await tool("mark_step_done", { how: "reduced", note: "5 pages" }, at(WED, "19:30"));
    expect(await day(THU, "09:00", "22:05")).toEqual(["kickoff@09:00", "checkin@18:50", "followup@19:50"]);
  });

  it("reworking the plan starts the ladder fresh", async () => {
    await setup();
    await day(MON, "09:00", "22:05");
    await day(TUE, "09:00", "22:05");
    expect(await tool("change_plan", { step: "5 pages of Dune", time: "21:00" }, at(WED, "08:00"))).toMatchObject({ ok: true });
    // Wednesday (untouched) is the new plan's first miss: Thursday is "after a miss", not day 3.
    expect(await day(THU, "09:00", "21:55")).toEqual(["after_miss@09:00", "checkin@20:50", "followup@21:50"]);
  });
});

describe("streaks (rule 6)", () => {
  const row = (date: string, status: "done" | "done_reduced" | "missed", planId = "p1") => ({ date, status, planId });

  it("counts done and reduced days, and stops at a miss", () => {
    expect(summarizeDays([row(WED, "done"), row(TUE, "done_reduced"), row(MON, "done"), row(SUN, "missed")], [])).toEqual({
      streak: 3,
      missesInARow: 0,
      reducedInARow: 0,
    });
    expect(summarizeDays([row(WED, "missed"), row(TUE, "missed"), row(MON, "done")], [])).toMatchObject({ streak: 0, missesInARow: 2 });
  });

  it("a second reduced day in a row doesn't count unless the plan changed or a temporary plan runs", () => {
    const twoReduced = [row(TUE, "done_reduced"), row(MON, "done_reduced"), row(SUN, "done")];
    expect(summarizeDays(twoReduced, [])).toMatchObject({ streak: 0, reducedInARow: 2 });
    expect(summarizeDays([row(TUE, "done_reduced", "p2"), row(MON, "done_reduced"), row(SUN, "done")], [])).toMatchObject({ streak: 3 });
    expect(summarizeDays(twoReduced, [{ id: "p1", endsOn: FRI }])).toMatchObject({ streak: 3 });
    expect(summarizeDays([row(WED, "done"), ...twoReduced], [])).toMatchObject({ streak: 1 });
  });
});

describe("a temporary lighter plan (rule 7)", () => {
  it("change_plan with until saves a flagged version with an end date; the usual plan comes back after it", async () => {
    const tester = await setup();
    expect(await tool("change_plan", { step: "5 pages of Dune", until: MON }, at(MON, "10:00"))).toMatchObject({ ok: false });
    expect(await tool("change_plan", { step: "5 pages of Dune", until: WED }, at(MON, "10:00"))).toMatchObject({ ok: true });
    const temp = (await t.db.select().from(plans).orderBy(asc(plans.version))).at(-1)!;
    expect(temp).toMatchObject({ version: 2, endsOn: WED, needsReview: true, step: "5 pages of Dune" });
    expect(await loadCurrentPlan(t.db, tester, WED)).toMatchObject({ version: 2 });
    expect(await loadCurrentPlan(t.db, tester, THU)).toMatchObject({ version: 1, step: "10 pages of Dune" });
  });

  it("the state block shows the streak, and asks which it is after two reduced days in a row", async () => {
    const tester = await setup();
    const plan = (await t.db.select().from(plans))[0]!;
    await t.db.insert(stepDays).values([
      { testerId: tester.id, date: MON, planId: plan.id, status: "done_reduced" },
      { testerId: tester.id, date: TUE, planId: plan.id, status: "done_reduced" },
    ]);
    const block = buildStateBlock(await loadCoachState(t.db, tester, { now: at(WED, "10:00"), isFirstText: false }));
    expect(block).toContain("Recent step days, newest first: Tue done (reduced version), Mon done (reduced version).");
    expect(block).toContain("Streak: 0 step days. Missed in a row: 0. Reduced in a row: 2.");
    expect(block).toContain("lower the plan for good (change_plan), or lighter for a short stretch with an end date (change_plan with until)");
  });
});
