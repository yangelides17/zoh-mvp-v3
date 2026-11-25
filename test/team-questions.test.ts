import { and, asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { createConsoleCoach } from "../src/console/chat.js";
import { testerRows } from "../src/console/data.js";
import { addRequest, ANSWER_ALERT, claimRequest, closeRequest, LISTEN_DAYS, requestRef, UNANSWERED_ALERT } from "../src/console/requests.js";
import { buildStateBlock } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { consoleMessages, plans, testers, type ConsoleMessage, type Tester } from "../src/db/schema.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { createNudgeScheduler, type NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { DEV, FakeClaudeModel, LINE, ME, makeApp, type TestApp } from "./helpers.js";

// #169: a question the founders ask through ZOH comes back: the answer (or talking past it, or no answer in a day)
// is saved on the question and, unless they switched it off, raised as an alert.

const TZ = "America/New_York";
const SECRET = "console-test-secret";
const TUE = "2026-11-03";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
const HOUR = 3_600_000;
const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

let t: TestApp;
let model: FakeClaudeModel;
let now: Date;
let scheduler: NudgeScheduler;

beforeEach(async () => {
  now = at(TUE, "12:00");
  model = new FakeClaudeModel("Got it.");
  let coach: ReturnType<typeof createConsoleCoach> | undefined;
  t = await makeApp({
    console: { password: "pw", sessionSecret: SECRET, names: ["Yanni", "Stamati"] },
    now: () => now,
    consoleCoach: { answer: (id, when) => coach!.answer(id, when) },
  });
  coach = createConsoleCoach({ db: t.db, model, voice: "VOICE" });
  scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME, DEV], lineNumber: LINE });
});
afterEach(async () => {
  await scheduler.stop();
  await t.close();
});

const cookie = () => `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(now, "Yanni"), SECRET))}`;
const post = (url: string, form: Record<string, string>) =>
  t.app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, payload: new URLSearchParams(form).toString() });

async function seed(o: { stopped?: boolean } = {}): Promise<Tester> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Sam",
      goalSlug: "reading",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at("2026-11-01", "10:00"),
      contextStartedAt: at("2026-11-01", "10:00"),
    })
    .returning();
  await t.db.insert(plans).values({
    testerId: tester!.id,
    goalSlug: "reading",
    status: "locked",
    version: 1,
    step: "10 pages of Dune",
    stepTime: "19:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    proof: "photo",
    reason: "Ten pages a night builds the habit.",
    minutes: 20,
    startDate: "2026-11-02",
    lockedAt: at("2026-11-01", "12:00"),
  });
  if (o.stopped) await t.db.update(testers).set({ stoppedAt: at(TUE, "13:00") }).where(eq(testers.id, tester!.id));
  return (await t.db.select().from(testers).where(eq(testers.id, tester!.id)))[0]!;
}

/** A question ZOH asked in a reply at `asked`: claimed while written, closed when it was sent (as the pipeline does). */
async function asked(tester: Tester, o: { alertOnAnswer?: boolean; question?: boolean; asked?: Date } = {}): Promise<ConsoleMessage> {
  const when = o.asked ?? now;
  const q = await addRequest(t.db, {
    testerId: tester.id,
    author: "Yanni",
    body: "Ask what's made mornings hardest this week",
    exact: false,
    sendNow: false,
    at: new Date(when.getTime() - HOUR),
    question: o.question ?? true,
    alertOnAnswer: o.alertOnAnswer ?? true,
  });
  await claimRequest(t.db, q.id, when);
  await closeRequest(t.db, { request: q, status: "done", at: when, line: "Done" });
  return q;
}

async function alerts(testerId: string): Promise<ConsoleMessage[]> {
  return t.db
    .select()
    .from(consoleMessages)
    .where(and(eq(consoleMessages.testerId, testerId), eq(consoleMessages.kind, "alert")))
    .orderBy(asc(consoleMessages.createdAt));
}

async function row(id: string): Promise<ConsoleMessage> {
  return (await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, id)))[0]!;
}

/** The texting coach records what came of it, as it would in a reply at `when`. */
async function record(tester: Tester, q: ConsoleMessage, when: Date, input: { outcome: string; answer?: string }) {
  const state = await loadCoachState(t.db, tester, { now: when, isFirstText: false });
  return runTool(t.db, state, "record_team_answer", { question: requestRef(q.id), ...input }, when);
}

describe("an answer to a team question (#169)", () => {
  it("alert on: the answer is saved on the question and raised in Alerts, counted on the badge", async () => {
    const tester = await seed();
    const q = await asked(tester);
    const reply = new Date(now.getTime() + 2 * HOUR);
    const result = await record(tester, q, reply, { outcome: "answered", answer: "the alarm's across the room and I snooze" });
    expect(result.ok).toBe(true);

    expect(await row(q.id)).toMatchObject({ answerStatus: "answered", answer: "the alarm's across the room and I snooze", answeredAt: reply });
    const raised = await alerts(tester.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ topic: ANSWER_ALERT });
    expect(raised[0]!.body).toBe(`Sam answered "Ask what's made mornings hardest this week": the alarm's across the room and I snooze`);
    expect((await testerRows(t.db, reply)).find((r) => r.tester.id === tester.id)!.alertsWaiting).toBe(1);
  });

  it("an alert that fails to save takes the answer with it, so a retry records both", async () => {
    const tester = await seed();
    const q = await asked(tester);
    const reply = new Date(now.getTime() + 2 * HOUR);
    await t.db.execute(
      sql.raw(`CREATE FUNCTION no_alerts() RETURNS trigger AS $$ BEGIN
        IF NEW.kind = 'alert' THEN RAISE EXCEPTION 'database blip'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`),
    );
    await t.db.execute(sql.raw("CREATE TRIGGER no_alerts BEFORE INSERT ON console_messages FOR EACH ROW EXECUTE FUNCTION no_alerts()"));
    try {
      await expect(record(tester, q, reply, { outcome: "answered", answer: "the alarm's across the room" })).rejects.toThrow();
      expect((await row(q.id)).answerStatus).toBeNull();
    } finally {
      // The test database is shared by the file: never leave it failing for the next test.
      await t.db.execute(sql.raw("DROP TRIGGER no_alerts ON console_messages"));
      await t.db.execute(sql.raw("DROP FUNCTION no_alerts"));
    }
    expect((await record(tester, q, reply, { outcome: "answered", answer: "the alarm's across the room" })).ok).toBe(true);
    expect(await alerts(tester.id)).toHaveLength(1);
    // Already recorded: the coach is told so, not "Recorded".
    expect((await record(tester, q, reply, { outcome: "answered", answer: "again" })).ok).toBe(false);
  });

  it("alert off: the answer is saved, with no alert", async () => {
    const tester = await seed();
    const q = await asked(tester, { alertOnAnswer: false });
    await record(tester, q, new Date(now.getTime() + HOUR), { outcome: "answered", answer: "the alarm" });
    expect(await row(q.id)).toMatchObject({ answerStatus: "answered", answer: "the alarm" });
    expect(await alerts(tester.id)).toHaveLength(0);
  });

  it("no answer 24 hours after it was asked: one alert; a later answer still comes back", async () => {
    const tester = await seed();
    const q = await asked(tester);
    await scheduler.tick(new Date(now.getTime() + 23 * HOUR));
    expect(await alerts(tester.id)).toHaveLength(0);
    await scheduler.tick(new Date(now.getTime() + 24 * HOUR + 60_000));
    await scheduler.tick(new Date(now.getTime() + 25 * HOUR));
    const unanswered = await alerts(tester.id);
    expect(unanswered.map((a) => a.topic)).toEqual([UNANSWERED_ALERT]);
    expect(unanswered[0]!.body).toMatch(/^No answer yet from Sam \(asked .+\): "Ask what's made mornings hardest this week"$/);

    await record(tester, q, new Date(now.getTime() + 30 * HOUR), { outcome: "answered", answer: "work's been early" });
    expect((await alerts(tester.id)).map((a) => a.topic)).toEqual([UNANSWERED_ALERT, ANSWER_ALERT]);
  });

  it("they've stopped: no no-answer alert, and ZOH stops listening", async () => {
    const tester = await seed({ stopped: true });
    await asked(tester, { asked: at(TUE, "12:00") });
    await scheduler.tick(new Date(now.getTime() + 25 * HOUR));
    expect(await alerts(tester.id)).toHaveLength(0);
    const state = await loadCoachState(t.db, tester, { now: new Date(now.getTime() + 25 * HOUR), isFirstText: false });
    expect(state.teamQuestions).toHaveLength(0);
  });

  it("a dodge: one alert, never asked again, still listening for an answer for 7 days", async () => {
    const tester = await seed();
    const q = await asked(tester);
    await record(tester, q, new Date(now.getTime() + HOUR), { outcome: "dodged" });
    const first = await alerts(tester.id);
    expect(first.map((a) => a.topic)).toEqual([UNANSWERED_ALERT]);
    expect(first[0]!.body).toContain("talked past");
    // No second alert a day on.
    await scheduler.tick(new Date(now.getTime() + 25 * HOUR));
    expect(await alerts(tester.id)).toHaveLength(1);

    const later = new Date(now.getTime() + 2 * 24 * HOUR);
    const sheet = buildStateBlock(await loadCoachState(t.db, tester, { now: later, isFirstText: false }));
    expect(sheet).toContain(
      `FROM THE TEAM, question [${requestRef(q.id)}] you already asked Nov 3, they talked past it, the team waiting on their answer (the team's note: Ask what's made mornings hardest this week).`,
    );
    expect((await record(tester, q, later, { outcome: "answered", answer: "the alarm" })).ok).toBe(true);
    expect((await alerts(tester.id)).map((a) => a.topic)).toEqual([UNANSWERED_ALERT, ANSWER_ALERT]);
  });

  it("listening ends after 7 days", async () => {
    const tester = await seed();
    await asked(tester);
    const gone = new Date(now.getTime() + LISTEN_DAYS * 24 * HOUR + 60_000);
    const sheet = buildStateBlock(await loadCoachState(t.db, tester, { now: gone, isFirstText: false }));
    expect(sheet).not.toContain("already asked");
  });

  it("a request that isn't a question never raises answer alerts, and can't be recorded as answered", async () => {
    const tester = await seed();
    const r = await asked(tester, { question: false });
    expect((await record(tester, r, new Date(now.getTime() + HOUR), { outcome: "answered", answer: "ok" })).ok).toBe(false);
    await scheduler.tick(new Date(now.getTime() + 25 * HOUR));
    expect(await alerts(tester.id)).toHaveLength(0);
    expect(await row(r.id)).toMatchObject({ answerStatus: null });
  });
});

describe("asking a question from console chat (#169)", () => {
  it("the draft card says the answer comes back; the switch turns the alert off before Do it", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "plan_request", input: { what: "Ask what's made mornings hardest this week", question: true } }] }, "Drafted.");
    now = new Date(now.getTime() + 60_000);
    await post(`/console/testers/${tester.id}/chat`, { text: "ask Sam what's made mornings hard" });
    await t.queue.idle();
    const draft = (await t.db.select().from(consoleMessages).where(and(eq(consoleMessages.testerId, tester.id), eq(consoleMessages.kind, "draft"))))[0]!;
    expect(draft.body).toContain("you'll get an alert when they answer");

    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}?tab=console`, headers: { cookie: cookie() } });
    expect(page.body).toContain("Alert me when they answer: on");

    expect((await post(`/console/testers/${tester.id}/drafts/${draft.id}/answer-alert`, { on: "false" })).statusCode).toBe(303);
    expect((await row(draft.id)).body).toContain("their answer is saved, with no alert");
    now = new Date(now.getTime() + 60_000);
    expect((await post(`/console/testers/${tester.id}/drafts/${draft.id}/confirm`, {})).statusCode).toBe(303);
    const [request] = await t.db.select().from(consoleMessages).where(and(eq(consoleMessages.testerId, tester.id), eq(consoleMessages.kind, "request")));
    expect(request).toMatchObject({ question: true, alertOnAnswer: false, body: "Ask what's made mornings hardest this week" });
  });
});
