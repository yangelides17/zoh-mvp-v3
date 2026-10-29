import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertFailure } from "../src/console/alerts.js";
import { addRequest } from "../src/console/requests.js";
import { buildStateBlock } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { consoleMessages, messages, pauses, plans, stepDays, testers, type Tester } from "../src/db/schema.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import { SYSTEM_DOWN_REPLY, type Logger } from "../src/pipeline/inbound.js";
import { goalMetrics } from "../src/testers/goals.js";
import { activePause, pausedOn } from "../src/testers/pauses.js";
import { getTester } from "../src/testers/testers.js";
import { LINE, ME, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

/**
 * Commands and safety (spec: GitHub issue "Commands and safety"): pause and resume, feedback,
 * the console alerts for stop, pause, feedback and failures, and Sendblue's opt-in after a stop.
 */

const TZ = "America/New_York";
/** Quiet hours end at 9 am and start at 10 pm. */
const SUN = "2026-11-01";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const SAT = "2026-11-07";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);

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

/** A tester with a locked reading plan: every day at 7 pm, 20 minutes, from Monday, locked Sunday noon. */
async function setup(): Promise<Tester> {
  const lockedAt = at(SUN, "12:00");
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Sam",
      goalSlug: "reading",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      quietHoursStart: "22:00",
      quietHoursEnd: "09:00",
      pushiness: "pushy",
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
    place: "the couch",
    stepTime: "19:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    proof: "photo",
    reason: "Ten pages a night builds the habit.",
    minutes: 20,
    startDate: MON,
    commitment: "I'm in",
    lockedAt,
  });
  await t.db.insert(messages).values([
    { direction: "inbound", contactNumber: ME, content: "I'm in", createdAt: new Date(lockedAt.getTime() - 60_000), sentAt: new Date(lockedAt.getTime() - 60_000) },
    { direction: "outbound", contactNumber: ME, content: "LET'S GO", createdAt: lockedAt, sentAt: lockedAt },
  ]);
  return tester!;
}

async function tool(name: string, input: unknown, now: Date) {
  const tester = (await getTester(t.db, (await t.db.select().from(testers).where(eq(testers.phone, ME)))[0]!.id))!;
  const state = await loadCoachState(t.db, tester, { now, isFirstText: false, lastTesterText: "" });
  return runTool(t.db, state, name, input, now);
}

/** Ticks every 5 minutes between two local times and returns the moments of the texts ZOH started. */
async function ticks(date: string, from: string, to: string): Promise<string[]> {
  const before = t.replier.nudges.length;
  for (let ms = at(date, from).getTime(); ms <= at(date, to).getTime(); ms += 5 * 60_000) await scheduler.tick(new Date(ms));
  return t.replier.nudges.slice(before).map((n) => n.moment);
}

async function alerts(topic?: string) {
  const rows = await t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "alert")).orderBy(asc(consoleMessages.createdAt));
  return topic ? rows.filter((r) => r.topic === topic) : rows;
}

async function text(content: string) {
  const res = await postWebhook(t, inboundEvent({ content }));
  expect(res.statusCode).toBe(200);
  await t.queue.idle();
}

async function done(testerId: string, date: string) {
  const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, testerId));
  await t.db.insert(stepDays).values({ testerId, date, planId: plan!.id, status: "done" });
}

describe("pause", () => {
  it("stops every text ZOH would start until they say they're back", async () => {
    await setup();
    const paused = await tool("pause_texts", { reason: "the flu" }, at(SUN, "20:00"));
    expect(paused).toMatchObject({ ok: true });
    expect(await ticks(MON, "08:00", "21:55")).toEqual([]);

    const resumed = await tool("resume_texts", {}, at(TUE, "08:00"));
    expect(resumed).toMatchObject({ ok: true });
    expect(await ticks(TUE, "08:30", "09:10")).toEqual(["kickoff"]);
  });

  it("holds back the founders' exact texts and own-text requests too", async () => {
    const tester = await setup();
    await tool("pause_texts", { reason: "traveling" }, at(SUN, "20:00"));
    await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Hey from Yanni", exact: true, sendNow: true, at: at(MON, "10:00") });
    await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Ask about the trip", exact: false, sendNow: false, delivery: "own_text", dueAt: at(MON, "10:00"), at: at(MON, "10:00") });
    await ticks(MON, "10:05", "11:00");
    expect(t.sendblue.sends).toHaveLength(0);
  });

  it("still answers whatever they text while paused", async () => {
    await setup();
    await tool("pause_texts", { reason: "the flu" }, new Date());
    await text("how many pages was it again?");
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["Hey! Thanks for the message."]);
    expect(await activePause(t.db, (await t.db.select().from(testers))[0]!.id)).toBeDefined();
  });

  it("lifts on its own the morning of their end date, and the kickoff follows", async () => {
    const tester = await setup();
    await tool("pause_texts", { reason: "cousin's wedding", back_on: TUE }, at(SUN, "20:00"));
    expect(await ticks(MON, "08:00", "21:55")).toEqual([]);
    expect(await ticks(TUE, "08:00", "09:10")).toEqual(["kickoff"]);
    const [row] = await t.db.select().from(pauses).where(eq(pauses.testerId, tester.id));
    expect(row).toMatchObject({ endedBy: "end_date", until: TUE });
    expect(await alerts("resume")).toHaveLength(1);
  });

  it("refuses an end date that isn't after today", async () => {
    await setup();
    expect(await tool("pause_texts", { reason: "busy", back_on: MON }, at(MON, "12:00"))).toMatchObject({ ok: false });
  });

  it("asking again while paused says so and raises no second alert", async () => {
    await setup();
    await tool("pause_texts", { reason: "the flu" }, at(SUN, "20:00"));
    const again = await tool("pause_texts", { reason: "still sick" }, at(MON, "12:00"));
    expect(again.ok && again.message).toMatch(/already paused/);
    expect(await alerts("pause")).toHaveLength(1);
    expect((await alerts("pause"))[0]!.body).toBe("Paused ZOH's texts: the flu");
  });

  it("resume_texts when they aren't paused is an error the coach sees", async () => {
    await setup();
    expect(await tool("resume_texts", {}, at(MON, "12:00"))).toMatchObject({ ok: false });
  });

  it("shows in the coach's state", async () => {
    const tester = await setup();
    await tool("pause_texts", { reason: "the flu", back_on: WED }, at(SUN, "20:00"));
    const state = await loadCoachState(t.db, (await getTester(t.db, tester.id))!, { now: at(MON, "12:00"), isFirstText: false });
    expect(buildStateBlock(state)).toContain(`PAUSED: they asked for a break on ${SUN} (the flu), back on ${WED}`);
  });

  it("a stop while paused wins and closes the pause", async () => {
    const tester = await setup();
    await tool("pause_texts", { reason: "the flu" }, new Date());
    await text("STOP");
    const [row] = await t.db.select().from(pauses).where(eq(pauses.testerId, tester.id));
    expect(row!.endedBy).toBe("stop");
    expect(await alerts("resume")).toHaveLength(0);
  });
});

describe("paused days", () => {
  it("are never misses: the streak neither breaks nor grows, and no second-miss alert", async () => {
    const tester = await setup();
    for (const d of [MON, TUE, WED]) await done(tester.id, d);
    await tool("pause_texts", { reason: "family visit", back_on: SAT }, at(THU, "08:00"));
    await ticks(THU, "21:50", "22:10");
    await ticks(FRI, "21:50", "22:10");
    // The first tick after the pause lifts also closes yesterday: Friday ended inside the pause.
    await ticks(SAT, "08:55", "09:10");
    const rows = await t.db.select().from(stepDays).where(and(eq(stepDays.testerId, tester.id), eq(stepDays.status, "missed")));
    expect(rows).toEqual([]);
    await done(tester.id, SAT);
    const { current } = await goalMetrics(t.db, tester.id, "reading", SAT);
    expect(current?.length).toBe(4);
    expect(await alerts("second_miss")).toHaveLength(0);
  });

  it("a step day that ends after they're back counts as usual", async () => {
    const tester = await setup();
    await tool("pause_texts", { reason: "flu" }, at(MON, "08:00"));
    await tool("resume_texts", {}, at(TUE, "12:00"));
    await ticks(TUE, "22:00", "22:10");
    const missed = await t.db.select().from(stepDays).where(and(eq(stepDays.testerId, tester.id), eq(stepDays.status, "missed")));
    expect(missed.map((r) => r.date)).toEqual([TUE]);
  });

  it("pausedOn: a day is paused when its end falls inside a pause", () => {
    const clock = { timeZone: TZ, quietHoursStart: "22:00", quietHoursEnd: "09:00" };
    const pause = { id: "p", testerId: "x", startedAt: at(MON, "12:00"), until: null, reason: null, endedAt: at(WED, "10:00"), endedBy: "tester" as const };
    expect(pausedOn([pause], SUN, clock)).toBe(false);
    expect(pausedOn([pause], MON, clock)).toBe(true);
    expect(pausedOn([pause], TUE, clock)).toBe(true);
    expect(pausedOn([pause], WED, clock)).toBe(false);
    expect(pausedOn([{ ...pause, endedAt: null }], FRI, clock)).toBe(true);
  });
});

describe("console alerts", () => {
  it("a stop raises one alert, for the word and for the coach's opt_out", async () => {
    await text("STOP");
    expect((await alerts("stop")).map((a) => a.body)).toEqual(["Opted out (texted stop)"]);
    await text("stop");
    expect(await alerts("stop")).toHaveLength(1);
  });

  it("revoke stops them too, so ZOH agrees with Sendblue's list", async () => {
    await text("Revoke");
    expect(await alerts("stop")).toHaveLength(1);
  });

  it("the coach's opt_out raises the stop alert", async () => {
    await setup();
    await tool("opt_out", {}, at(MON, "12:00"));
    expect((await alerts("stop")).map((a) => a.body)).toEqual(["Opted out (asked the coach to stop)"]);
  });

  it("feedback is saved word for word, once", async () => {
    await setup();
    const result = await tool("send_feedback", { feedback: "the 9am text is too early for me" }, at(MON, "12:00"));
    expect(result).toMatchObject({ ok: true });
    await tool("send_feedback", { feedback: "the 9am text is too early for me" }, at(MON, "12:01"));
    expect((await alerts("feedback")).map((a) => a.body)).toEqual(["the 9am text is too early for me"]);
  });

  it("pausing and coming back each raise one", async () => {
    await setup();
    await tool("pause_texts", { reason: "crunch week at work", back_on: FRI }, at(MON, "12:00"));
    await tool("resume_texts", {}, at(WED, "12:00"));
    expect((await alerts()).map((a) => [a.topic, a.body])).toEqual([
      ["pause", `Paused ZOH's texts until ${FRI}: crunch week at work`],
      ["resume", "Back from their pause: they said they're back"],
    ]);
  });
});

describe("after a stop", () => {
  it("their next text takes them off Sendblue's opt-out list before the reply, with one alert", async () => {
    await text("stop");
    await text("hi again");
    const kinds = t.sendblue.calls.filter((c) => c.kind !== "typing").map((c) => c.kind === "send" ? c.content : c.kind);
    expect(kinds).toEqual([expect.any(String), "opt_in", "Hey! Thanks for the message."]);
    expect(await alerts("unstop")).toHaveLength(1);
  });

  it("never opts in a tester who didn't stop", async () => {
    await text("hi");
    expect(t.sendblue.calls.some((c) => c.kind === "opt_in")).toBe(false);
  });

  it("still replies if the opt-in fails, and tells the founders", async () => {
    t.sendblue.failOptIn = true;
    await text("stop");
    await text("back");
    expect(t.sendblue.sends.at(-1)?.content).toBe("Hey! Thanks for the message.");
    expect((await alerts("failure"))[0]!.body).toMatch(/Sendblue's opt-out list/);
  });
});

describe("failures", () => {
  it("the system-down reply raises a failure alert", async () => {
    t.replier.fail = true;
    await text("hi");
    expect(t.sendblue.sends.at(-1)?.content).toBe(SYSTEM_DOWN_REPLY);
    expect((await alerts("failure"))[0]!.body).toMatch(/system-down reply/);
  });

  it("a reply that never sends raises one", async () => {
    t.sendblue.failSend = true;
    await text("hi");
    expect((await alerts("failure"))[0]!.body).toMatch(/A reply didn't send/);
  });

  it("a nudge that never sends raises one", async () => {
    await setup();
    t.sendblue.failSend = true;
    await ticks(MON, "08:55", "09:05");
    expect((await alerts("failure"))[0]!.body).toMatch(/kickoff text didn't send/);
  });

  it("at most one per tester per hour", async () => {
    const tester = await setup();
    expect(await alertFailure(t.db, tester.id, "one", at(MON, "10:05"))).toBe(true);
    expect(await alertFailure(t.db, tester.id, "two", at(MON, "10:30"))).toBe(false);
    expect(await alertFailure(t.db, tester.id, "three", at(MON, "10:59"))).toBe(false);
    expect(await alertFailure(t.db, tester.id, "four", at(MON, "11:01"))).toBe(true);
    expect((await alerts("failure")).map((a) => a.body)).toEqual(["one", "four"]);
  });
});
