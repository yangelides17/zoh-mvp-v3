import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoach, NUDGE_ROUNDS } from "../src/coach/coach.js";
import { buildStateBlock } from "../src/coach/prompt.js";
import { dayStep, loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { consoleMessages, messages, plans, stepDays, suggestions, testers, type Tester } from "../src/db/schema.js";
import { renderPage } from "../src/memory/render.js";
import { ensureGoalPages } from "../src/memory/store.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { setFocusGoal } from "../src/testers/goals.js";
import { getTester, updateTester } from "../src/testers/testers.js";
import { FakeClaudeModel, LINE, ME, makeApp, type TestApp } from "./helpers.js";

/** Today's step (#76): each step day gets its own step, picked by the coach, on that day's row. */

const TZ = "America/New_York";
const SUN = "2026-11-01";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
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

/** Sam: run 1 min, walk 2, Mon/Wed/Fri at 7 pm for 20 minutes from Monday, locked Sunday noon. */
async function setup(o: { phase?: Tester["phase"]; destination?: string } = {}): Promise<Tester> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Sam",
      goalSlug: "exercise",
      phase: o.phase ?? "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at(SUN, "10:00"),
      contextStartedAt: at(SUN, "10:00"),
    })
    .returning();
  if (o.phase !== "onboarding") {
    await t.db.insert(plans).values({
      testerId: tester!.id,
      goalSlug: "exercise",
      status: "locked",
      version: 1,
      step: "1 min easy jog, 2 min walk, 3 rounds around the block",
      stepTime: "19:00",
      days: ["mon", "wed", "fri"],
      proof: "screenshot",
      proofNote: "Strava run",
      reason: "Builds up to a mile.",
      minutes: 20,
      destination: o.destination ?? null,
      startDate: MON,
      commitment: "I'm in",
      lockedAt: at(SUN, "12:00"),
    });
    await setFocusGoal(t.db, tester!.id, "exercise", at(SUN, "12:00"), "remove");
  }
  await say(tester!, "inbound", at(SUN, "11:59"), "I'm in");
  await say(tester!, "outbound", at(SUN, "12:00"), "LET'S GO");
  return tester!;
}

async function say(tester: Tester, direction: "inbound" | "outbound", when: Date, content: string) {
  await t.db.insert(messages).values({ direction, contactNumber: tester.phone, content, createdAt: when, sentAt: when });
}

const me = async () => (await getTester(t.db, (await t.db.select().from(testers))[0]!.id))!;
const state = async (now: Date, lastTesterText = "") => loadCoachState(t.db, await me(), { now, isFirstText: false, lastTesterText });
const block = async (now: Date) => buildStateBlock(await state(now));
const tool = async (name: string, input: unknown, now: Date, lastTesterText = "") => runTool(t.db, await state(now, lastTesterText), name, input, now);
const row = async (date: string) => (await t.db.select().from(stepDays).where(eq(stepDays.date, date)))[0];
const allPlans = () => t.db.select().from(plans).orderBy(asc(plans.version));

/** Ticks every 5 minutes between two local times and returns the moments sent, with times. */
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

const TODAY_STEP = "outside on your block: 2 min jog, 1 min walk, 3 rounds at 7 pm (about 15 min)";

describe("set_today_step", () => {
  it("saves on today's row, and the coach's state shows it; before that, the plan's step applies", async () => {
    await setup();
    const before = await block(at(WED, "09:00"));
    expect(before).toContain("Today's step: not set yet. Pick it the first time you talk about today");
    expect(dayStep((await allPlans())[0]!, await row(WED)).step).toBe("1 min easy jog, 2 min walk, 3 rounds around the block");

    expect(await tool("set_today_step", { step: TODAY_STEP }, at(WED, "09:00"))).toMatchObject({ ok: true });
    expect(await row(WED)).toMatchObject({ step: TODAY_STEP, stepMinutes: null, stepProof: null, status: null });
    const after = await block(at(WED, "09:01"));
    expect(after).toContain(`Today's step (set, holds for today): "${TODAY_STEP}", about 20 min; proof: screenshot (Strava run).`);
    expect(dayStep((await allPlans())[0]!, await row(WED))).toMatchObject({ step: TODAY_STEP, own: true });
  });

  it("a day's own length and proof override the plan's", async () => {
    await setup();
    await tool("set_today_step", { step: "sign up at the gym on Main St", minutes: 30, proof: "a screenshot of the membership" }, at(WED, "09:00"));
    expect(await block(at(WED, "09:01"))).toContain('"sign up at the gym on Main St", about 30 min; proof: a screenshot of the membership.');
  });

  it("adds no plan version, review flag or alert", async () => {
    await setup();
    await tool("set_today_step", { step: TODAY_STEP }, at(WED, "09:00"));
    const all = await allPlans();
    expect(all).toHaveLength(1);
    expect(all[0]!.needsReview).toBe(false);
    expect(await t.db.select().from(consoleMessages)).toHaveLength(0);
    expect(await t.db.select().from(suggestions)).toHaveLength(0);
  });

  it("holds for the day: replacing it needs their words asking to change it", async () => {
    await setup();
    await tool("set_today_step", { step: TODAY_STEP }, at(WED, "09:00"));
    expect(await tool("set_today_step", { step: "treadmill, 2 on 1 off, 3 rounds" }, at(WED, "10:00"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("holds unless they ask"),
    });
    const asked = "can I do it on the treadmill instead? it's pouring";
    expect(await tool("set_today_step", { step: "treadmill, 2 on 1 off, 3 rounds", asked: "treadmill instead" }, at(WED, "10:00"), asked)).toMatchObject({ ok: true });
    expect((await row(WED))!.step).toBe("treadmill, 2 on 1 off, 3 rounds");
    // Saying the same step again is fine.
    expect(await tool("set_today_step", { step: "treadmill, 2 on 1 off, 3 rounds" }, at(WED, "11:00"))).toMatchObject({ ok: true });
  });

  it("the next step day's step set the night before is saved on that day and shows today and that day", async () => {
    await setup();
    // Tuesday is a rest day; Wednesday is the next step day.
    expect(await tool("set_today_step", { step: TODAY_STEP }, at(TUE, "20:00"))).toMatchObject({ ok: false, error: "Today isn't a step day." });
    expect(await tool("set_today_step", { step: TODAY_STEP, day: "next" }, at(TUE, "20:00"))).toMatchObject({ ok: true });
    expect(await block(at(TUE, "20:01"))).toContain(`Next step day: Wed ${WED}. Its step is already set: "${TODAY_STEP}", not agreed yet.`);
    expect(await block(at(WED, "09:00"))).toContain(`Today's step (set, holds for today): "${TODAY_STEP}"`);
  });

  it("is refused before lock and once the day is done", async () => {
    await setup();
    await t.db.insert(stepDays).values({ testerId: (await me()).id, date: WED, status: "done" });
    expect(await tool("set_today_step", { step: TODAY_STEP }, at(WED, "20:00"))).toMatchObject({ ok: false, error: `${WED} is already done.` });
    await updateTester(t.db, (await me()).id, { phase: "planning" });
    expect(await tool("set_today_step", { step: TODAY_STEP }, at(WED, "20:00"))).toMatchObject({ ok: false });
  });

  it("recent days show each day's step with how it went, so the next step builds on them", async () => {
    const tester = await setup();
    const [plan] = await allPlans();
    await t.db.insert(stepDays).values([
      { testerId: tester.id, date: MON, planId: plan!.id, status: "done", step: "1 on 2 off, 3 rounds", note: "easy", proofSeen: "Strava 1.1 mi" },
    ]);
    expect(await block(at(WED, "09:00"))).toContain(`Recent step days, newest first:\n- Mon ${MON}, done: "1 on 2 off, 3 rounds" (they said: easy; proof: Strava 1.1 mi)`);
  });

  it("a time moved for an earlier day says it was for that day only, so today keeps the plan's time (#73)", async () => {
    const tester = await setup();
    await t.db.insert(stepDays).values({ testerId: tester.id, date: MON, planId: (await allPlans())[0]!.id, status: "done", movedTime: "20:00" });
    const wed = await block(at(WED, "09:00"));
    expect(wed).toContain(`- Mon ${MON}, done, moved to 20:00 for that day only: the plan's step`);
    expect(wed).toContain(`Today: Wed ${WED}, a step day at 19:00.`);
  });
});

describe("check-in and follow-up use the day's step", () => {
  it("the coach writing a check-in or follow-up sees today's step, not the plan's", async () => {
    await setup();
    await tool("set_today_step", { step: TODAY_STEP }, at(WED, "09:00"));
    const model = new FakeClaudeModel("Hey Sam!");
    const coach = createCoach({ db: t.db, model, voice: "v" });
    for (const moment of ["checkin", "followup"] as const) {
      await coach.nudge!({ tester: await me(), turns: [], now: at(WED, moment === "checkin" ? "18:50" : "19:50"), moment });
      expect(model.stateOf()).toContain(`Today's step (set, holds for today): "${TODAY_STEP}"`);
    }
  });

  it("the follow-up waits for the day's own length; a moved time still moves check-in and follow-up", async () => {
    await setup();
    await tool("set_today_step", { step: TODAY_STEP, minutes: 45 }, at(MON, "08:00"));
    // 7 pm + 45 min + 30 (the plan's 20 would make it 7:50).
    expect(await day(MON, "09:00", "21:00")).toEqual(["kickoff@09:00", "checkin@18:50", "followup@20:15"]);

    await tool("set_today_step", { step: TODAY_STEP, minutes: 10 }, at(WED, "08:00"));
    await tool("move_today", { time: "20:00" }, at(WED, "08:01"));
    expect(await day(WED, "09:00", "21:59")).toEqual(["kickoff@09:00", "checkin@19:50", "followup@20:40"]);
  });
});

describe("the kickoff saves today's step while writing", () => {
  it("runs set_today_step, then writes with it in the state", async () => {
    await setup();
    const model = new FakeClaudeModel();
    model.script({ tools: [{ name: "set_today_step", input: { step: TODAY_STEP } }] }, "Morning Sam! 2 on, 1 off on your block at 7. You in?");
    const coach = createCoach({ db: t.db, model, voice: "v" });
    const text = await coach.nudge!({ tester: await me(), turns: [], now: at(WED, "09:00"), moment: "kickoff" });
    expect(text).toBe("Morning Sam! 2 on, 1 off on your block at 7. You in?");
    expect((await row(WED))!.step).toBe(TODAY_STEP);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]!.toolChoice).toBe("auto");
    expect(model.stateOf(1)).toContain(`Today's step (set, holds for today): "${TODAY_STEP}"`);
  });

  it("runs no other tool, and the last round must write", async () => {
    await setup();
    const model = new FakeClaudeModel("Morning Sam!");
    const loop = { tools: [{ name: "mark_agreed", input: {} }] };
    model.script(...Array.from({ length: NUDGE_ROUNDS }, () => loop));
    const coach = createCoach({ db: t.db, model, voice: "v" });
    expect(await coach.nudge!({ tester: await me(), turns: [], now: at(WED, "09:00"), moment: "kickoff" })).toBe("Morning Sam!");
    expect(model.requests).toHaveLength(NUDGE_ROUNDS);
    expect(model.requests.at(-1)!.toolChoice).toBe("none");
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("Only set_today_step while writing a text you start.");
    expect((await row(WED))?.agreedAt ?? null).toBeNull();
  });

  it("before lock, a text ZOH starts is one call with no tools", async () => {
    await setup({ phase: "onboarding" });
    const model = new FakeClaudeModel("Hey Sam, still there?");
    const coach = createCoach({ db: t.db, model });
    await coach.nudge!({ tester: await me(), turns: [], now: at(WED, "12:00"), moment: "stall" });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.toolChoice).toBe("none");
  });
});

describe("destination", () => {
  it("is optional: shown when there is one, and can be added to a locked plan later as an other change", async () => {
    await setup();
    expect(await block(at(MON, "09:00"))).toContain("Destination: none yet");
    const later = "my goal is to run a mile without stopping by Nov 14";
    expect(await tool("change_plan", { destination: "run a mile without stopping by Nov 14" }, at(MON, "20:00"), later)).toMatchObject({ ok: true });
    const [, v2] = await allPlans();
    expect(v2).toMatchObject({ version: 2, changeKind: "other", destination: "run a mile without stopping by Nov 14", step: "1 min easy jog, 2 min walk, 3 rounds around the block" });
    const now = await block(at(MON, "20:01"));
    expect(now).toContain("headed for: run a mile without stopping by Nov 14");
    expect(now).not.toContain("Destination: none yet");
    // An other change keeps the streak going.
    expect(now).not.toContain("A new streak starts");
  });

  it("the goal page's step path shows it", async () => {
    await setup({ destination: "run a mile without stopping by Nov 14" });
    const [page] = await ensureGoalPages(t.db, await me(), at(MON, "12:00"));
    const text = await renderPage(t.db, await me(), page!);
    expect(text).toContain("v1 (Nov 1): 1 min easy jog, 2 min walk, 3 rounds around the block (headed for: run a mile without stopping by Nov 14) (current)");
    expect(text).toContain("Current plan: headed for: run a mile without stopping by Nov 14;");
  });
});

describe("locking a plan writes day 1's step", () => {
  for (const destination of [null, "run a mile without stopping by Nov 14"]) {
    it(`${destination ? "with" : "without"} a destination; day 1's row holds the plan's step`, async () => {
      const tester = await setup();
      await t.db.delete(plans);
      await t.db.update(testers).set({ phase: "planning" }).where(eq(testers.id, tester.id));
      const step = "1 min jog, 2 min walk, 3 rounds outside";
      await t.db.insert(plans).values({
        testerId: tester.id,
        goalSlug: "exercise",
        status: "draft",
        step,
        destination,
        stepTime: "19:00",
        days: ["mon", "wed", "fri"],
        proof: "screenshot",
        reason: "Builds up.",
        minutes: 15,
      });
      expect(await tool("lock_plan", { commitment: "I'm in", start: "today" }, at(MON, "12:00"), "I'm in!")).toMatchObject({ ok: true });
      const [locked] = await allPlans();
      expect(locked).toMatchObject({ status: "locked", destination });
      expect(await t.db.select().from(stepDays).where(and(eq(stepDays.testerId, tester.id), eq(stepDays.date, MON)))).toMatchObject([
        { step, planId: locked!.id, status: null },
      ]);
      const now = await block(at(MON, "12:01"));
      expect(now).toContain(`Today's step (set, holds for today): "${step}"`);
      if (destination) expect(now).toContain(`headed for: ${destination}`);
      else expect(now).toContain("Destination: none yet");
    });
  }
});
