import { readFileSync } from "node:fs";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { raiseAlert } from "../src/console/alerts.js";
import { createCoach } from "../src/coach/coach.js";
import { buildStateBlock, NUDGES } from "../src/coach/prompt.js";
import { loadCoachState, loadCurrentPlan } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import {
  consoleMessages,
  flags,
  maintenanceCheckins,
  messages,
  nudges,
  planInputs,
  plans,
  stepDays,
  testers,
  type Plan,
  type Tester,
} from "../src/db/schema.js";
import { createMediaRetention } from "../src/media/retention.js";
import { dueNudge, serviceDate, zonedTime, type NudgeInput } from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import { summarizeDays } from "../src/nudges/streak.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { goalMetrics, loadTesterGoals, setFocusGoal } from "../src/testers/goals.js";
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
const SAT = "2026-11-07";
const SUN2 = "2026-11-08";
const MON2 = "2026-11-09";
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

async function tool(name: string, input: unknown, now: Date, lastTesterText = "", goalCap?: number) {
  const tester = (await getTester(t.db, (await t.db.select().from(testers).where(eq(testers.phone, ME)))[0]!.id))!;
  const state = await loadCoachState(t.db, tester, { now, isFirstText: false, lastTesterText, goalCap });
  return runTool(t.db, state, name, input, now);
}

/** A photo from them a minute before `now`, then the step marked done on it. */
async function doneWithPhoto(how: "full" | "reduced", now: Date, note?: string) {
  await photo(new Date(now.getTime() - 60_000));
  return tool("mark_step_done", { how, proof: "clear", seen: "the book open on the couch", ...(note ? { note } : {}) }, now);
}

/** A photo (or, with `kind`, a voice note or video) from them, as the webhook stores it. */
async function photo(when: Date, kind: "photo" | "voice" | "video" = "photo") {
  const media = {
    photo: ["https://cdn.example/p.jpg", "image/jpeg"],
    voice: ["https://cdn.example/v.caf", "audio/x-caf"],
    video: ["https://cdn.example/m.mov", "video/quicktime"],
  }[kind];
  await t.db.insert(messages).values({
    direction: "inbound",
    contactNumber: ME,
    content: "",
    mediaUrl: media[0],
    mediaContentType: media[1],
    createdAt: when,
    sentAt: when,
  });
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
    expect(await doneWithPhoto("reduced", at(MON, "12:00"), "5 pages")).toMatchObject({ ok: true });
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
    await doneWithPhoto("full", at(MON, "19:30"));
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
    await doneWithPhoto("full", at(MON, "12:00"));
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

  it("an empty answer is tried once more; two in a row are an error, so the slot is retried", async () => {
    const tester = await setup();
    const model = new FakeClaudeModel();
    model.script("", "Yo Sam! Ten pages tonight?");
    const coach = createCoach({ db: t.db, model });
    expect(await coach.nudge!({ tester, turns: [], now: at(MON, "09:00"), moment: "kickoff" })).toBe("Yo Sam! Ten pages tonight?");
    model.script("", "");
    await expect(coach.nudge!({ tester, turns: [], now: at(MON, "09:00"), moment: "kickoff" })).rejects.toThrow(/no nudge text/);
    expect(model.requests).toHaveLength(4);
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
    await doneWithPhoto("full", at(MON, "20:40"), "10 pages");
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

  it("a reply after the day-3 check-in, then silence: the ladder repeats, then pause and flag (#41)", async () => {
    const tester = await setup();
    await day(MON, "09:00", "22:05");
    await day(TUE, "09:00", "22:05");
    await day(WED, "09:00", "22:05");
    expect(await day(THU, "09:00", "19:00")).toEqual(["day_three@18:50"]);
    await say(tester, "inbound", at(THU, "19:10"), "yeah yeah");
    await say(tester, "outbound", at(THU, "19:10"), "Then let's go. Tomorrow, full ten.");
    expect(await day(THU, "19:15", "22:05")).toEqual([]);
    // Two daily texts with no reply, then the honest check-in again, handed the first one to read differently.
    expect(await day(FRI, "09:00", "22:05")).toEqual(["one_a_day@18:50"]);
    expect(await day(SAT, "09:00", "22:05")).toEqual(["one_a_day@18:50"]);
    expect(await day(SUN2, "09:00", "22:05")).toEqual(["day_three@18:50"]);
    expect(t.replier.nudges.at(-1)!.previous).toBe("Yo, day_three text");
    expect((await getTester(t.db, tester.id))!.autoTextsPausedAt).toBeNull();
    // No reply to that one either: no text on the next step day; paused and flagged.
    expect(await day(MON2, "09:00", "22:05")).toEqual([]);
    expect((await getTester(t.db, tester.id))!.autoTextsPausedAt).not.toBeNull();
    expect(await t.db.select().from(flags).where(eq(flags.kind, "went_quiet"))).toHaveLength(1);
  });

  it("a reply between the daily texts starts the count over (#41)", async () => {
    const tester = await setup();
    await day(MON, "09:00", "22:05");
    await day(TUE, "09:00", "22:05");
    await day(WED, "09:00", "22:05");
    await day(THU, "09:00", "19:00");
    await say(tester, "inbound", at(THU, "19:10"), "yeah yeah");
    expect(await day(FRI, "09:00", "19:00")).toEqual(["one_a_day@18:50"]);
    await say(tester, "inbound", at(FRI, "19:10"), "tomorrow for real");
    expect(await day(FRI, "19:15", "22:05")).toEqual([]);
    expect(await day(SAT, "09:00", "22:05")).toEqual(["one_a_day@18:50"]);
    expect(await day(SUN2, "09:00", "22:05")).toEqual(["one_a_day@18:50"]);
    expect(await day(MON2, "09:00", "22:05")).toEqual(["day_three@18:50"]);
    expect((await getTester(t.db, tester.id))!.autoTextsPausedAt).toBeNull();
  });

  it("a done day ends the ladder: back to the normal day", async () => {
    await setup();
    await day(MON, "09:00", "22:05");
    await day(TUE, "09:00", "22:05");
    expect(await day(WED, "09:00", "18:55")).toEqual(["one_a_day@18:50"]);
    await doneWithPhoto("reduced", at(WED, "19:30"), "5 pages");
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

describe("a kickoff the morning already covered (#42)", () => {
  const sentKinds = async () =>
    (await t.db.select().from(nudges).orderBy(asc(nudges.createdAt))).map((r) => `${r.kind}:${r.status}`);

  it("no text from them today: the kickoff goes as usual, with no skip offered", async () => {
    await setup();
    t.replier.skipWhenAllowed = true;
    expect(await day(MON, "09:00", "09:30")).toEqual(["kickoff@09:00"]);
    expect(t.replier.nudges[0]!.mayskip).toBeUndefined();
    expect(t.sendblue.sends).toHaveLength(1);
  });

  it("they texted this morning and the coach skips: nothing sent, no kickoff later, check-in and follow-up still go", async () => {
    const tester = await setup();
    t.replier.skipWhenAllowed = true;
    await say(tester, "inbound", at(MON, "08:10"), "Yep! 7 tonight");
    await say(tester, "outbound", at(MON, "08:10"), "Love it.");
    await day(MON, "09:00", "21:59");
    expect(t.replier.nudges[0]).toMatchObject({ moment: "kickoff", mayskip: true });
    expect(await sentKinds()).toEqual(["kickoff:skipped", "checkin:sent", "followup:sent"]);
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["Yo, checkin text", "Yo, followup text"]);
    // The check-in and follow-up are never offered the skip.
    expect(t.replier.nudges.slice(1).map((n) => n.mayskip)).toEqual([undefined, undefined]);
  });

  it("they texted but the coach writes it: the kickoff goes", async () => {
    const tester = await setup();
    await say(tester, "inbound", at(MON, "08:10"), "rough night lol");
    expect(await day(MON, "09:00", "09:30")).toEqual(["kickoff@09:00"]);
    expect(t.replier.nudges[0]!.mayskip).toBe(true);
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["Yo, kickoff text"]);
  });

  it("the kickoff after a miss can be skipped once they've texted that day", async () => {
    const tester = await setup();
    await day(MON, "09:00", "22:05");
    t.replier.skipWhenAllowed = true;
    await say(tester, "inbound", at(TUE, "08:30"), "I know I missed yesterday. Ready to go today");
    await day(TUE, "09:00", "09:30");
    expect(t.replier.nudges.at(-1)).toMatchObject({ moment: "after_miss", mayskip: true });
    expect((await sentKinds()).at(-1)).toBe("kickoff:skipped");
  });

  it("a text from yesterday doesn't count: no skip offered", async () => {
    const tester = await setup();
    await say(tester, "inbound", at(SUN, "21:00"), "see you tomorrow");
    await day(MON, "09:00", "09:30");
    expect(t.replier.nudges[0]!.mayskip).toBeUndefined();
  });
});

describe("streaks (rule 6)", () => {
  const row = (date: string, status: "done" | "done_reduced" | "missed", planId = "p1") => ({ date, status, planId });

  it("counts done and reduced days, and stops at a miss", () => {
    expect(summarizeDays([row(WED, "done"), row(TUE, "done_reduced"), row(MON, "done"), row(SUN, "missed")], [])).toEqual({
      streak: 3,
      streakThrough: WED,
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
    expect(block).toContain("Streak: 0 step days, not counting today (done today makes it 1). Missed in a row: 0. Reduced in a row: 2.");
    expect(block).toContain("lower the plan for good (change_plan), or lighter for a short stretch with an end date (change_plan with until)");
  });
});

describe("proof (spec: Photo and voice verification)", () => {
  const seen = { proof: "plausible", seen: "dark selfie, lights off" } as const;

  it("done needs a photo or voice note from today, and saves the verdict and what was seen", async () => {
    const tester = await setup();
    const words = await tool("mark_step_done", { how: "full", ...seen }, at(MON, "20:00"));
    expect(words).toMatchObject({ ok: false, error: expect.stringContaining("words alone don't mark it done") });
    // Yesterday's photo and a video don't count for today.
    await photo(at(SUN, "21:00"));
    await photo(at(MON, "19:40"), "video");
    expect(await tool("mark_step_done", { how: "full", ...seen }, at(MON, "20:00"))).toMatchObject({ ok: false });
    await photo(at(MON, "20:01"), "voice");
    expect(await tool("mark_step_done", { how: "full", ...seen }, at(MON, "20:02"))).toMatchObject({ ok: true });
    expect(await stepDay(tester, MON)).toMatchObject({ status: "done", proofVerdict: "plausible", proofSeen: "dark selfie, lights off" });
  });

  it("goes by when Sendblue says the photo was sent, not when we stored it", async () => {
    const tester = await setup();
    // Found by the eval, whose clock runs apart from the database's: a photo sent at 8 pm, stored hours later.
    await t.db.insert(messages).values({
      direction: "inbound",
      contactNumber: ME,
      mediaUrl: "https://cdn.example/p.jpg",
      mediaContentType: "image/jpeg",
      sentAt: at(MON, "20:00"),
      createdAt: at(TUE, "03:00"),
    });
    expect(await tool("mark_step_done", { how: "full", ...seen }, at(MON, "20:01"))).toMatchObject({ ok: true });
    expect((await stepDay(tester, MON))?.status).toBe("done");
  });

  it("counts a photo whose Sendblue time is a little ahead of our clock", async () => {
    const tester = await setup();
    await photo(at(MON, "20:02"));
    expect(await tool("mark_step_done", { how: "full", ...seen }, at(MON, "20:00"))).toMatchObject({ ok: true });
    expect((await stepDay(tester, MON))?.status).toBe("done");
  });

  it("the state block tells the coach what proof came in and its read of it", async () => {
    const tester = await setup();
    const block = () => loadCoachState(t.db, tester, { now: at(MON, "20:00"), isFirstText: false }).then(buildStateBlock);
    expect(await block()).toContain("No photo, screenshot or voice note from them today.");
    await photo(at(MON, "19:50"));
    await tool("proof_unclear", { verdict: "doesnt_match", seen: "bright hallway, lights on" }, at(MON, "19:51"));
    expect(await block()).toContain("Proof sent today: 1. Your read: doesnt match (bright hallway, lights on). Still sorting it out with them.");
  });

  it("unclear proof holds the check-in and follow-up; clearing it up marks the day done", async () => {
    const tester = await setup();
    expect(await tick(MON, "09:00")).toEqual(["kickoff"]);
    await photo(at(MON, "18:00"));
    expect(await tool("proof_unclear", { verdict: "unclear", seen: "blurry, can't make it out" }, at(MON, "18:01"))).toMatchObject({ ok: true });
    expect(await day(MON, "18:05", "21:55")).toEqual([]);
    await doneWithPhoto("full", at(MON, "21:00"));
    expect(await stepDay(tester, MON)).toMatchObject({ status: "done", proofVerdict: "clear", proofPendingAt: null });
  });

  it("no proof: a miss stops today's nudges, and a photo later the same day still makes it done", async () => {
    const tester = await setup();
    expect(await tick(MON, "09:00")).toEqual(["kickoff"]);
    expect(await tool("mark_missed", { note: "gym, forgot the pic" }, at(MON, "12:00"))).toMatchObject({ ok: true });
    expect(await stepDay(tester, MON)).toMatchObject({ status: "missed" });
    expect(await day(MON, "12:05", "20:55")).toEqual([]);
    await doneWithPhoto("full", at(MON, "21:00"));
    expect(await stepDay(tester, MON)).toMatchObject({ status: "done" });
    expect(await tool("mark_missed", {}, at(MON, "21:05"))).toMatchObject({ ok: false, error: "Today is already done." });
  });

  it("proof dated yesterday turns yesterday's miss into done, and the slip ladder and streak follow", async () => {
    const tester = await setup();
    await tick(MON, "22:05");
    await tick(TUE, "22:05");
    expect((await stepDay(tester, TUE))?.status).toBe("missed");
    const before = await loadCoachState(t.db, tester, { now: at(WED, "09:20"), isFirstText: false });
    expect(before.days).toMatchObject({ streak: 0, missesInARow: 2 });

    const yesterday = { how: "full", ...seen, day: "yesterday" } as const;
    // The proof has to be in what they just sent, and the coach has to have seen a date on it.
    await photo(at(TUE, "20:00"));
    await say(tester, "outbound", at(TUE, "20:01"), "Love it");
    expect(await tool("mark_step_done", { ...yesterday, dated: "Nov 3" }, at(WED, "09:30"))).toMatchObject({ ok: false });
    await photo(at(WED, "09:29"));
    expect(await tool("mark_step_done", yesterday, at(WED, "09:30"))).toMatchObject({ ok: false, error: expect.stringContaining("dated") });
    expect(await tool("mark_step_done", { ...yesterday, dated: "Nov 3, 8:12 pm" }, at(WED, "09:30"))).toMatchObject({ ok: true });
    expect(await stepDay(tester, TUE)).toMatchObject({ status: "done", proofSeen: "dark selfie, lights off (dated Nov 3, 8:12 pm)" });
    expect(await stepDay(tester, WED)).toBeUndefined();

    const after = await loadCoachState(t.db, tester, { now: at(WED, "09:35"), isFirstText: false });
    expect(after.days).toMatchObject({ streak: 1, missesInARow: 0 });
    // Off the ladder: a normal day again instead of one text at step time.
    expect(await day(WED, "09:35", "21:55")).toEqual(["kickoff@09:35", "checkin@18:50", "followup@19:50"]);
  });

  it("flag_proof_pattern saves a flag for the founders and sends nothing", async () => {
    const tester = await setup();
    const sends = t.sendblue.sends.length;
    expect(await tool("flag_proof_pattern", { reason: "Third day of blurry photos, never the book" }, at(MON, "20:00"))).toMatchObject({ ok: true });
    expect(await t.db.select().from(flags).where(eq(flags.testerId, tester.id))).toMatchObject([
      { kind: "proof_pattern", detail: "Third day of blurry photos, never the book" },
    ]);
    expect(t.sendblue.sends.length).toBe(sends);
  });
});

describe("voice-note audio retention", () => {
  it("deletes audio 30 days after it arrived, keeps newer audio and every photo, and records it", async () => {
    const now = at(MON, "12:00");
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
    const rows = [
      { key: "media/1/old.caf", type: "audio/x-caf", when: daysAgo(31) },
      { key: "media/1/old-unlabeled.m4a", type: "application/octet-stream", when: daysAgo(40) },
      { key: "media/1/new.caf", type: "audio/x-caf", when: daysAgo(29) },
      { key: "media/1/old.jpg", type: "image/jpeg", when: daysAgo(60) },
    ];
    for (const r of rows) {
      await t.media.put(r.key, new Uint8Array([1]), r.type);
      await t.db.insert(messages).values({
        direction: "inbound",
        contactNumber: ME,
        mediaUrl: `https://cdn.example/${r.key}`,
        mediaKey: r.key,
        mediaContentType: r.type,
        transcript: r.type === "image/jpeg" ? null : "did my ten pages",
        createdAt: r.when,
      });
    }
    const retention = createMediaRetention({ db: t.db, log: silent, media: t.media });
    expect(await retention.tick(now)).toBe(2);
    expect([...t.media.objects.keys()].sort()).toEqual(["media/1/new.caf", "media/1/old.jpg"]);
    const saved = await t.db.select().from(messages).orderBy(asc(messages.createdAt));
    expect(saved.map((m) => [m.mediaKey, m.mediaDeletedAt !== null, m.transcript])).toEqual([
      ["media/1/old.jpg", false, null],
      ["media/1/old-unlabeled.m4a", true, "did my ten pages"],
      ["media/1/old.caf", true, "did my ten pages"],
      ["media/1/new.caf", false, "did my ten pages"],
    ]);
    expect(await retention.tick(now)).toBe(0);
  });
});

describe("goals foundation (spec: Step log and next step)", () => {
  const done = async (tester: Tester, ...dates: string[]) => {
    const plan = (await t.db.select().from(plans).orderBy(asc(plans.version)))[0]!;
    await t.db.insert(stepDays).values(dates.map((date) => ({ testerId: tester.id, date, planId: plan.id, status: "done" as const })));
  };
  const block = async (tester: Tester, now: Date) =>
    buildStateBlock(await loadCoachState(t.db, (await getTester(t.db, tester.id))!, { now, isFirstText: false }));
  const alerts = () => t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "alert")).orderBy(asc(consoleMessages.createdAt));

  it("#46: the streak says whether today is counted, and marking today done says the new number once", async () => {
    const tester = await setup();
    await done(tester, MON, TUE, WED);
    expect(await block(tester, at(THU, "19:30"))).toContain("Streak: 3 step days, not counting today (done today makes it 4).");
    const result = await doneWithPhoto("full", at(THU, "19:30"));
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("Streak now: 4 step days, today included.") });
    expect(await block(tester, at(THU, "19:31"))).toContain("Streak: 4 step days, today included.");
  });

  it("day 1 done shows a streak of 1 even with nothing before it", async () => {
    const tester = await setup();
    await doneWithPhoto("full", at(MON, "19:30"));
    expect(await block(tester, at(MON, "19:31"))).toContain("Streak: 1 step day, today included.");
  });

  it("change_plan saves its kind (other by default); deepen keeps the streak, upgrade starts a new one", async () => {
    const tester = await setup();
    await done(tester, MON, TUE);
    expect(await tool("change_plan", { step: "15 pages of Dune", kind: "deepen", asked: "15 pages" }, at(WED, "08:00"), "can we do 15 pages now?")).toMatchObject({ ok: true });
    expect(await block(tester, at(WED, "08:01"))).toContain("Streak: 2 step days, not counting today");
    expect(await tool("change_plan", { time: "20:00" }, at(WED, "08:02"))).toMatchObject({ ok: true });
    expect(await tool("change_plan", { step: "5 pages", until: FRI, kind: "deepen", asked: "5 pages" }, at(WED, "08:03"), "just 5 pages till Friday")).toMatchObject({
      ok: false,
      error: expect.stringContaining("kind other"),
    });
    const upgrade = await tool("change_plan", { step: "20 min of lifting", kind: "upgrade", asked: "lifting" }, at(WED, "08:04"), "I want to try lifting instead");
    expect(upgrade).toMatchObject({ ok: true, message: expect.stringContaining("A new streak starts") });
    expect((await t.db.select().from(plans).orderBy(asc(plans.version))).map((p) => p.changeKind)).toEqual([null, "deepen", "other", "upgrade"]);
    expect(await block(tester, at(WED, "08:05"))).toContain("Streak: 0 step days, not counting today (done today makes it 1).");
    expect((await goalMetrics(t.db, tester.id, "reading", WED)).past).toEqual([{ length: 2, from: MON, to: TUE, endedBy: "upgrade" }]);
  });

  it("every saved flag and every locked version raises one alert, once per event", async () => {
    const tester = await setup();
    await tool("flag_proof_pattern", { reason: "Third day of blurry photos" }, at(MON, "20:00"));
    await tool("change_plan", { time: "20:00" }, at(MON, "20:05"));
    const [flag] = await t.db.select().from(flags);
    const version2 = (await t.db.select().from(plans).where(eq(plans.version, 2)))[0]!;
    expect(await alerts()).toMatchObject([
      { topic: "proof_pattern", eventKey: `flag:${flag!.id}`, body: "Third day of blurry photos", testerId: tester.id },
      { topic: "plan_review", eventKey: `plan_review:${version2.id}`, planId: version2.id },
    ]);
    const again = { testerId: tester.id, topic: "plan_review", key: `plan_review:${version2.id}`, body: "again" };
    expect(await raiseAlert(t.db, again)).toBe(false);
    expect(await alerts()).toHaveLength(2);
  });

  it("a switched goal is dropped with its streak frozen; the new focus starts its own", async () => {
    const tester = await setup();
    await setFocusGoal(t.db, tester.id, "reading", at(SUN, "12:00"), "remove");
    await done(tester, MON, TUE, WED);
    expect(await tool("switch_goal", { slug: "exercise", reason: "my doctor wants me moving" }, at(THU, "08:00"))).toMatchObject({ ok: true });
    expect((await loadTesterGoals(t.db, tester.id)).map((g) => [g.goalSlug, g.role, g.nudges, g.proof])).toEqual([
      ["reading", "dropped", false, false],
      ["exercise", "focus", true, true],
    ]);
    const state = await loadCoachState(t.db, (await getTester(t.db, tester.id))!, { now: at(THU, "08:01"), isFirstText: false });
    expect(state.days.streak).toBe(0);
    expect((await goalMetrics(t.db, tester.id, "reading", THU)).current).toMatchObject({ length: 3, to: WED });
    expect((await alerts()).map((a) => a.topic)).toEqual(["goal_switch"]);
  });

  it("reset clears goals and check-ins but keeps the console thread", async () => {
    const tester = await setup();
    await setFocusGoal(t.db, tester.id, "reading", at(SUN, "12:00"), "remove");
    await t.db.insert(maintenanceCheckins).values({ testerId: tester.id, goalSlug: "reading", date: MON });
    await tool("flag_proof_pattern", { reason: "blurry again" }, at(MON, "20:00"));
    await resetTester(t.db, (await getTester(t.db, tester.id))!, at(TUE, "10:00"));
    expect(await loadTesterGoals(t.db, tester.id)).toEqual([]);
    expect(await t.db.select().from(maintenanceCheckins)).toEqual([]);
    expect(await alerts()).toHaveLength(1);
  });

  it("the migration's backfill makes today's goal the focus, earlier goals dropped, and later versions 'other'", async () => {
    const tester = await setup();
    await t.db.insert(planInputs).values([{ testerId: tester.id, goalSlug: "reading" }, { testerId: tester.id, goalSlug: "bedtime" }]);
    const base = (await t.db.select().from(plans))[0]!;
    const { id: _id, ...rest } = base;
    await t.db.insert(plans).values({ ...rest, version: 2 });
    const migration = readFileSync(new URL("../drizzle/0006_goals_foundation.sql", import.meta.url), "utf8");
    const backfill = migration.slice(migration.indexOf("-- Today's goals")).split("--> statement-breakpoint");
    for (const statement of backfill) await t.db.execute(sql.raw(statement));
    expect((await loadTesterGoals(t.db, tester.id)).map((g) => [g.goalSlug, g.role]).sort()).toEqual([
      ["bedtime", "dropped"],
      ["reading", "focus"],
    ]);
    expect((await t.db.select().from(plans).orderBy(asc(plans.version))).map((p) => p.changeKind)).toEqual([null, "other"]);
  });
});
