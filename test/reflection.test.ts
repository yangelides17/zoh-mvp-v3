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

    expect(await tool("save_reflection", { summary: "Second round was way easier once they slowed down", how_it_went: true, take: "Did the full step, found it easy." }, at(MON, "19:40"))).toMatchObject({ ok: true });
    expect(await row(MON)).toMatchObject({ status: "done", reflection: "Second round was way easier once they slowed down" });
    expect(await loadDaySummary(t.db, tester.id, "exercise", MON)).toEqual(without);
  });

  it("the state shows today's reflection, and each recent day's, so the next step builds on it", async () => {
    await setup();
    await doneMonday();
    expect(await block(at(MON, "19:31"))).toContain("Today's reflection: none yet.");
    expect(await block(at(MON, "19:31"))).toContain(
      'They haven\'t said how it went for them yet (how it felt, how hard, room for more; a lesson, what got in the way or a thin "okay" isn\'t that): find out before any next step, unless they\'re rushed or say skip.',
    );
    await tool("save_reflection", { summary: "Easier when slower", how_it_went: true, take: "Slowed down, felt good." }, at(MON, "19:40"));
    expect(await block(at(MON, "19:41"))).toContain('Today\'s reflection: "Easier when slower". They\'ve said how it went.');
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
    expect(await block(at(MON, "19:30"))).toContain("This reply is your 1st text since their proof today: celebrate and ask one question (how it went; or, if their proof already says, a gap that matters or deeper on something they said); the next step waits for a later text, even when they've said what they want next, unless they're rushed or done talking.");
    // They said how it went early, so the talk runs on its content, not a count.
    await tool("save_reflection", { summary: "Felt easy, slower pace helped", how_it_went: true, take: "Easy, wants more." }, at(MON, "19:30"));
    const times = ["19:31", "19:33", "19:35", "19:37", "19:41", "19:43", "19:45"];
    for (const [i, hhmm] of times.entries()) {
      await say("outbound", at(MON, hhmm), `reply ${i}`);
      await say("inbound", at(MON, hhmm.replace(/.$/, "9")), "more");
      if (i === 3) expect(await block(at(MON, "19:39"))).toContain("This reply is your 5th text since their proof today: follow what they just said: if it opens something");
    }
    expect(await block(at(MON, "19:50"))).toContain("This reply is your 8th text since their proof today: wrap up now unless they're clearly still going, then the next step.");
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
  const FIND_OUT = "find out first: a thin answer is an opening, so ask what's behind it, tied to their proof, never guessing what it means; the next step waits, unless they're rushed or say skip: then the next step";

  it("a thin answer keeps the guard: saved, not said, and the next step waits at texts 2 and 3", async () => {
    await setup();
    await talk(1);
    // "okay" is saved as thin: the coach marks how it went false (tool description), so it isn't said.
    expect(await tool("save_reflection", { summary: 'Said it felt "okay"', how_it_went: false, take: "Thin so far." }, at(MON, "19:32"))).toMatchObject({ ok: true });
    expect(await row(MON)).toMatchObject({ reflection: 'Said it felt "okay"', howItWentSaid: false });
    const second = await block(at(MON, "19:32"));
    expect(second).toContain('Today\'s reflection: "Said it felt "okay"". They haven\'t said how it went for them yet');
    expect(second).toContain(`This reply is your 2nd text since their proof today: ${FIND_OUT}.`);
    expect(second).not.toContain("follow what they just said");
    await say("outbound", at(MON, "19:33"), "What made it okay?");
    await say("inbound", at(MON, "19:34"), "dunno, fine");
    expect(await block(at(MON, "19:34"))).toContain(`This reply is your 3rd text since their proof today: ${FIND_OUT}.`);
  });

  it("the next step never comes from the count alone: little back twice wraps up warmly at text 4; a real answer turns to the balance line", async () => {
    await setup();
    await talk(3);
    expect(await block(at(MON, "19:37"))).toContain("This reply is your 4th text since their proof today: they've given little back twice: wrap up warmly now, no more questions, then the next step.");
    // Once there's something real, the talk runs on content and the next step comes when it shapes it.
    await tool("save_reflection", { summary: "Okay, but the hill in round 2 was brutal", how_it_went: true, take: "Hill was hard." }, at(MON, "19:37"));
    const real = await block(at(MON, "19:37"));
    expect(real).toContain("They've said how it went.");
    expect(real).toContain(
      "follow what they just said: if it opens something (a worry, a difficulty, what clicked, a reason), ask about that, one question, before any reassurance or proposal; if not, new ground (how it felt, how hard, room for more). What they want for tomorrow is noted, not the end. Move on only once a reply gives you nothing new to follow, or they've run out; then the next step (PROOF)",
    );
    // Rushed and "skip" are the coach's call from their words: the not-said line names them as the way out.
    await t.db.update(stepDays).set({ howItWentSaid: false }).where(eq(stepDays.date, MON));
    expect(await block(at(MON, "19:37"))).toContain("find out before any next step, unless they're rushed or say skip.");
  });

  it("a next step is agreed only after it's been shown: never in the reply that first saves it", async () => {
    await setup();
    await doneMonday();
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
    expect(await block(at(TUE, "10:00"))).toContain("Yesterday's step was done with no word on how it went: you may pick it up in a line now");
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
    await tool("set_today_step", { kind: "harder", step: NEXT, day: "next", reason: "Said 3 rounds felt easy and wants more" }, at(MON, "19:50"));
    expect(await row(WED)).toMatchObject({ step: NEXT, nextReason: "Said 3 rounds felt easy and wants more" });
  });
});

describe("the next step, agreed at the wrap-up", () => {
  it("is saved for the next step day across a rest day, and that morning the kickoff reminds and checks they're still in (#92)", async () => {
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
    expect(wed).toContain("They said yes to today's step ahead of time (Mon 7:55 PM): the kickoff reminds them of it (with any tip), and its one question checks they're still in, in words that show they already said yes");
    expect(wed).not.toContain("asks nothing");

    // The kickoff that morning writes with that state.
    const model = new FakeClaudeModel("Morning Sam! 2 on, 1 off, 4 rounds tonight at 6:30. Same rule: slow enough to talk.");
    const coach = createCoach({ db: t.db, model, voice: "v" });
    await coach.nudge!({ tester: await me(), turns: [], now: at(WED, "09:00"), moment: "kickoff" });
    expect(model.stateOf()).toContain("ahead of time (Mon 7:55 PM): the kickoff reminds them of it");
  });

  it("a changed step without a new yes is asked fresh; with a yes it stays agreed (#92)", async () => {
    await setup();
    await doneMonday();
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
