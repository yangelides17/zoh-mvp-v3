import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoach } from "../src/coach/coach.js";
import { buildStateBlock } from "../src/coach/prompt.js";
import { loadCoachState, loadDaySummary } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { messages, plans, stepDays, takeaways, testers, type Tester } from "../src/db/schema.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { setFocusGoal } from "../src/testers/goals.js";
import { getTester, resetTester, updateTester } from "../src/testers/testers.js";
import { FakeClaudeModel, ME, makeApp, type TestApp } from "./helpers.js";

/** Proof plus reflection, and reinforcement (#77). */

const TZ = "America/New_York";
const SUN = "2026-11-01";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const FRI = "2026-11-06";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);

let t: TestApp;

beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

/** Sam: Mon/Wed/Fri at 7 pm from Monday, locked Sunday noon. */
async function setup(): Promise<Tester> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Sam",
      goalSlug: "exercise",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at(SUN, "10:00"),
      contextStartedAt: at(SUN, "10:00"),
    })
    .returning();
  await t.db.insert(plans).values({
    testerId: tester!.id,
    goalSlug: "exercise",
    status: "locked",
    version: 1,
    step: "1 min easy jog, 2 min walk, 3 rounds around the block",
    stepTime: "19:00",
    days: ["mon", "wed", "fri"],
    proof: "screenshot",
    reason: "Builds up to a mile.",
    minutes: 20,
    startDate: MON,
    commitment: "I'm in",
    lockedAt: at(SUN, "12:00"),
  });
  await setFocusGoal(t.db, tester!.id, "exercise", at(SUN, "12:00"), "remove");
  return tester!;
}

async function say(direction: "inbound" | "outbound", when: Date, content: string, media = false) {
  await t.db.insert(messages).values({
    direction,
    contactNumber: ME,
    content,
    createdAt: when,
    sentAt: when,
    ...(media ? { mediaUrl: "https://cdn.example/strava.png", mediaContentType: "image/png" } : {}),
  });
}

const me = async () => (await getTester(t.db, (await t.db.select().from(testers))[0]!.id))!;
const state = async (now: Date, lastTesterText = "") => loadCoachState(t.db, await me(), { now, isFirstText: false, lastTesterText });
const block = async (now: Date) => buildStateBlock(await state(now));
const tool = async (name: string, input: unknown, now: Date, lastTesterText = "") => runTool(t.db, await state(now, lastTesterText), name, input, now);
const row = async (date: string) => (await t.db.select().from(stepDays).where(eq(stepDays.date, date)))[0];

/** Monday's step done with a Strava screenshot at 7:30 pm. */
async function doneMonday() {
  await say("inbound", at(MON, "19:30"), "", true);
  expect(await tool("mark_step_done", { how: "full", proof: "clear", seen: "Strava run, 1.2 mi" }, at(MON, "19:30"))).toMatchObject({ ok: true });
}

const NEXT = "2 min jog, 1 min walk, 4 rounds on your block at 6:30 pm";

describe("takeaways", () => {
  it("saves with its evidence and day, and shows on the following days with its age", async () => {
    await setup();
    await doneMonday();
    expect(await tool("save_takeaway", { text: "Slow enough to talk is the right pace", evidence: "explained" }, at(MON, "19:45"))).toMatchObject({
      ok: true,
      message: "Takeaway saved (explained): Slow enough to talk is the right pace",
    });
    const tester = await me();
    expect(await t.db.select().from(takeaways)).toMatchObject([
      { testerId: tester.id, goalSlug: "exercise", day: MON, text: "Slow enough to talk is the right pace", evidence: "explained" },
    ]);
    expect(await block(at(MON, "19:50"))).toContain('- today (Mon): "Slow enough to talk is the right pace" (explained)');
    expect(await block(at(TUE, "10:00"))).toContain('- yesterday (Mon): "Slow enough to talk is the right pace" (explained)');

    // A recall two days later is saved too, newest first.
    expect(await tool("save_takeaway", { text: "Slow enough to talk is the right pace", evidence: "recalled" }, at(WED, "18:50"))).toMatchObject({ ok: true });
    const wed = await block(at(WED, "19:00"));
    expect(wed).toContain(
      'Takeaways, newest first (bring one back now and then, or build it into a step; see PROOF):\n- today (Wed): "Slow enough to talk is the right pace" (recalled)\n- 2 days ago (Mon): "Slow enough to talk is the right pace" (explained)',
    );
  });

  it("shows only the last two weeks, and is gone after a reset", async () => {
    await setup();
    await tool("save_takeaway", { text: "Slow enough to talk", evidence: "applied" }, at(MON, "20:00"));
    expect(await block(at("2026-11-16", "10:00"))).toContain('- 14 days ago (Mon): "Slow enough to talk" (applied)');
    expect(await block(at("2026-11-17", "10:00"))).not.toContain("Takeaways");
    await resetTester(t.db, await me(), at(TUE, "10:00"));
    expect(await t.db.select().from(takeaways)).toHaveLength(0);
  });

  it("needs a locked plan and a known evidence type", async () => {
    await setup();
    expect(await tool("save_takeaway", { text: "x", evidence: "guessed" }, at(MON, "20:00"))).toMatchObject({ ok: false });
    await updateTester(t.db, (await me()).id, { phase: "planning" });
    expect(await tool("save_takeaway", { text: "x", evidence: "explained" }, at(MON, "20:00"))).toMatchObject({ ok: false, error: "No locked plan yet." });
  });
});

describe("reflection", () => {
  it("a day with proof and no reflection is still done, and the streak is the same with or without one", async () => {
    const tester = await setup();
    await doneMonday();
    expect(await row(MON)).toMatchObject({ status: "done", reflection: null });
    const without = await loadDaySummary(t.db, tester.id, "exercise", MON);
    expect(without.streak).toBe(1);

    expect(await tool("save_reflection", { summary: "Second round was way easier once they slowed down" }, at(MON, "19:40"))).toMatchObject({ ok: true });
    expect(await row(MON)).toMatchObject({ status: "done", reflection: "Second round was way easier once they slowed down" });
    expect(await loadDaySummary(t.db, tester.id, "exercise", MON)).toEqual(without);
  });

  it("the state shows today's reflection, and each recent day's, so the next step builds on it", async () => {
    await setup();
    await doneMonday();
    expect(await block(at(MON, "19:31"))).toContain("Today's reflection: none yet.");
    await tool("save_reflection", { summary: "Easier when slower" }, at(MON, "19:40"));
    expect(await block(at(MON, "19:41"))).toContain('Today\'s reflection: "Easier when slower".');
    expect(await block(at(WED, "09:00"))).toContain(`- Mon ${MON}, done: the plan's step (proof: Strava run, 1.2 mi; reflection: Easier when slower)`);
  });

  it("yesterday's reflection goes on yesterday's row; a reflection alone never closes a day", async () => {
    await setup();
    await tool("save_reflection", { summary: "Too tired, work ran late", day: "yesterday" }, at(TUE, "09:00"));
    expect(await row(MON)).toMatchObject({ reflection: "Too tired, work ran late", status: null });
  });

  it("counts ZOH's texts since their proof today, for the soft wrap-up around the fifth", async () => {
    await setup();
    await say("outbound", at(MON, "18:50"), "Starts in 10, Sam!");
    await doneMonday();
    expect(await block(at(MON, "19:30"))).toContain("This reply is your 1st text since their proof today: if they're into it, follow up and keep the next step for the wrap-up; a short reply that's all they've got: wrap up now.");
    for (const [i, hhmm] of ["19:31", "19:34", "19:38", "19:42"].entries()) {
      await say("outbound", at(MON, hhmm), `reply ${i}`);
      await say("inbound", at(MON, hhmm.replace(/.$/, "9")), "more");
    }
    expect(await block(at(MON, "19:50"))).toContain("This reply is your 5th text since their proof today: start wrapping up unless they're clearly still going, then the next step.");
    // A text ZOH starts isn't part of the exchange.
    const nudge = buildStateBlock(await loadCoachState(t.db, await me(), { now: at(MON, "19:50"), isFirstText: false, nudgeMoment: "followup" }));
    expect(nudge).not.toContain("since their proof");
  });
});

describe("the next step, agreed at the wrap-up", () => {
  it("is saved for the next step day across a rest day, and that morning the kickoff reminds instead of re-asking", async () => {
    await setup();
    await doneMonday();
    expect(await tool("set_today_step", { kind: "same", step: NEXT, day: "next" }, at(MON, "19:50"))).toMatchObject({ ok: true, message: `Step for ${WED} saved: ${NEXT}.` });
    expect(await block(at(MON, "19:51"))).toContain(`Next step day: Wed ${WED}. Its step is already set: "${NEXT}", not agreed yet.`);
    expect(await tool("set_today_step", { kind: "same", step: NEXT, day: "next", agreed: true }, at(MON, "19:55"), "let's go")).toMatchObject({
      ok: true,
      message: `Step for ${WED} saved, agreed: ${NEXT}.`,
    });
    expect(await row(TUE)).toBeUndefined();
    expect(await row(WED)).toMatchObject({ step: NEXT, agreedAt: at(MON, "19:55"), status: null });
    expect(await block(at(MON, "20:00"))).toContain(`Its step is already set: "${NEXT}", and they said yes (Mon 7:55 PM).`);

    const wed = await block(at(WED, "09:00"));
    expect(wed).toContain(`Today's step (set, holds for today): "${NEXT}"`);
    expect(wed).toContain("They said yes to today's step ahead of time (Mon 7:55 PM): the kickoff reminds them of it (with any tip) and asks nothing");

    // The kickoff that morning writes with that state.
    const model = new FakeClaudeModel("Morning Sam! 2 on, 1 off, 4 rounds tonight at 6:30. Same rule: slow enough to talk.");
    const coach = createCoach({ db: t.db, model, voice: "v" });
    await coach.nudge!({ tester: await me(), turns: [], now: at(WED, "09:00"), moment: "kickoff" });
    expect(model.stateOf()).toContain("ahead of time (Mon 7:55 PM): the kickoff reminds them of it");
  });

  it("without a yes, that morning's state has no reminder: the kickoff presents and asks as usual", async () => {
    await setup();
    await doneMonday();
    await tool("set_today_step", { kind: "same", step: NEXT, day: "next" }, at(MON, "19:50"));
    const wed = await block(at(WED, "09:00"));
    expect(wed).toContain(`Today's step (set, holds for today): "${NEXT}"`);
    expect(wed).not.toContain("ahead of time");
  });

  it("a yes the same day is settled as before (#42)", async () => {
    await setup();
    await tool("set_today_step", { kind: "same", step: NEXT, agreed: true }, at(WED, "08:30"), "yes");
    expect(await block(at(WED, "08:31"))).toContain("They said yes to today's step (Wed 8:30 AM): it's settled.");
  });
});
