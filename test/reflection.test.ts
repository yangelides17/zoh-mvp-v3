import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoach, NOT_SENT_NOTE } from "../src/coach/coach.js";
import { buildStateBlock, NUDGES, partsFor, PROOF, TODAYS_STEP } from "../src/coach/prompt.js";
import { loadCoachState, loadDaySummary } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { messages, nudges, plans, stepDays, takeaways, testers, type Tester } from "../src/db/schema.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { setFocusGoal } from "../src/testers/goals.js";
import { getTester, resetTester, updateTester } from "../src/testers/testers.js";
import { createNudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { FakeClaudeModel, LINE, ME, inboundEvent, makeApp, makeDb, postWebhook, type TestApp } from "./helpers.js";

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

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
const tool = async (name: string, input: unknown, now: Date, lastTesterText = "") =>
  runTool(t.db, await state(now, lastTesterText), name, input, now);
const row = async (date: string) => (await t.db.select().from(stepDays).where(eq(stepDays.date, date)))[0];

/** Monday's step done with a Strava screenshot at 7:30 pm. */
async function doneMonday() {
  await say("inbound", at(MON, "19:30"), "", true);
  expect(await tool("mark_step_done", { how: "full", proof: "clear", seen: "Strava run, 1.2 mi" }, at(MON, "19:30"))).toMatchObject({ ok: true });
}

const NEXT = "2 min jog, 1 min walk, 4 rounds on your block at 6:30 pm";
/** #211: what the next step's own section opens with, to tell whether a reply read it. */
const NEXT_STEP_GUIDANCE = "THE NEXT STEP (no reflection open";

/**
 * #131, #157: a reflection that's run its course in earlier replies, so a proposal after it isn't early: how it went
 * and what went well (7:32), then one question deeper on something they said, answered (7:34).
 */
async function reflected() {
  await say("outbound", at(MON, "19:31"), "Nice! How did it feel?");
  await say("inbound", at(MON, "19:32"), "harder than I thought, the hill in round 3. but slowing down on the flat parts worked");
  await tool(
    "save_reflection",
    { summary: "Hill in round 3 was hard; slowing on the flats worked", how_it_went: true, went_well: "Slowing down on the flats kept them going", take: "Full step, hill was hard." },
    at(MON, "19:32"),
  );
  await say("outbound", at(MON, "19:33"), "What happened on the hill?");
  await say("inbound", at(MON, "19:34"), "I sprinted the start of it and ran out of gas halfway");
  // #211: ZOH lands it once it understands what happened, which opens the next step.
  const landed = await tool(
    "save_reflection",
    { summary: "Sprinted the hill's start, gassed halfway; slowing on the flats worked", how_it_went: true, take: "Pacing on hills is the gap.", landed: "Pacing is the gap: sprinting the hill's start gassed them" },
    at(MON, "19:34"),
  );
  expect(landed).toMatchObject({ ok: true, message: expect.stringContaining("landed") });
}


describe("takeaways", () => {
  it("saves with its evidence and day, and shows on the following days with its age", async () => {
    await setup();
    await doneMonday();
    expect(await tool("save_takeaway", { text: "Slow enough to talk is the right pace", evidence: "explained" }, at(MON, "19:45"))).toMatchObject({
      ok: true,
      message: expect.stringContaining("takeaway (explained): Slow enough to talk is the right pace"),
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
      'Takeaways, newest first:\n- today (Wed): "Slow enough to talk is the right pace" (recalled)\n- 2 days ago (Mon): "Slow enough to talk is the right pace" (explained)',
    );
    // #199: bringing one back or building it into a step is PROOF's and TODAY'S STEP's guidance, not the sheet's.
    expect(PROOF).toContain("Recall: now and then, about 1, 3 and 7 days on, bring one back in a check-in or the conversation");
    expect(TODAYS_STEP).toContain("Build an earlier takeaway in when it fits (about 1, 3 and 7 days on)");
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

    expect(await tool("save_reflection", { summary: "Second round was way easier once they slowed down", how_it_went: true, take: "Did the full step, found it easy." }, at(MON, "19:40"))).toMatchObject({ ok: true });
    expect(await row(MON)).toMatchObject({ status: "done", reflection: "Second round was way easier once they slowed down" });
    expect(await loadDaySummary(t.db, tester.id, "exercise", MON)).toEqual(without);
  });

  it("the state shows today's reflection, and each recent day's, so the next step builds on it", async () => {
    await setup();
    await doneMonday();
    expect(await block(at(MON, "19:31"))).toContain("Today's reflection: none yet.");
    expect(await block(at(MON, "19:31"))).toContain(
      "They haven't said how it went for them yet.",
    );
    await tool("save_reflection", { summary: "Easier when slower", how_it_went: true, take: "Slowed down, felt good." }, at(MON, "19:40"));
    expect(await block(at(MON, "19:41"))).toContain('Today\'s reflection: "Easier when slower". They\'ve said how it went for them.');
    expect(await block(at(WED, "09:00"))).toContain(`- Mon ${MON}, done: the plan's step (proof: Strava run, 1.2 mi; reflection: Easier when slower)`);
  });

  it("yesterday's reflection goes on yesterday's row; a reflection alone never closes a day", async () => {
    await setup();
    await tool("save_reflection", { summary: "Too tired, work ran late", how_it_went: true, in_the_way: "work ran late", take: "Missed it after a long day.", day: "yesterday" }, at(TUE, "09:00"));
    expect(await row(MON)).toMatchObject({ reflection: "Too tired, work ran late", status: null, inTheWay: "work ran late" });
  });

  it("counts ZOH's texts since their proof today: no fixed wrap-up at the fifth, a safety net at the eighth (#93)", async () => {
    await setup();
    await say("outbound", at(MON, "18:50"), "Starts in 10, Sam!");
    await doneMonday();
    expect(await block(at(MON, "19:30"))).toContain("This reply is your 1st text since their proof today.");
    // They said how it went early, so the talk runs on its content, not a count.
    await tool("save_reflection", { summary: "Felt easy, slower pace helped", how_it_went: true, take: "Easy, wants more." }, at(MON, "19:30"));
    const times = ["19:31", "19:33", "19:35", "19:37", "19:41", "19:43", "19:45"];
    for (const [i, hhmm] of times.entries()) {
      await say("outbound", at(MON, hhmm), `reply ${i}`);
      await say("inbound", at(MON, hhmm.replace(/.$/, "9")), "more");
      if (i === 3) expect(await block(at(MON, "19:39"))).toContain("This reply is your 5th text since their proof today.");
    }
    // #199: the sheet says it's long (a fact); wrapping up is PROOF's guidance, with its reason.
    expect(await block(at(MON, "19:50"))).toContain("This reply is your 8th text since their proof today. That's a long talk, past the usual length of a reflection.");
    expect(PROOF).toContain("A talk the state calls long is time to wrap up, since their time matters as much as the talk");
    // A text ZOH starts isn't part of the exchange.
    const nudge = buildStateBlock(await loadCoachState(t.db, await me(), { now: at(MON, "19:50"), isFirstText: false, nudgeMoment: "followup" }));
    expect(nudge).not.toContain("since their proof");
  });
});

describe("reflection probes thin answers and waits before the next step (#131)", () => {
  /** Proof at 7:30, ZOH's first text at 7:31, then each tester reply answered two minutes later. */
  async function talk(replies: number) {
    await say("outbound", at(MON, "18:50"), "Starts in 10, Sam!");
    await doneMonday();
    await say("outbound", at(MON, "19:31"), "Nice! How did it feel?");
    for (let i = 0; i < replies; i++) {
      await say("inbound", at(MON, `19:3${2 + i * 2}`), "okay");
      if (i < replies - 1) await say("outbound", at(MON, `19:3${3 + i * 2}`), "What made it okay?");
    }
  }
  it("#157: the state says what has happened, as facts; how to talk is the voice page's job", async () => {
    await setup();
    await talk(1);
    // "okay" is saved as thin: the coach marks how it went false (tool description), so it isn't said.
    expect(await tool("save_reflection", { summary: 'Said it felt "okay"', how_it_went: false, take: "Thin so far." }, at(MON, "19:32"))).toMatchObject({ ok: true });
    expect(await row(MON)).toMatchObject({ reflection: 'Said it felt "okay"', howItWentSaid: false });
    const thin = await block(at(MON, "19:32"));
    expect(thin).toContain('Today\'s reflection: "Said it felt "okay"". They haven\'t said how it went for them yet. This reply is your 2nd text since their proof today.');
    await tool("save_reflection", { summary: "Okay, but the hill in round 2 was brutal", how_it_went: true, take: "Hill was hard." }, at(MON, "19:33"));
    const real = (await block(at(MON, "19:33"))).split("\n").find((l) => l.includes("Today's reflection:"))!;
    expect(real).toContain("They've said how it went for them.");
    // No orders about what to ask or when to move on, and no checklist to fish from.
    for (const order of ["ask ", "find out", "wrap up warmly", "follow what they just said", "Covered so far", "Before the next step"]) expect(real).not.toContain(order);
  });

  it("a next step is agreed only after it's been shown: never in the reply that first saves it", async () => {
    await setup();
    await doneMonday();
    await reflected();
    // Talk of tomorrow before any proposal ("I'd keep it to 20 minutes"): saving it as agreed is refused.
    const first = await tool("set_today_step", { step: NEXT, kind: "same", day: "next", agreed: true }, at(MON, "19:40"));
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining(`They haven't seen a step for ${WED} yet`) });
    expect(await row(WED)).toBeUndefined();
    // Proposed (saved without agreed) in this reply, then agreed in the same reply: still refused.
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next" }, at(MON, "19:41"))).toMatchObject({ ok: true });
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next", agreed: true }, at(MON, "19:41"))).toMatchObject({ ok: false });
    expect(await row(WED)).toMatchObject({ step: NEXT, agreedAt: null });
    // Their yes in a later reply: agreed.
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next", agreed: true }, at(MON, "19:45"))).toMatchObject({ ok: true });
    expect((await row(WED))?.agreedAt).toEqual(at(MON, "19:45"));
  });

  it("a version they adjust after seeing it is agreed", async () => {
    await setup();
    await doneMonday();
    await reflected();
    await tool("set_today_step", { step: NEXT, kind: "same", day: "next" }, at(MON, "19:41"));
    const adjusted = "2 min jog, 1 min walk, 3 rounds on your block at 6:30 pm";
    const asked = "can we do 3 rounds instead of 4?";
    expect(await tool("set_today_step", { step: adjusted, kind: "same", day: "next", agreed: true, asked }, at(MON, "19:45"), asked)).toMatchObject({ ok: true });
    expect(await row(WED)).toMatchObject({ step: adjusted, agreedAt: at(MON, "19:45") });
  });
});

describe("reflection that gets to know them (#93)", () => {
  it("how it went is marked only when they said it; a lesson alone isn't, and once said it stays said", async () => {
    await setup();
    await doneMonday();
    // A lesson recap alone: saved, but how it went is still unsaid.
    expect(await tool("save_reflection", { summary: "Learned slow is the trick", how_it_went: false, take: "Lesson only so far." }, at(MON, "19:35"))).toMatchObject({ ok: true });
    expect(await row(MON)).toMatchObject({ status: "done", howItWentSaid: false, reflection: "Learned slow is the trick", coachTake: "Lesson only so far." });
    // The talk deepens: they say how it felt.
    await tool("save_reflection", { summary: "Slow is the trick; felt easy, wants a 4th round", how_it_went: true, take: "Did the full step, found it easy, wants more." }, at(MON, "19:40"));
    expect(await row(MON)).toMatchObject({ howItWentSaid: true, coachTake: "Did the full step, found it easy, wants more." });
    // A later, fuller line without it doesn't unsay it.
    await tool("save_reflection", { summary: "Slow is the trick; felt easy; 4 rounds next", how_it_went: false, take: "Ready for more." }, at(MON, "19:45"));
    expect(await row(MON)).toMatchObject({ howItWentSaid: true, reflection: "Slow is the trick; felt easy; 4 rounds next" });
    // how_it_went and take are required: the coach has to decide.
    expect(await tool("save_reflection", { summary: "x" }, at(MON, "19:46"))).toMatchObject({ ok: false });
  });

  it("a done day without any reflection stays done", async () => {
    await setup();
    await doneMonday();
    expect(await row(MON)).toMatchObject({ status: "done", reflection: null, howItWentSaid: false });
    expect(await block(at(TUE, "10:00"))).toContain(`- Mon ${MON}, done`);
  });

  it("ZOH's take never reaches the coach's state or a text", async () => {
    await setup();
    await doneMonday();
    const take = "FOUNDERS-ONLY: coasting, step too small.";
    await tool("save_reflection", { summary: "Easy one", how_it_went: true, take }, at(MON, "19:40"));
    expect((await state(at(MON, "19:41"))).todayRow?.coachTake).toBeNull();
    expect(await block(at(MON, "19:41"))).not.toContain("FOUNDERS-ONLY");
    expect(await block(at(WED, "09:00"))).not.toContain("FOUNDERS-ONLY");

  });

  it("end to end through the real coach: the take is saved, and never in a later state block or a text", async () => {
    await t.close();
    const model = new FakeClaudeModel();
    // #133: a fixed Monday evening clock; on the real clock the reflection lands on whatever today is.
    t = await makeApp({ replier: createCoach({ db: (await makeDb()).db, model }), now: () => at(MON, "19:40") });
    await setup();
    await doneMonday();
    const take = "FOUNDERS-ONLY: coasting, step too small.";
    model.script({ tools: [{ name: "save_reflection", input: { summary: "Easy", how_it_went: true, take } }] }, "Love it. Four rounds Wednesday?");
    await postWebhook(t, inboundEvent({ content: "felt easy honestly", from_number: ME, number: ME }));
    await t.queue.idle();
    expect(await row(MON)).toMatchObject({ coachTake: take, howItWentSaid: true });
    expect(model.requests).toHaveLength(2);
    for (let i = 0; i < model.requests.length; i++) expect(model.stateOf(i)).not.toContain("FOUNDERS-ONLY");
    const out = await t.db.select().from(messages).where(eq(messages.direction, "outbound"));
    expect(out.map((m) => m.content)).toEqual(["Love it. Four rounds Wednesday?"]);
  });

  it("no text is ever sent to chase a reflection", async () => {
    await setup();
    await doneMonday();
    const scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME], lineNumber: LINE });
    // The rest of Monday evening after the done day with no reflection: nothing goes out.
    for (let ms = at(MON, "19:31").getTime(); ms <= at(MON, "23:59").getTime(); ms += 5 * 60_000) await scheduler.tick(new Date(ms));
    expect(t.sendblue.sends).toHaveLength(0);
    // Tuesday is a rest day: whatever goes out is the rest-day text, never about Monday's reflection.
    for (let ms = at(TUE, "08:00").getTime(); ms <= at(TUE, "22:00").getTime(); ms += 5 * 60_000) await scheduler.tick(new Date(ms));
    expect(t.replier.nudges.map((n) => n.moment).every((m) => m === "rest_day")).toBe(true);
  });

  it("yesterday's step done with no word on how it went: picked up in a line when they text, never in a text ZOH starts", async () => {
    await setup();
    await doneMonday();
    // #199: the sheet states it; picking it up in a line, once, never chased, is PROOF's guidance.
    expect(await block(at(TUE, "10:00"))).toContain("Yesterday's step was done with no word yet on how it went.");
    expect(PROOF).toContain("Yesterday's step done with no word yet on how it went (state): you may pick it up in a line when they text, once (save_reflection day yesterday); never chase it");
    const nudge = buildStateBlock(await loadCoachState(t.db, await me(), { now: at(TUE, "10:00"), isFirstText: false, nudgeMoment: "rest_day" }));
    expect(nudge).not.toContain("Yesterday's step was done");
    // Once they've said, or for a day from before it was recorded, nothing.
    await t.db.update(stepDays).set({ howItWentSaid: null }).where(eq(stepDays.date, MON));
    expect(await block(at(TUE, "10:00"))).not.toContain("Yesterday's step was done");
    await t.db.update(stepDays).set({ howItWentSaid: true }).where(eq(stepDays.date, MON));
    expect(await block(at(TUE, "10:00"))).not.toContain("Yesterday's step was done");
  });

  it("the next step's reason is saved with it", async () => {
    await setup();
    await doneMonday();
    await reflected();
    await tool("set_today_step", { kind: "harder", step: NEXT, day: "next", reason: "Said 3 rounds felt easy and wants more" }, at(MON, "19:50"));
    expect(await row(WED)).toMatchObject({ step: NEXT, nextReason: "Said 3 rounds felt easy and wants more" });
  });
});

describe("the next step, agreed at the wrap-up", () => {
  it("is saved for the next step day across a rest day, and that morning the kickoff reminds and checks they're still in (#92)", async () => {
    await setup();
    await doneMonday();
    await reflected();
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
    // #199: the sheet states the yes came ahead; reminding and checking they're still in is the kickoff's guidance (NUDGES).
    expect(wed).toContain("They said yes to it ahead of time, on an earlier day (Mon 7:55 PM).");
    expect(NUDGES).toContain("still in when they agreed ahead (state): then remind them of it, with any tip, and end by asking if they're still in, in words that show they already said yes, never a first-time \"you in?\"");
    expect(wed).not.toContain("asks nothing");

    // The kickoff that morning writes with that state.
    const model = new FakeClaudeModel("Morning Sam! 2 on, 1 off, 4 rounds tonight at 6:30. Same rule: slow enough to talk.");
    const coach = createCoach({ db: t.db, model, voice: "v" });
    await coach.nudge!({ tester: await me(), turns: [], now: at(WED, "09:00"), moment: "kickoff" });
    expect(model.stateOf()).toContain("They said yes to it ahead of time, on an earlier day (Mon 7:55 PM)");
  });

  it("a changed step without a new yes is asked fresh; with a yes it stays agreed (#92)", async () => {
    await setup();
    await doneMonday();
    await reflected();
    await tool("set_today_step", { kind: "same", step: NEXT, day: "next", agreed: true }, at(MON, "19:55"), "let's go");
    const CHANGED = "2 min jog, 1 min walk, 3 rounds at the park at 7 pm";
    await tool("set_today_step", { kind: "same", step: CHANGED, day: "next", asked: "can we keep it at 3 rounds" }, at(MON, "20:10"), "can we keep it at 3 rounds");
    expect(await row(WED)).toMatchObject({ step: CHANGED, agreedAt: null });
    expect(await block(at(WED, "09:00"))).not.toContain("ahead of time");

    await tool("set_today_step", { kind: "same", step: NEXT, day: "next", agreed: true, asked: "actually 4 is fine, let's do it" }, at(MON, "20:20"), "actually 4 is fine, let's do it");
    expect(await row(WED)).toMatchObject({ step: NEXT, agreedAt: at(MON, "20:20") });
    // The same step saved again without a yes keeps the yes.
    await tool("set_today_step", { kind: "same", step: NEXT, day: "next" }, at(MON, "20:30"));
    expect(await row(WED)).toMatchObject({ step: NEXT, agreedAt: at(MON, "20:20") });
  });

  it("without a yes, that morning's state has no reminder: the kickoff presents and asks as usual", async () => {
    await setup();
    await doneMonday();
    await reflected();
    await tool("set_today_step", { kind: "same", step: NEXT, day: "next" }, at(MON, "19:50"));
    const wed = await block(at(WED, "09:00"));
    expect(wed).toContain(`Today's step (set, holds for today): "${NEXT}"`);
    expect(wed).not.toContain("ahead of time");
  });

  it("a yes the same day is settled as before (#42)", async () => {
    await setup();
    await tool("set_today_step", { kind: "same", step: NEXT, agreed: true }, at(WED, "08:30"), "yes");
    // #199: "settled" is the fact; not re-saying it is TODAY'S STEP's guidance.
    expect(await block(at(WED, "08:31"))).toContain("They said yes to it today (Wed 8:30 AM): settled.");
    expect(TODAYS_STEP).toContain("Once they've said yes (settled), don't re-say it or its proof, or ask if they're still on");
  });
});

describe("what a reply can and can't record", () => {
  it("#157: an empty optional line doesn't fail the save (it would leave the state behind and hold the step)", async () => {
    await setup();
    await doneMonday();
    const saved = await tool("save_reflection", { summary: "20 min, about right", how_it_went: true, in_the_way: "", went_well: " ", take: "Short answers." }, at(MON, "19:33"));
    expect(saved).toMatchObject({ ok: true });
    expect(await row(MON)).toMatchObject({ howItWentSaid: true, inTheWay: null, wentWell: null });
  });

  it("risk: text written in a refused round is never sent, and a yes to a step they never saw never counts", async () => {
    await t.close();
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db: (await makeDb()).db, model }), now: () => at(MON, "19:34") });
    await setup();
    await doneMonday();
    await say("outbound", at(MON, "19:31"), "Nice! Which part felt most awkward?");
    // Round 1 writes tomorrow's step and saves it as agreed in the same reply (refused: they haven't seen it);
    // round 2 is the reply that goes out.
    model.script(
      {
        text: "That worry makes sense. Tomorrow: add an easy-out line to the draft, you're set.",
        tools: [{ name: "set_today_step", input: { step: "Add an easy-out line to the Alex draft at 6:30 pm", kind: "same", day: "next", agreed: true } }],
      },
      "That makes sense. What about asking for his time feels like bothering him?",
    );
    await postWebhook(t, inboundEvent({ content: "Asking for his time. I worry I'm bothering him.", from_number: ME, number: ME }));
    await t.queue.idle();
    const out = await t.db.select().from(messages).where(eq(messages.direction, "outbound"));
    expect(out.map((m) => m.content).at(-1)).toBe("That makes sense. What about asking for his time feels like bothering him?");
    expect(out.map((m) => m.content)).not.toContain("That worry makes sense. Tomorrow: add an easy-out line to the draft, you're set.");
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain(NOT_SENT_NOTE);
    expect(await row(WED)).toBeUndefined();
  });
});

describe("#160: what each step shows they can now do, and gaps", () => {
  it("saves can-do and gaps with the reflection, and a later save without them keeps them", async () => {
    await setup();
    await doneMonday();
    const saved = await tool(
      "save_reflection",
      { summary: "Ran all 3 rounds; the hill gassed them", how_it_went: true, can_do: "Jog 1 min without stopping, 3 rounds", gaps: "Pacing on the hill", take: "Full step." },
      at(MON, "19:33"),
    );
    expect(saved).toMatchObject({ ok: true });
    expect(await row(MON)).toMatchObject({ canDo: "Jog 1 min without stopping, 3 rounds", gaps: "Pacing on the hill" });
    await tool("save_reflection", { summary: "Hill was hard, slowing on the flats worked", how_it_went: true, take: "Full step." }, at(MON, "19:36"));
    expect(await row(MON)).toMatchObject({ canDo: "Jog 1 min without stopping, 3 rounds", gaps: "Pacing on the hill" });
  });

  it("gaps show on that day in ZOH's recent step days; can-do stays off the sheet (the recap's 'can do' is applied or recalled lessons only)", async () => {
    await setup();
    await doneMonday();
    await tool(
      "save_reflection",
      { summary: "Ran all 3 rounds; the hill gassed them", how_it_went: true, can_do: "Jog 1 min without stopping", gaps: "Pacing on the hill", take: "Full step." },
      at(MON, "19:33"),
    );
    const tue = await block(at(TUE, "10:00"));
    expect(tue).toMatch(/- Mon 2026-11-02, done: [^\n]*gaps: Pacing on the hill/);
    expect(tue).not.toContain("Jog 1 min without stopping");
  });

  it("no word on what they learned never holds the next step", async () => {
    await setup();
    await doneMonday();
    await tool("save_reflection", { summary: "Felt good, a bit tired", how_it_went: true, take: "Full step." }, at(MON, "19:33"));
    await say("outbound", at(MON, "19:34"), "What kind of tired?");
    await say("inbound", at(MON, "19:35"), "the good kind, I slept badly last night");
    // #211: it lands on how it felt alone: nothing about what they learned is required.
    await tool("save_reflection", { summary: "Felt good, tired from bad sleep", how_it_went: true, take: "Full step.", landed: "Felt good; tired from bad sleep, not the step" }, at(MON, "19:35"));
    await say("outbound", at(MON, "19:36"), `Wednesday: ${NEXT}. Work for you?`);
    expect(await tool("set_today_step", { step: NEXT, kind: "harder", day: "next", reason: "Felt good" }, at(MON, "19:37"))).toMatchObject({ ok: true });
    expect(await row(WED)).toMatchObject({ step: NEXT });
  });
});

describe("#211: reflect before the next step", () => {
  /** The real coach on a scripted model, answering their text at `now`. */
  async function coachAt(now: Date): Promise<FakeClaudeModel> {
    await t.close();
    const model = new FakeClaudeModel();
    t = await makeApp({ replier: createCoach({ db: (await makeDb()).db, model }), now: () => now });
    return model;
  }
  async function text(content: string) {
    await postWebhook(t, inboundEvent({ content, from_number: ME, number: ME }));
    await t.queue.idle();
  }

  it("bug: in the reply to their first real answer, tomorrow's step isn't saved", async () => {
    const model = await coachAt(at(MON, "19:33"));
    await setup();
    await doneMonday();
    await say("outbound", at(MON, "19:31"), "Nice! How did it feel?");
    model.script(
      {
        tools: [
          { name: "save_reflection", input: { summary: "Hill in round 3 was hard", how_it_went: true, take: "Full step." } },
          { name: "set_today_step", input: { step: NEXT, kind: "same", day: "next", reason: "Hill was hard" } },
        ],
      },
      "What happened on the hill?",
    );
    await text("harder than I thought, the hill in round 3 was rough");
    expect(await row(WED)).toBeUndefined();
    // Nothing in that reply pointed at tomorrow: no next-step guidance, no "Next step day" line.
    for (const req of model.requests) {
      expect(JSON.stringify(req)).not.toContain(NEXT_STEP_GUIDANCE);
      expect(JSON.stringify(req)).not.toContain("Next step day:");
    }
  });

  /** Proof at 7:30, celebrated at 7:31, their first real answer at 7:32 (saved), ZOH's follow-up at 7:33. */
  async function answered() {
    await setup();
    await doneMonday();
    await say("outbound", at(MON, "19:31"), "Nice! How did it feel?");
    await say("inbound", at(MON, "19:32"), "harder than I thought, the hill in round 3 was rough");
    await tool("save_reflection", { summary: "Hill in round 3 was hard", how_it_went: true, take: "Full step." }, at(MON, "19:32"));
    await say("outbound", at(MON, "19:33"), "What happened on the hill?");
  }

  it("once the follow-up is answered, landing it opens the next step in that same reply, with its reason saved", async () => {
    const model = await coachAt(at(MON, "19:35"));
    await answered();
    model.script(
      { tools: [{ name: "save_reflection", input: { summary: "Sprinted the hill's start and gassed", how_it_went: true, take: "Pacing.", landed: "Pacing is the gap: they sprint the hill's start" } }] },
      { tools: [{ name: "set_today_step", input: { step: NEXT, kind: "same", day: "next", reason: "Pace the hill" } }] },
      `That's the whole thing. Wednesday: ${NEXT}. Work for you?`,
    );
    await text("I sprinted the start of it and ran out of gas halfway");
    expect(JSON.stringify(model.requests[0])).not.toContain(NEXT_STEP_GUIDANCE);
    expect(JSON.stringify(model.requests[1])).toContain(NEXT_STEP_GUIDANCE);
    expect(await row(WED)).toMatchObject({ step: NEXT });
    expect(await row(MON)).toMatchObject({ landedReason: "Pacing is the gap: they sprint the hill's start", landedBy: "understood", landedAt: at(MON, "19:35") });
  });

  it("both in one round: the next step goes through only after the landing", async () => {
    const model = await coachAt(at(MON, "19:35"));
    await answered();
    const land = { name: "save_reflection", input: { summary: "Gassed on the hill", how_it_went: true, take: "Pacing.", landed: "Pacing is the gap" } };
    const step = { name: "set_today_step", input: { step: NEXT, kind: "same", day: "next" } };
    model.script({ tools: [step, land] }, "What made you sprint it?");
    await text("I sprinted the start of it and ran out of gas halfway");
    expect(await row(WED)).toBeUndefined();
    expect(JSON.stringify(model.requests[1])).toContain("save_reflection landed first");
    // The other order, in a later reply: landed, then the step.
    await t.db.update(stepDays).set({ landedAt: null, landedReason: null, landedBy: null }).where(eq(stepDays.date, MON));
    model.script({ tools: [land, step] }, `Wednesday: ${NEXT}. Work for you?`);
    await text("I think I just wanted to get it over with");
    expect(await row(WED)).toMatchObject({ step: NEXT });
  });

  it("landing before a follow-up is answered is refused, without naming what's missing; a redone reply can't skip it", async () => {
    await setup();
    await doneMonday();
    await say("outbound", at(MON, "19:31"), "Nice! How did it feel?");
    await say("inbound", at(MON, "19:32"), "harder than I thought, the hill in round 3 was rough");
    const early = await tool("save_reflection", { summary: "Hill was hard", how_it_went: true, take: "Full step.", landed: "Hill was hard" }, at(MON, "19:32"));
    expect(early).toMatchObject({ ok: true, message: expect.stringContaining("It stays open") });
    if (early.ok) for (const field of ["how_it_went", "went_well", "in_the_way", "differently"]) expect(early.message).not.toContain(field);
    expect(await row(MON)).toMatchObject({ landedAt: null, reflection: "Hill was hard" });
    // They text again before that reply went out: the redone reply still comes before any follow-up was answered.
    await say("inbound", at(MON, "19:33"), "like really rough");
    expect(await tool("save_reflection", { summary: "Hill was really rough", how_it_went: true, take: "Full step.", landed: "Hill was hard" }, at(MON, "19:33"))).toMatchObject({
      message: expect.stringContaining("It stays open"),
    });
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next" }, at(MON, "19:33"))).toMatchObject({ ok: false });
  });

  it("proof that already said how it went: the answer to the celebration's question can land it", async () => {
    await setup();
    await doneMonday();
    await tool("save_reflection", { summary: "Felt easy, wants more", how_it_went: true, take: "Easy." }, at(MON, "19:30"));
    await say("outbound", at(MON, "19:31"), "Easy already! What made it feel easy this time?");
    await say("inbound", at(MON, "19:33"), "slowing down on the flats");
    expect(await tool("save_reflection", { summary: "Easy; slowing on the flats", how_it_went: true, take: "Easy.", landed: "Slowing on the flats made it easy" }, at(MON, "19:33"))).toMatchObject({
      message: expect.stringContaining("landed"),
    });
  });

  it("their own words wanting to wrap up land it at once; a stray phrase or words they didn't say don't", async () => {
    await setup();
    await doneMonday();
    await say("outbound", at(MON, "19:31"), "Nice! How did it feel?");
    const save = (exit: string, said: string, hhmm: string) => tool("save_reflection", { summary: "Felt good", how_it_went: true, take: "Rushed.", exit }, at(MON, hhmm), said);
    expect(await save("felt good", "felt good, a bit tired", "19:32")).toMatchObject({ message: expect.stringContaining("It stays open") });
    expect(await save("let's move on", "felt good, a bit tired", "19:32")).toMatchObject({ message: expect.stringContaining("It stays open") });
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next" }, at(MON, "19:32"))).toMatchObject({ ok: false });
    expect(await save("gotta run, what's next", "felt good but gotta run, what's next?", "19:32")).toMatchObject({ message: expect.stringContaining("landed") });
    expect(await row(MON)).toMatchObject({ landedBy: "exit", landedReason: "gotta run, what's next" });
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next" }, at(MON, "19:32"))).toMatchObject({ ok: true });
  });

  it("a sign-off that is their whole text is an exit", async () => {
    await setup();
    await doneMonday();
    await say("outbound", at(MON, "19:31"), "Nice! How did it feel?");
    expect(await tool("save_reflection", { summary: "Signed off", how_it_went: false, take: "Signed off.", exit: "night" }, at(MON, "19:32"), "night!")).toMatchObject({
      message: expect.stringContaining("landed"),
    });
  });

  it("thin answers close it at ZOH's 4th text, counted from done (an unclear-proof talk before doesn't count)", async () => {
    await setup();
    await say("inbound", at(MON, "19:00"), "", true);
    await tool("proof_unclear", { verdict: "unclear", seen: "a blurry screen" }, at(MON, "19:00"));
    await say("outbound", at(MON, "19:01"), "Can't make that one out, another shot?");
    await say("outbound", at(MON, "19:03"), "Still blurry, one more?");
    await doneMonday();
    expect(await block(at(MON, "19:30"))).toContain("This reply is your 1st text since their proof today.");
    for (const hhmm of ["19:31", "19:33"]) {
      await say("outbound", at(MON, hhmm), "What made it okay?");
      await say("inbound", at(MON, hhmm.replace(/.$/, "2")), "ok");
    }
    // ZOH's 3rd text since done (the two before it don't count): still open.
    expect((await state(at(MON, "19:34"))).reflection).toMatchObject({ open: true });
    await say("outbound", at(MON, "19:35"), "What made it okay?");
    await say("inbound", at(MON, "19:36"), "ok");
    expect((await state(at(MON, "19:36"))).reflection).toMatchObject({ open: false, closedBy: "thin" });
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next" }, at(MON, "19:36"))).toMatchObject({ ok: true });
  });

  it("the safety net closes it, however good the talk", async () => {
    await answered();
    for (const hhmm of ["19:35", "19:37", "19:39", "19:41", "19:43", "19:45"]) await say("outbound", at(MON, hhmm), "and then?");
    expect((await state(at(MON, "19:47"))).reflection).toMatchObject({ open: false, closedBy: "long" });
  });

  it("30 minutes of silence after ZOH's last text closes it: their next text is a normal conversation", async () => {
    await answered();
    expect((await state(at(MON, "20:02"))).reflection).toMatchObject({ open: true });
    const back = await state(at(MON, "20:04"));
    expect(back.reflection).toMatchObject({ open: false, closedBy: "quiet" });
    expect(partsFor(back)).toContain("nextStep");
    expect(buildStateBlock(back)).toContain(`Next step day: Wed ${WED}.`);
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next" }, at(MON, "20:04"))).toMatchObject({ ok: true });
  });

  it("a text ZOH starts after the step was done closes it; the next day there's none", async () => {
    await answered();
    const [sent] = await t.db.insert(messages).values({ direction: "outbound", contactNumber: ME, content: "Quick one, Sam!", createdAt: at(MON, "19:40"), sentAt: at(MON, "19:40") }).returning();
    await t.db.insert(nudges).values({ testerId: (await me()).id, date: MON, kind: "checkin", moment: "checkin", messageId: sent!.id, status: "sent", createdAt: at(MON, "19:40") });
    expect((await state(at(MON, "19:42"))).reflection).toMatchObject({ open: false, closedBy: "started" });
    expect((await state(at(TUE, "09:00"))).reflection).toBeUndefined();
  });

  it("left open, texts ZOH starts go out as usual and aren't held: the rest-day text, then the kickoff", async () => {
    await answered();
    expect((await state(at(MON, "19:34"))).reflection).toMatchObject({ open: true });
    const nudge = await loadCoachState(t.db, await me(), { now: at(MON, "19:34"), isFirstText: false, nudgeMoment: "followup" });
    expect(nudge.reflection).toBeUndefined();
    expect(buildStateBlock(nudge)).toContain("Next step day:");
    const scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME], lineNumber: LINE });
    for (let ms = at(TUE, "08:00").getTime(); ms <= at(WED, "10:00").getTime(); ms += 5 * 60_000) await scheduler.tick(new Date(ms));
    expect(t.replier.nudges.map((n) => n.moment)).toEqual(expect.arrayContaining(["rest_day", "kickoff"]));
  });

  it("a rest-day bonus step done with proof isn't held", async () => {
    await setup();
    await say("inbound", at(TUE, "19:30"), "", true);
    expect(await tool("mark_step_done", { how: "full", proof: "clear", seen: "Strava run" }, at(TUE, "19:30"))).toMatchObject({ ok: true });
    await say("outbound", at(TUE, "19:31"), "A bonus run! How did it feel?");
    expect((await state(at(TUE, "19:32"))).reflection).toBeUndefined();
    expect(await tool("set_today_step", { step: NEXT, kind: "same", day: "next" }, at(TUE, "19:32"))).toMatchObject({ ok: true });
  });
});
