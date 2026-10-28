import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkinOwed, dueCheckin, suggestionRef } from "../src/coach/next-steps.js";
import { buildStateBlock } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import {
  consoleMessages,
  maintenanceCheckins,
  messages,
  plans,
  stepDays,
  suggestions,
  testerGoals,
  testers,
  type Suggestion,
  type Tester,
} from "../src/db/schema.js";
import { addDays, zonedTime } from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { loadTesterGoals, setFocusGoal } from "../src/testers/goals.js";
import { getTester } from "../src/testers/testers.js";
import { createCoach } from "../src/coach/coach.js";
import { FakeClaudeModel, LINE, ME, makeApp, type TestApp } from "./helpers.js";

/**
 * Next steps and maintenance (spec: GitHub issue "Step log and next step", PR 2). The founders'
 * decisions are written straight to the database here; the console (#10) makes them for real.
 */

const TZ = "America/New_York";
const SUN = "2026-11-01";
/** A Monday. */
const MON = "2026-11-02";
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

const DUNE = {
  step: "10 pages of Dune",
  place: "the couch",
  stepTime: "19:00",
  days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const,
  proof: "photo" as const,
  reason: "Ten pages a night builds the habit.",
  minutes: 20,
};

/** Sam, reading 10 pages every night at 7 pm from Monday (locked Sunday noon), reading the focus goal. */
async function setup(): Promise<Tester> {
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
    ...DUNE,
    days: [...DUNE.days],
    startDate: MON,
    commitment: "I'm in",
    lockedAt: at(SUN, "12:00"),
  });
  await setFocusGoal(t.db, tester!.id, "reading", at(SUN, "12:00"), "remove");
  await say(tester!, "inbound", at(SUN, "11:59"), "I'm in");
  await say(tester!, "outbound", at(SUN, "12:00"), "LET'S GO");
  return tester!;
}

async function say(tester: Tester, direction: "inbound" | "outbound", when: Date, content: string) {
  await t.db.insert(messages).values({ direction, contactNumber: tester.phone, content, createdAt: when, sentAt: when });
}

async function state(tester: Tester, now: Date, lastTesterText = "", goalCap?: number) {
  return loadCoachState(t.db, (await getTester(t.db, tester.id))!, { now, isFirstText: false, lastTesterText, goalCap });
}
const block = async (tester: Tester, now: Date, goalCap?: number) => buildStateBlock(await state(tester, now, "", goalCap));
const tool = async (tester: Tester, name: string, input: unknown, now: Date, lastTesterText = "", goalCap?: number) =>
  runTool(t.db, await state(tester, now, lastTesterText, goalCap), name, input, now);

const allSuggestions = () => t.db.select().from(suggestions).orderBy(asc(suggestions.createdAt));
const alerts = () => t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "alert")).orderBy(asc(consoleMessages.createdAt));
const allPlans = () => t.db.select().from(plans).orderBy(asc(plans.version));

/** A next step as the founders would leave it in the console. */
async function suggestion(tester: Tester, values: Partial<Suggestion> & Pick<Suggestion, "kind" | "proposal">): Promise<Suggestion> {
  const [row] = await t.db
    .insert(suggestions)
    .values({ testerId: tester.id, goalSlug: "reading", raisedBy: "coach", reasoning: "21 days straight", createdAt: at(MON, "08:00"), ...values })
    .returning();
  return row!;
}

/** Done step days on the reading plan, `n` days ending yesterday relative to `today`. */
async function doneDays(tester: Tester, today: string, n: number) {
  const [plan] = await allPlans();
  const rows = Array.from({ length: n }, (_, i) => ({ testerId: tester.id, date: addDays(today, -(i + 1)), planId: plan!.id, status: "done" as const }));
  await t.db.insert(stepDays).values(rows);
}

describe("rule 1: no next step reaches a tester before the team approves it", () => {
  it("a waiting suggestion never shows in the state block, and no tool will deliver or make it", async () => {
    const tester = await setup();
    const waiting = await suggestion(tester, { kind: "deepen", proposal: "15 pages a night" });
    const ref = suggestionRef(waiting.id);
    const now = at(MON, "10:00");
    expect(await block(tester, now)).not.toContain("15 pages a night");
    expect(await block(tester, now)).not.toContain(ref);
    expect(await tool(tester, "record_next_step", { suggestion: ref, outcome: "delivered" }, now)).toMatchObject({ ok: false });
    expect(await tool(tester, "change_plan", { step: "15 pages of Dune", suggestion: ref }, now)).toMatchObject({ ok: false });
    // A deepen the coach thinks of can't go through change_plan without them asking for it.
    expect(await tool(tester, "change_plan", { step: "15 pages of Dune", kind: "deepen" }, now, "sounds good")).toMatchObject({
      ok: false,
      error: expect.stringContaining("suggest_next_step"),
    });
    expect(await allPlans()).toHaveLength(1);

    // Rejected stays hidden too.
    await t.db.update(suggestions).set({ decision: "rejected" }).where(eq(suggestions.id, waiting.id));
    expect(await block(tester, now)).not.toContain("15 pages a night");
  });

  it("the coach's own idea is saved for the team with its reasoning, raises an alert and says nothing", async () => {
    const tester = await setup();
    const result = await tool(
      tester,
      "suggest_next_step",
      { kind: "deepen", asked_by: "coach", proposal: "15 pages a night", reasoning: "21 days straight, says it's easy now" },
      at(MON, "20:00"),
    );
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("Say nothing about it") });
    expect(await allSuggestions()).toMatchObject([
      { kind: "deepen", raisedBy: "coach", decision: "waiting", proposal: "15 pages a night", reasoning: "21 days straight, says it's easy now", outcome: null },
    ]);
    expect((await alerts()).map((a) => a.topic)).toEqual(["next_step"]);
  });

  it("unsure: the team gets a coach_unsure alert with what the coach can't tell", async () => {
    const tester = await setup();
    await tool(
      tester,
      "suggest_next_step",
      { kind: "upgrade", asked_by: "tester", proposal: "add running", reasoning: "also want to run", unsure: "change or add? deepen or upgrade?" },
      at(MON, "20:00"),
    );
    expect((await alerts()).map((a) => [a.topic, a.body])).toEqual([
      ["next_step", "They asked (upgrade): add running"],
      ["coach_unsure", "change or add? deepen or upgrade?"],
    ]);
  });
});

describe("what testers ask for (spec cases 4 to 6)", () => {
  it("a deepen or upgrade they ask for is made right away, flagged for review, and recorded as their own next step", async () => {
    const tester = await setup();
    const asked = "can we bump it to 15 pages?";
    const deepen = await tool(tester, "change_plan", { step: "15 pages of Dune", kind: "deepen", asked: "bump it to 15 pages" }, at(MON, "20:00"), asked);
    expect(deepen).toMatchObject({ ok: true });
    const [, v2] = await allPlans();
    expect(v2).toMatchObject({ version: 2, changeKind: "deepen", needsReview: true, step: "15 pages of Dune" });
    expect(await allSuggestions()).toMatchObject([
      { kind: "deepen", raisedBy: "tester", reasoning: "bump it to 15 pages", decision: "approved", decidedBy: "zoh", outcome: "agreed", planId: v2!.id },
    ]);
    // suggest_next_step points their own deepen back to change_plan.
    expect(
      await tool(tester, "suggest_next_step", { kind: "upgrade", asked_by: "tester", proposal: "lifting", reasoning: "want to lift" }, at(MON, "20:05")),
    ).toMatchObject({ ok: false, error: expect.stringContaining("change_plan") });
  });

  it("a new goal on top waits for the team; asked again, nothing new is saved and no promise is made", async () => {
    const tester = await setup();
    const ask = { kind: "new_focus", asked_by: "tester", proposal: "Run 3x a week too", reasoning: "I also want to start running", new_goal: "exercise" };
    expect(await tool(tester, "suggest_next_step", ask, at(MON, "20:00"))).toMatchObject({ ok: true, message: expect.stringContaining("Let me think on it") });
    expect(await tool(tester, "suggest_next_step", { ...ask, new_goal: "nutrition" }, at(MON, "20:01"))).toMatchObject({ ok: true });
    expect(await tool(tester, "suggest_next_step", ask, at(MON, "21:00"))).toMatchObject({ ok: true, message: expect.stringContaining("promise nothing") });
    expect((await allSuggestions()).map((s) => [s.kind, s.newGoalSlug, s.decision])).toEqual([
      ["new_focus", "exercise", "waiting"],
      ["new_focus", "nutrition", "waiting"],
    ]);
    expect((await alerts()).map((a) => a.topic)).toEqual(["new_goal_request", "new_goal_request"]);
    expect((await getTester(t.db, tester.id))!.goalSlug).toBe("reading");
    // Their current goal or one off the list isn't a new goal.
    expect(await tool(tester, "suggest_next_step", { ...ask, new_goal: "reading" }, at(MON, "21:01"))).toMatchObject({ ok: false });
    expect(await tool(tester, "suggest_next_step", { ...ask, new_goal: "something_else" }, at(MON, "21:01"))).toMatchObject({ ok: false });
  });
});

describe("an approved next step", () => {
  it("shows with its id until raised; their yes makes the version with the kind the team approved", async () => {
    const tester = await setup();
    await doneDays(tester, MON, 1);
    // The team changed it: an upgrade to lifting, not more pages.
    const s = await suggestion(tester, { kind: "deepen", proposal: "15 pages", decision: "changed", decidedKind: "upgrade", decidedProposal: "20 min of lifting" });
    const ref = suggestionRef(s.id);
    expect(await block(tester, at(MON, "10:00"))).toContain(`Next step the team approved, not raised yet [${ref}] (upgrade: 20 min of lifting): raise it as your own idea`);

    expect(await tool(tester, "record_next_step", { suggestion: ref, outcome: "delivered" }, at(MON, "20:00"))).toMatchObject({ ok: true });
    const raised = await block(tester, at(MON, "20:01"));
    expect(raised).not.toContain("not raised yet");
    expect(raised).toContain(`Next step you raised [${ref}] (upgrade: 20 min of lifting), waiting on their answer: yes → change_plan with suggestion ${ref}`);

    expect(await tool(tester, "change_plan", { step: "20 min of lifting", suggestion: ref, kind: "deepen" }, at(MON, "20:05"))).toMatchObject({
      ok: false,
      error: "It was approved as upgrade.",
    });
    expect(await tool(tester, "change_plan", { step: "20 min of lifting", suggestion: ref }, at(MON, "20:05"))).toMatchObject({ ok: true });
    const [, v2] = await allPlans();
    expect(v2).toMatchObject({ changeKind: "upgrade", step: "20 min of lifting", needsReview: true });
    expect((await allSuggestions())[0]).toMatchObject({ outcome: "agreed", planId: v2!.id, deliveredAt: expect.any(Date), outcomeAt: expect.any(Date) });
    expect(await block(tester, at(MON, "20:06"))).not.toContain(ref);
  });

  it("declined: nothing changes, and the coach can't raise the same kind again for a week", async () => {
    const tester = await setup();
    const s = await suggestion(tester, { kind: "deepen", proposal: "15 pages", decision: "approved" });
    expect(await tool(tester, "record_next_step", { suggestion: suggestionRef(s.id), outcome: "declined" }, at(MON, "20:00"))).toMatchObject({ ok: true });
    expect(await allPlans()).toHaveLength(1);
    expect((await allSuggestions())[0]).toMatchObject({ outcome: "declined" });
    const again = { kind: "deepen", asked_by: "coach", proposal: "15 pages", reasoning: "still easy" };
    expect(await tool(tester, "suggest_next_step", again, at(addDays(MON, 6), "20:00"))).toMatchObject({ ok: false, error: expect.stringContaining(addDays(MON, 7)) });
    expect(await tool(tester, "suggest_next_step", again, at(addDays(MON, 7), "20:00"))).toMatchObject({ ok: true });
  });

  it("an approved new focus: the old goal becomes maintenance (no nudges or proof) and they plan the new one", async () => {
    const tester = await setup();
    const s = await suggestion(tester, { kind: "new_focus", proposal: "Morning runs", newGoalSlug: "exercise", raisedBy: "tester", decision: "approved" });
    const ref = suggestionRef(s.id);
    expect(await tool(tester, "switch_goal", { slug: "nutrition", reason: "they said yes", suggestion: ref }, at(MON, "20:00"))).toMatchObject({ ok: false });
    expect(await tool(tester, "switch_goal", { slug: "exercise", reason: "they said yes", suggestion: ref }, at(MON, "20:00"))).toMatchObject({
      ok: true,
      message: expect.stringContaining("maintenance"),
    });
    expect(await getTester(t.db, tester.id)).toMatchObject({ goalSlug: "exercise", phase: "planning" });
    expect((await loadTesterGoals(t.db, tester.id)).map((g) => [g.goalSlug, g.role, g.nudges, g.proof, g.checkinsPerWeek])).toEqual([
      ["reading", "maintenance", false, false, 2],
      ["exercise", "focus", true, true, 0],
    ]);
    expect((await allSuggestions())[0]).toMatchObject({ outcome: "agreed" });
    // Approved by the team: no goal-switch flag on top.
    expect((await alerts()).map((a) => a.topic)).not.toContain("goal_switch");
  });

  it("the goal cap comes from the setting: at the cap a new focus waits silently and can't be switched to", async () => {
    const tester = await setup();
    await t.db.insert(testerGoals).values({ testerId: tester.id, goalSlug: "bedtime", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2 });
    const s = await suggestion(tester, { kind: "new_focus", proposal: "Morning runs", newGoalSlug: "exercise", decision: "approved" });
    const ref = suggestionRef(s.id);
    expect(await block(tester, at(MON, "10:00"), 2)).not.toContain(ref);
    expect(await tool(tester, "switch_goal", { slug: "exercise", reason: "yes", suggestion: ref }, at(MON, "10:00"), "", 2)).toMatchObject({
      ok: false,
      error: expect.stringContaining("goal cap (2)"),
    });
    expect(await block(tester, at(MON, "10:00"), 3)).toContain(`[${ref}] (new_focus: Morning runs (Daily exercise))`);
    expect(await tool(tester, "switch_goal", { slug: "exercise", reason: "yes", suggestion: ref }, at(MON, "10:00"), "", 3)).toMatchObject({ ok: true });
  });
});

describe("streaks per goal and \"what's my streak?\"", () => {
  it("the state block gives every live goal's streak; a maintenance goal's is self-reported", async () => {
    const tester = await setup();
    await doneDays(tester, MON, 1);
    // Bedtime was the focus for 10 nights before it became maintenance on Monday.
    const [bed] = await t.db
      .insert(plans)
      .values({ testerId: tester.id, goalSlug: "bedtime", status: "locked", version: 0, ...DUNE, days: [...DUNE.days], step: "in bed by 10:30", startDate: "2026-10-20", lockedAt: at("2026-10-19", "12:00") })
      .returning();
    await t.db.insert(stepDays).values(
      Array.from({ length: 10 }, (_, i) => ({ testerId: tester.id, date: addDays("2026-10-20", i), planId: bed!.id, status: "done" as const })),
    );
    await t.db.insert(testerGoals).values({ testerId: tester.id, goalSlug: "bedtime", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2, roleSince: at("2026-10-29", "12:00") });
    await t.db.insert(maintenanceCheckins).values({ testerId: tester.id, goalSlug: "bedtime", date: "2026-10-31", answer: "mostly" });
    const now = at("2026-11-03", "10:00");
    // 10 carried + Oct 30 to Nov 2 assumed kept up (through yesterday).
    expect(await block(tester, now)).toContain(
      "Their goals (2 of 3 allowed), each with its own streak: Daily reading (focus): 1 step day, not counting today (done today makes it 2); Same bedtime every night (maintenance, self-reported): 14 step days; check-ins kept up 1 of 1, last confirmed 2026-10-31.",
    );
  });

  it("a maintenance goal that comes back as focus carries on its streak", async () => {
    const tester = await setup();

    const [plan] = await allPlans();
    await t.db.insert(stepDays).values([MON, addDays(MON, 1)].map((date) => ({ testerId: tester.id, date, planId: plan!.id, status: "done" as const })));
    await setFocusGoal(t.db, tester.id, "exercise", at(addDays(MON, 2), "09:00"), "maintenance");
    await setFocusGoal(t.db, tester.id, "reading", at(addDays(MON, 3), "09:00"), "maintenance");
    const s = await state(tester, at(addDays(MON, 3), "10:00"));
    expect(s.streaks.find((g) => g.goalSlug === "reading")).toMatchObject({ role: "focus", current: { length: 2 } });
  });
});

describe("maintenance check-ins (rule 7)", () => {
  const goals = [
    { goalSlug: "bedtime", role: "maintenance" as const, checkinsPerWeek: 2 },
    { goalSlug: "exercise", role: "maintenance" as const, checkinsPerWeek: 2 },
    { goalSlug: "reading", role: "focus" as const, checkinsPerWeek: 0 },
  ];
  const row = (goalSlug: string, date: string, answer: "kept_up" | "stopped" | null = null, messageId: string | null = "m") => ({ goalSlug, date, answer, messageId });

  it.each([
    { name: "nothing asked yet: the first maintenance goal", checkins: [], missedYesterday: false, due: "bedtime" },
    { name: "never the day after a focus miss", checkins: [], missedYesterday: true, due: undefined },
    { name: "at most one per kickoff: the one asked longest ago", checkins: [row("bedtime", "2026-10-29", "kept_up")], missedYesterday: false, due: "exercise" },
    {
      name: "twice a week, at least 3 days apart",
      checkins: [row("bedtime", "2026-10-31", "kept_up"), row("exercise", "2026-10-31", "kept_up")],
      missedYesterday: false,
      due: undefined,
    },
    {
      name: "a third in the same week waits (bedtime asked twice already, exercise too recently)",
      checkins: [row("bedtime", "2026-10-27", "kept_up"), row("bedtime", "2026-10-30", "kept_up"), row("exercise", "2026-10-31", "kept_up")],
      missedYesterday: false,
      due: undefined,
    },
    {
      name: "two unanswered: owed as its own question, not in a kickoff",
      checkins: [row("bedtime", "2026-10-26"), row("bedtime", "2026-10-29"), row("exercise", "2026-10-31", "kept_up")],
      missedYesterday: false,
      due: undefined,
    },
  ])("$name", ({ checkins, missedYesterday, due }) => {
    expect(dueCheckin({ today: MON, goals, checkins, missedYesterday })).toBe(due);
  });

  it("is owed after 2 unanswered kickoff asks, and not again once asked on its own", () => {
    expect(checkinOwed([row("bedtime", "2026-10-26"), row("bedtime", "2026-10-29")])).toBe(true);
    expect(checkinOwed([row("bedtime", "2026-10-26"), row("bedtime", "2026-10-29", "kept_up")])).toBe(false);
    expect(checkinOwed([row("bedtime", "2026-10-26"), row("bedtime", "2026-10-29"), row("bedtime", "2026-10-30", null, null)])).toBe(false);
  });

  it("the kickoff carries it, the ask is stored with the text, and their answer is recorded", async () => {
    const tester = await setup();
    await t.db.insert(testerGoals).values({ testerId: tester.id, goalSlug: "bedtime", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2 });
    await scheduler.tick(at(MON, "09:00"));
    expect(t.replier.nudges.map((n) => [n.moment, n.carry])).toEqual([["kickoff", { checkinGoal: "bedtime" }]]);
    const [ask] = await t.db.select().from(maintenanceCheckins);
    const [sent] = await t.db.select().from(messages).where(and(eq(messages.direction, "outbound"), eq(messages.content, "Yo, kickoff text")));
    expect(ask).toMatchObject({ goalSlug: "bedtime", date: MON, answer: null, messageId: sent!.id });
    expect(await block(tester, at(MON, "09:30"))).toContain("You asked about Same bedtime every night (maintenance) on 2026-11-02, no answer yet: when they answer, record_checkin.");

    expect(await tool(tester, "record_checkin", { goal: "reading", answer: "kept_up" }, at(MON, "09:30"))).toMatchObject({ ok: false });
    expect(await tool(tester, "record_checkin", { goal: "bedtime", answer: "mostly" }, at(MON, "09:30"))).toMatchObject({ ok: true });
    expect(await t.db.select().from(maintenanceCheckins)).toMatchObject([{ answer: "mostly", messageId: sent!.id }]);
    // The next morning: too soon for another.
    await scheduler.tick(at(addDays(MON, 1), "09:00"));
    expect(t.replier.nudges.at(-1)?.carry).toBeUndefined();
  });

  it("the kickoff state names the goal and its step, in place of the kickoff's question", async () => {
    const tester = await setup();
    await t.db.insert(plans).values({ testerId: tester.id, goalSlug: "bedtime", status: "locked", version: 0, ...DUNE, days: [...DUNE.days], step: "in bed by 10:30", startDate: "2026-10-01" });
    await t.db.insert(testerGoals).values({ testerId: tester.id, goalSlug: "bedtime", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2 });
    const s = await loadCoachState(t.db, tester, { now: at(MON, "09:00"), isFirstText: false, nudgeMoment: "kickoff", carry: { checkinGoal: "bedtime" } });
    expect(buildStateBlock(s)).toContain("THIS TEXT ALSO ASKS a maintenance check-in on Same bedtime every night (in bed by 10:30): one light line in place of the kickoff's question (its only question); the whole text stays 1 to 3 sentences, no proof ask. The app records it: no tool call.");
  });

  it("two unanswered: the next reply asks it on its own once", async () => {
    const tester = await setup();
    await t.db.insert(testerGoals).values({ testerId: tester.id, goalSlug: "bedtime", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2 });
    const [m] = await t.db.select().from(messages).limit(1);
    await t.db.insert(maintenanceCheckins).values([
      { testerId: tester.id, goalSlug: "bedtime", date: "2026-10-27", messageId: m!.id },
      { testerId: tester.id, goalSlug: "bedtime", date: "2026-10-30", messageId: m!.id },
    ]);
    expect(await block(tester, at(MON, "12:00"))).toContain("Maintenance check-in owed on Same bedtime every night: their last 2 went unanswered. Ask it on its own in this reply");
    expect(await tool(tester, "record_checkin", { goal: "bedtime", answer: "asked" }, at(MON, "12:00"))).toMatchObject({ ok: true });
    expect(await block(tester, at(MON, "12:01"))).not.toContain("check-in owed");
  });

  it("two 'stopped' in a row raise one alert", async () => {
    const tester = await setup();
    await t.db.insert(testerGoals).values({ testerId: tester.id, goalSlug: "bedtime", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2 });
    await tool(tester, "record_checkin", { goal: "bedtime", answer: "stopped" }, at(MON, "12:00"));
    expect((await alerts()).map((a) => a.topic)).toEqual([]);
    await tool(tester, "record_checkin", { goal: "bedtime", answer: "stopped" }, at(addDays(MON, 3), "12:00"));
    await tool(tester, "record_checkin", { goal: "bedtime", answer: "stopped" }, at(addDays(MON, 3), "12:01"));
    expect((await alerts()).map((a) => a.topic)).toEqual(["maintenance_stopped", "maintenance_stopped"]);
  });
});

describe("kickoffs carry an approved next step", () => {
  it("raises it in the kickoff in place of a check-in, and marks it delivered once sent", async () => {
    const tester = await setup();
    await t.db.insert(testerGoals).values({ testerId: tester.id, goalSlug: "bedtime", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2 });
    const s = await suggestion(tester, { kind: "deepen", proposal: "15 pages a night", decision: "approved", createdAt: at(SUN, "13:00") });
    const nudging = await loadCoachState(t.db, tester, { now: at(MON, "09:00"), isFirstText: false, nudgeMoment: "followup" });
    // A nudge that doesn't carry it says nothing about it.
    expect(buildStateBlock(nudging)).not.toContain("15 pages a night");
    await scheduler.tick(at(MON, "09:00"));
    expect(t.replier.nudges.map((n) => n.carry)).toEqual([{ suggestionId: s.id }]);
    expect((await allSuggestions())[0]).toMatchObject({ outcome: "delivered", deliveredAt: at(MON, "09:00") });
    expect(await t.db.select().from(maintenanceCheckins)).toEqual([]);
    const carried = await loadCoachState(t.db, tester, { now: at(MON, "09:00"), isFirstText: false, nudgeMoment: "kickoff", carry: { suggestionId: s.id } });
    expect(buildStateBlock(carried)).not.toContain("THIS TEXT ALSO RAISES"); // already delivered now
  });

  it("with the real coach, the kickoff is written with the step in its state, and goes out", async () => {
    const tester = await setup();
    const model = new FakeClaudeModel("Yo Sam! Fifteen pages tonight?");
    const real = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: createCoach({ db: t.db, model }), allowedNumbers: [ME], lineNumber: LINE });
    const s = await suggestion(tester, { kind: "deepen", proposal: "15 pages a night", decision: "approved", createdAt: at(SUN, "13:00") });
    await real.tick(at(MON, "09:00"));
    await real.stop();
    expect(t.sendblue.sends.map((x) => x.content)).toEqual(["Yo Sam! Fifteen pages tonight?"]);
    expect(model.stateOf()).toContain(`THIS TEXT ALSO RAISES the next step the team approved [${suggestionRef(s.id)}]`);
    expect((await allSuggestions())[0]).toMatchObject({ outcome: "delivered" });
  });

  it("the state for that kickoff tells the coach to raise it as its own idea", async () => {
    const tester = await setup();
    const s = await suggestion(tester, { kind: "deepen", proposal: "15 pages a night", decision: "approved" });
    const carried = await loadCoachState(t.db, tester, { now: at(MON, "09:00"), isFirstText: false, nudgeMoment: "kickoff", carry: { suggestionId: s.id } });
    expect(buildStateBlock(carried)).toContain(`THIS TEXT ALSO RAISES the next step the team approved [${suggestionRef(s.id)}] (deepen: 15 pages a night): as your own idea`);
  });
});

describe("alerts for the founders", () => {
  it("milestones come from the focus streak, once per run", async () => {
    const tester = await setup();
    await doneDays(tester, addDays(MON, 6), 6);
    await t.db.insert(messages).values({ direction: "inbound", contactNumber: ME, mediaUrl: "https://cdn.example/p.jpg", mediaContentType: "image/jpeg", createdAt: at(addDays(MON, 6), "19:30"), sentAt: at(addDays(MON, 6), "19:30") });
    const done = { how: "full", proof: "clear", seen: "the book open" };
    expect(await tool(tester, "mark_step_done", done, at(addDays(MON, 6), "19:31"))).toMatchObject({ ok: true });
    expect(await tool(tester, "mark_step_done", done, at(addDays(MON, 6), "19:32"))).toMatchObject({ ok: true });
    expect((await alerts()).filter((a) => a.topic === "milestone").map((a) => a.body)).toEqual(["7 step days in a row on Daily reading"]);
  });

  it("a second miss in a row and two quiet days each raise one alert", async () => {
    const tester = await setup();
    await scheduler.tick(at(MON, "22:05"));
    await scheduler.tick(at(addDays(MON, 1), "22:05"));
    await scheduler.tick(at(addDays(MON, 1), "22:10"));
    expect((await alerts()).map((a) => [a.topic, a.body])).toEqual([
      ["second_miss", "Second missed step day in a row (2026-11-03)"],
      ["quiet", "No text from them since 2026-11-01"],
    ]);
    await say(tester, "inbound", at(addDays(MON, 2), "12:00"), "sorry, rough couple of days");
    await scheduler.tick(at(addDays(MON, 3), "12:00"));
    expect(await alerts()).toHaveLength(2);
  });
});
