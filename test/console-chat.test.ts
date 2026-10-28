import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { CAPABILITIES, CONSOLE_INSTRUCTIONS, createConsoleCoach, nextChance } from "../src/console/chat.js";
import { addRequest, addThreadLine, APP_AUTHOR, COACH_AUTHOR, requestRef } from "../src/console/requests.js";
import { createCoach } from "../src/coach/coach.js";
import { buildStateBlock, FIXED_INSTRUCTIONS, fullVoiceInstructions, TEAM } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { loadVoiceDoc } from "../src/coach/voice.js";
import { consoleMessages, messages, nudges, plans, stepDays, testers, type ConsoleMessage, type Tester } from "../src/db/schema.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { createNudgeScheduler, MAX_UNANSWERED, TEAM_MOMENT, type NudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { DEV, FakeClaudeModel, LINE, ME, makeApp, type TestApp } from "./helpers.js";

const TZ = "America/New_York";
const PASSWORD = "open sesame";
const SECRET = "console-test-secret";
const NAMES = ["Yanni", "Stamati"];
/** A Tuesday; quiet hours 10 pm to 9 am. */
const TUE = "2026-11-03";
const WED = "2026-11-04";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

let t: TestApp;
let model: FakeClaudeModel;
let now: Date;
let scheduler: NudgeScheduler;

beforeEach(async () => {
  now = at(TUE, "12:00");
  model = new FakeClaudeModel("Got it.");
  // The console coach needs the app's database, so it's built lazily against the test db.
  let coach: ReturnType<typeof createConsoleCoach> | undefined;
  t = await makeApp({
    console: { password: PASSWORD, sessionSecret: SECRET, names: NAMES },
    now: () => now,
    consoleCoach: { answer: (id, at) => coach!.answer(id, at) },
  });
  coach = createConsoleCoach({ db: t.db, model, voice: "VOICE PAGE TEXT" });
  scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME, DEV], lineNumber: LINE });
});
afterEach(async () => {
  await scheduler.stop();
  await t.close();
});

const cookieFor = (name?: string) => `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(now, name), SECRET))}`;

async function post(url: string, form: Record<string, string>, cookie?: string) {
  return t.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    payload: new URLSearchParams(form).toString(),
  });
}

/** Sam, active on a locked reading plan (every day at 7 pm), with a short text history. */
async function seed(o: { stopped?: boolean; phase?: Tester["phase"] } = {}): Promise<Tester> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone: ME,
      name: "Sam",
      goalSlug: "reading",
      phase: o.phase ?? "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at("2026-11-01", "10:00"),
      contextStartedAt: at("2026-11-01", "10:00"),
      stoppedAt: o.stopped ? at("2026-11-02", "10:00") : null,
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
  await say(tester!, "inbound", at("2026-11-02", "19:30"), "10 down, page 40");
  await say(tester!, "outbound", at("2026-11-02", "19:31"), "Love it Sam");
  return tester!;
}

async function say(tester: Tester, direction: "inbound" | "outbound", when: Date, content: string) {
  await t.db.insert(messages).values({ direction, contactNumber: tester.phone, content, createdAt: when, sentAt: when });
}

async function thread(testerId: string): Promise<ConsoleMessage[]> {
  return t.db.select().from(consoleMessages).where(eq(consoleMessages.testerId, testerId)).orderBy(asc(consoleMessages.createdAt));
}

async function chat(tester: Tester, text: string, opts: { as?: string; exact?: boolean; sendNow?: boolean } = {}) {
  const form: Record<string, string> = { text };
  if (opts.exact) form.exact = "on";
  if (opts.sendNow) form.sendNow = "on";
  // A minute between messages, as in real use (a frozen clock would stamp a new line with the last answer's time).
  now = new Date(now.getTime() + 60_000);
  const res = await post(`/console/testers/${tester.id}/chat`, form, cookieFor(opts.as ?? "Yanni"));
  await t.queue.idle();
  return res;
}

describe("console chat route", () => {
  it("needs the login: no or wrong cookie, or no name, gets 401 and stores nothing", async () => {
    const tester = await seed();
    const wrong = `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(now, "Yanni"), "another secret"))}`;
    for (const cookie of [undefined, wrong, cookieFor()]) {
      expect((await post(`/console/testers/${tester.id}/chat`, { text: "hi" }, cookie)).statusCode).toBe(401);
      expect((await post(`/console/testers/${tester.id}/requests/${tester.id}/cancel`, {}, cookie)).statusCode).toBe(401);
    }
    expect(await thread(tester.id)).toHaveLength(0);
  });

  it("stores the founder's line with their name, and the coach's answer after it", async () => {
    const tester = await seed();
    model.script("She missed Monday? No: Monday was done, page 40.");
    const res = await chat(tester, "why did she miss Monday?");
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/console/testers/${tester.id}#chat`);
    const rows = await thread(tester.id);
    expect(rows.map((r) => [r.kind, r.author, r.body])).toEqual([
      ["founder", "Yanni", "why did she miss Monday?"],
      ["coach", COACH_AUTHOR, "She missed Monday? No: Monday was done, page 40."],
    ]);
    // Grounded in the record: the coach was shown the texts and the state.
    const system = model.requests[0]!.system.map((b) => b.text).join("\n");
    expect(system).toContain(CONSOLE_INSTRUCTIONS);
    expect(system).toContain("VOICE PAGE TEXT");
    expect(system).toContain("Them: 10 down, page 40");
    expect(system).toContain("Locked plan (version 1");
    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}`, headers: { cookie: cookieFor("Yanni") } });
    expect(page.body).toContain("why did she miss Monday?");
    expect(page.body).toContain("Monday was done, page 40.");
    expect(page.body).not.toContain("ZOH is thinking");
  });

  it("rejects an empty or too-long message", async () => {
    const tester = await seed();
    expect((await chat(tester, "   ")).statusCode).toBe(400);
    expect((await chat(tester, "x".repeat(2001))).statusCode).toBe(400);
    expect(await thread(tester.id)).toHaveLength(0);
  });

  it("both founders at once: both lines go in, in order, each with who, and both get answered", async () => {
    const tester = await seed();
    const cookieY = cookieFor("Yanni");
    const cookieS = cookieFor("Stamati");
    await Promise.all([
      post(`/console/testers/${tester.id}/chat`, { text: "how's she doing?" }, cookieY),
      post(`/console/testers/${tester.id}/chat`, { text: "any misses this week?" }, cookieS),
    ]);
    await t.queue.idle();
    const rows = await thread(tester.id);
    const founders = rows.filter((r) => r.kind === "founder");
    expect(founders.map((r) => r.author).sort()).toEqual(["Stamati", "Yanni"]);
    expect(rows.at(-1)!.kind).toBe("coach");
    expect(rows.at(-1)!.createdAt.getTime()).toBeGreaterThanOrEqual(founders.at(-1)!.createdAt.getTime());
  });

  it("without a console coach, says it isn't set up", async () => {
    await t.close();
    t = await makeApp({ console: { password: PASSWORD, sessionSecret: SECRET, names: NAMES }, now: () => now });
    scheduler = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: t.replier, allowedNumbers: [ME] });
    const tester = await seed();
    await chat(tester, "hello?");
    const rows = await thread(tester.id);
    expect(rows.at(-1)).toMatchObject({ kind: "coach", author: APP_AUTHOR });
    expect(rows.at(-1)!.body).toContain("isn't set up");
  });

  it("a failed Claude call leaves an apology in the thread, not silence", async () => {
    const tester = await seed();
    model.script(new Error("Claude down"));
    await chat(tester, "how's she doing?");
    expect((await thread(tester.id)).at(-1)).toMatchObject({ kind: "coach", author: APP_AUTHOR, body: "Sorry, I couldn't answer that just now. Try again?" });
  });

  it("send exactly this: queued word for word with the app's confirmation, no Claude call", async () => {
    const tester = await seed();
    await chat(tester, "Hey Sam, Yanni here: proud of you!", { exact: true });
    expect(model.requests).toHaveLength(0);
    const rows = await thread(tester.id);
    expect(rows[0]).toMatchObject({ kind: "request", author: "Yanni", body: "Hey Sam, Yanni here: proud of you!", exact: true, sendNow: false, requestStatus: "pending" });
    expect(rows[1]).toMatchObject({ kind: "coach", author: APP_AUTHOR });
    expect(rows[1]!.body).toContain("within a minute");
  });

  it("send exactly this in quiet hours says when it goes; to a stopped tester, that it won't", async () => {
    now = at(TUE, "23:00");
    const tester = await seed();
    await chat(tester, "Night!", { exact: true });
    expect((await thread(tester.id)).at(-1)!.body).toContain("when their quiet hours end (09:00 their time)");

    await t.db.update(testers).set({ stoppedAt: now }).where(eq(testers.id, tester.id));
    await chat(tester, "Come back!", { exact: true, sendNow: true });
    const rows = await thread(tester.id);
    expect(rows.find((r) => r.body === "Come back!")).toMatchObject({ requestStatus: "cancelled" });
    expect(rows.at(-1)!.body).toBe("They texted stop, so this won't be sent.");
  });

  it("send now only counts with send exactly this", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "plan_request", input: { what: "Ask how Dune is going" } }] }, "Will do.");
    await chat(tester, "ask her how Dune is going", { sendNow: true });
    const [request] = (await thread(tester.id)).filter((r) => r.kind === "request");
    expect(request).toMatchObject({ exact: false, sendNow: false });
  });

  it("the Cancel button cancels a pending request once", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Hi", exact: true, sendNow: false, at: now });
    const url = `/console/testers/${tester.id}/requests/${request.id}/cancel`;
    expect((await post(url, {}, cookieFor("Stamati"))).statusCode).toBe(303);
    expect((await post(url, {}, cookieFor("Stamati"))).statusCode).toBe(409);
    expect((await thread(tester.id))[0]).toMatchObject({ requestStatus: "cancelled" });
  });

  it("shows notes, requests with their status, and the thinking line while the coach answers", async () => {
    const tester = await seed();
    await addThreadLine(t.db, { testerId: tester.id, kind: "note", author: "Yanni", body: "Traveling next week", at: now });
    await addRequest(t.db, { testerId: tester.id, author: "Stamati", body: "Send the sleep article", exact: false, sendNow: false, at: now });
    await addThreadLine(t.db, { testerId: tester.id, kind: "founder", author: "Yanni", body: "still there?", at: now });
    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}`, headers: { cookie: cookieFor("Yanni") } });
    expect(page.body).toContain("note for the coach");
    expect(page.body).toContain("Traveling next week");
    expect(page.body).toContain("for the coach to bring up");
    expect(page.body).toContain("Cancel</button>");
    expect(page.body).toContain("ZOH is thinking");
    expect(page.body).toContain('name="exact"');
  });
});

describe("console coach capabilities", () => {
  it("is a list of capabilities: note, request, cancel", () => {
    expect(Object.keys(CAPABILITIES)).toEqual(["save_note", "plan_request", "cancel_request"]);
  });

  it("save_note stores the founder's context under their name", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "save_note", input: { note: "Traveling next week; go easy" } }] }, "Got it: I'll go easy on her next week.");
    await chat(tester, "she's traveling next week, go easy", { as: "Stamati" });
    const rows = await thread(tester.id);
    expect(rows.map((r) => [r.kind, r.author, r.body])).toEqual([
      ["founder", "Stamati", "she's traveling next week, go easy"],
      ["note", "Stamati", "Traveling next week; go easy"],
      ["coach", COACH_AUTHOR, "Got it: I'll go easy on her next week."],
    ]);
  });

  it("plan_request queues a request (with a not-before time in their zone); cancel_request cancels it", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "plan_request", input: { what: "Suggest a protein target", not_before: "2026-11-05 09:00" } }] }, "Got it. Thursday morning.");
    await chat(tester, "propose a protein target after Wednesday");
    const [request] = (await thread(tester.id)).filter((r) => r.kind === "request");
    expect(request).toMatchObject({ author: "Yanni", body: "Suggest a protein target", exact: false, requestStatus: "pending" });
    expect(request!.dueAt).toEqual(at("2026-11-05", "09:00"));
    // The tool result tells the coach when it goes.
    const toolResult = JSON.stringify(model.requests[1]!.messages.at(-1));
    expect(toolResult).toContain(`Queued [${requestRef(request!.id)}]`);
    // The next round's record names it as just queued, not as an earlier request (eval: rude-request).
    expect(model.requests[1]!.system.at(-1)!.text).toContain(`[${requestRef(request!.id)}] you just queued it in this answer, not before`);

    model.script({ tools: [{ name: "cancel_request", input: { request: requestRef(request!.id) } }] }, "Cancelled.");
    await chat(tester, "actually cancel that");
    expect((await thread(tester.id)).find((r) => r.id === request!.id)).toMatchObject({ requestStatus: "cancelled" });
  });

  it("plan_request refuses for a tester who stopped; the chat still answers", async () => {
    const tester = await seed({ stopped: true });
    model.script({ tools: [{ name: "plan_request", input: { what: "Say hi" } }] }, "They've stopped, so I can't reach them.");
    await chat(tester, "say hi to her");
    const rows = await thread(tester.id);
    expect(rows.filter((r) => r.kind === "request")).toHaveLength(0);
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("They texted stop");
    expect(rows.at(-1)).toMatchObject({ kind: "coach", body: "They've stopped, so I can't reach them." });
  });

  it("reads the thread back: founders and the record as user, its answers as assistant", async () => {
    const tester = await seed();
    await addThreadLine(t.db, { testerId: tester.id, kind: "founder", author: "Yanni", body: "first", at: at(TUE, "11:00") });
    await addThreadLine(t.db, { testerId: tester.id, kind: "coach", author: COACH_AUTHOR, body: "first answer", at: at(TUE, "11:01") });
    await addThreadLine(t.db, { testerId: tester.id, kind: "coach", author: APP_AUTHOR, body: "Done (in a reply, Tue): x", at: at(TUE, "11:02") });
    await chat(tester, "second");
    const msgs = model.requests[0]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const last = JSON.stringify(msgs[2]);
    expect(last).toContain("app] Done");
    expect(last).toContain("Yanni (");
  });

  it("answers nothing when the latest founder line already has an answer", async () => {
    const tester = await seed();
    await chat(tester, "hi");
    const coach = createConsoleCoach({ db: t.db, model, voice: "v" });
    expect(await coach.answer(tester.id, now)).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it("says when ZOH can next reach them", async () => {
    const tester = await seed();
    expect(await nextChance(t.db, tester, at(TUE, "12:00"))).toContain("Wed 9:00 AM their time");
    expect(await nextChance(t.db, tester, at(TUE, "07:00"))).toContain("Tue 9:00 AM their time");
    expect(await nextChance(t.db, tester, at(TUE, "09:30"))).toContain("this morning's text");
    expect(await nextChance(t.db, { ...tester, phase: "planning" }, now)).toContain("in your reply to their next text");
    expect(await nextChance(t.db, { ...tester, stoppedAt: now }, now)).toContain("never");
  });
});

describe("the texting coach and the team", () => {
  it("TEAM rules are in both prompts and within budget", () => {
    expect(FIXED_INSTRUCTIONS).toContain(TEAM);
    expect(fullVoiceInstructions(loadVoiceDoc())).toContain(TEAM);
    expect(TEAM).toContain("never quote it");
    expect(TEAM).toContain("Never deny it");
    expect(loadVoiceDoc()).toContain('Asked "did someone tell you to say that?"');
  });

  it("the state block shows notes and due requests; not exact ones, future ones or closed ones", async () => {
    const tester = await seed();
    await addThreadLine(t.db, { testerId: tester.id, kind: "note", author: "Yanni", body: "Traveling next week", at: now });
    const due = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Share https://example.com/sleep", exact: false, sendNow: false, at: now });
    await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "LATER ONE", exact: false, sendNow: false, dueAt: at(WED, "09:00"), at: now });
    await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "EXACT ONE", exact: true, sendNow: false, at: now });
    await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "CANCELLED ONE", exact: false, sendNow: false, at: now, status: "cancelled" });
    const block = buildStateBlock(await loadCoachState(t.db, tester, { now, isFirstText: false }));
    expect(block).toContain("FROM THE TEAM, notes (context only; never quote them or mention the team):\n- Nov 3: Traveling next week");
    expect(block).toContain(`FROM THE TEAM, request [${requestRef(due.id)}]: Share https://example.com/sleep.`);
    expect(block).not.toContain("LATER ONE");
    expect(block).not.toContain("EXACT ONE");
    expect(block).not.toContain("CANCELLED ONE");
    // The later one is due once its time comes.
    const later = buildStateBlock(await loadCoachState(t.db, tester, { now: at(WED, "09:01"), isFirstText: false }));
    expect(later).toContain("LATER ONE");
  });

  it("notes older than 30 days drop out", async () => {
    const tester = await seed();
    await addThreadLine(t.db, { testerId: tester.id, kind: "note", author: "Yanni", body: "Old news", at: now });
    const later = new Date(now.getTime() + 31 * 86_400_000);
    expect(buildStateBlock(await loadCoachState(t.db, tester, { now: later, isFirstText: false }))).not.toContain("Old news");
  });

  it("mark_request_done closes the request once, with a Done line for the founders", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Share the sleep article", exact: false, sendNow: false, at: now });
    const state = await loadCoachState(t.db, tester, { now, isFirstText: false });
    const result = await runTool(t.db, state, "mark_request_done", { request: requestRef(request.id) }, now);
    expect(result.ok).toBe(true);
    const rows = await thread(tester.id);
    expect(rows.find((r) => r.id === request.id)).toMatchObject({ requestStatus: "done", doneAt: now });
    expect(rows.at(-1)).toMatchObject({ kind: "coach", author: APP_AUTHOR });
    expect(rows.at(-1)!.body).toMatch(/^Done \(in a reply, Tue 12:00 PM\): Share the sleep article$/);
    // Later rounds of the same reply still see it, so the text doesn't drop it (eval: article-link).
    const sameReply = await loadCoachState(t.db, tester, { now, isFirstText: false });
    expect(buildStateBlock(sameReply)).toContain(`request [${requestRef(request.id)}], marked done in this reply: Share the sleep article. This text carries it`);
    const again = await runTool(t.db, sameReply, "mark_request_done", { request: requestRef(request.id) }, now);
    expect(again.ok).toBe(false);
    // The next reply doesn't.
    const next = await loadCoachState(t.db, tester, { now: new Date(now.getTime() + 60_000), isFirstText: false });
    expect(buildStateBlock(next)).not.toContain("Share the sleep article");
  });

  it("a kickoff carries a due request in ZOH's words and marks it done with the text that carried it", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Share https://example.com/sleep", exact: false, sendNow: false, at: at(TUE, "20:00") });
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    await t.db.insert(stepDays).values({ testerId: tester.id, date: TUE, planId: plan!.id, status: "done" });
    await scheduler.tick(at(WED, "09:00"));
    const nudge = t.replier.nudges.at(-1)!;
    expect(nudge.moment).toBe("kickoff");
    expect(nudge.carry).toEqual({ requestId: request.id });
    const [row] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, request.id));
    const [sent] = await t.db.select().from(messages).where(eq(messages.content, "Yo, kickoff text"));
    expect(row).toMatchObject({ requestStatus: "done", messageId: sent!.id });
    expect((await thread(tester.id)).at(-1)!.body).toContain("Done (in the morning text");
  });

  it("the carried request is written by the real coach from its THIS TEXT ALSO line", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Share https://example.com/sleep", exact: false, sendNow: false, at: now });
    const coachModel = new FakeClaudeModel("Kalimera Sam! Saw this and thought of you: https://example.com/sleep");
    const coach = createCoach({ db: t.db, model: coachModel, voice: "v" });
    await coach.nudge!({ tester, turns: [{ role: "user", text: "hi" }], now: at(WED, "09:00"), moment: "kickoff", carry: { requestId: request.id } });
    const state = coachModel.requests[0]!.system.at(-1)!.text;
    expect(state).toContain(`THIS TEXT ALSO CARRIES the team's request [${requestRef(request.id)}]: Share https://example.com/sleep.`);
    expect(state).not.toContain("then mark_request_done");
  });
});

describe("send exactly this, through the nudge tick", () => {
  async function exact(tester: Tester, body: string, o: { sendNow?: boolean; at?: Date } = {}) {
    return addRequest(t.db, { testerId: tester.id, author: "Yanni", body, exact: true, sendNow: o.sendNow ?? false, at: o.at ?? now });
  }
  const sentTexts = () => t.sendblue.sends.map((s) => s.content);

  it("goes out word for word, once, and the thread says so", async () => {
    const tester = await seed();
    const request = await exact(tester, "Hey Sam! Thought of you today 📚");
    await scheduler.tick(at(TUE, "12:01"));
    await scheduler.tick(at(TUE, "12:02"));
    expect(sentTexts()).toEqual(["Hey Sam! Thought of you today 📚"]);
    const [row] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, request.id));
    const [message] = await t.db.select().from(messages).where(eq(messages.content, "Hey Sam! Thought of you today 📚"));
    expect(message).toMatchObject({ direction: "outbound", lineNumber: LINE });
    expect(row).toMatchObject({ requestStatus: "sent", messageId: message!.id });
    expect((await thread(tester.id)).at(-1)!.body).toContain("Done (sent word for word");
    // It counts toward the unanswered cap like ZOH's own texts.
    const [slot] = await t.db.select().from(nudges).where(and(eq(nudges.testerId, tester.id), eq(nudges.moment, TEAM_MOMENT)));
    expect(slot).toMatchObject({ status: "sent", kind: `team:${request.id}` });
  });

  it("waits through quiet hours and goes when they end", async () => {
    now = at(TUE, "23:00");
    const tester = await seed();
    await exact(tester, "Morning thought");
    await scheduler.tick(at(TUE, "23:30"));
    await scheduler.tick(at(WED, "08:59"));
    expect(sentTexts()).toEqual([]);
    await scheduler.tick(at(WED, "09:00"));
    expect(sentTexts()).toEqual(["Morning thought"]);
  });

  it("send now skips quiet hours, and only quiet hours", async () => {
    now = at(TUE, "23:00");
    const tester = await seed();
    await exact(tester, "Right now", { sendNow: true });
    await scheduler.tick(at(TUE, "23:01"));
    expect(sentTexts()).toEqual(["Right now"]);
  });

  it("never goes to a tester who stopped, send now or not", async () => {
    const tester = await seed({ stopped: true });
    await exact(tester, "One", { sendNow: true });
    await exact(tester, "Two");
    await scheduler.tick(at(TUE, "12:01"));
    await scheduler.tick(at(TUE, "23:01"));
    expect(sentTexts()).toEqual([]);
  });

  it(`never goes past ${MAX_UNANSWERED} unanswered texts from ZOH; goes once they reply`, async () => {
    const tester = await seed();
    for (const [i, kind] of ["kickoff", "checkin", "followup"].entries()) {
      const when = at(TUE, `09:0${i}`);
      const [m] = await t.db.insert(messages).values({ direction: "outbound", contactNumber: ME, content: kind, createdAt: when, sentAt: when }).returning();
      await t.db.insert(nudges).values({ testerId: tester.id, date: TUE, kind, moment: kind, status: "sent", messageId: m!.id, createdAt: when });
    }
    await exact(tester, "Fourth");
    await scheduler.tick(at(TUE, "12:01"));
    expect(sentTexts()).toEqual([]);
    await say(tester, "inbound", at(TUE, "12:05"), "sorry, busy day");
    await say(tester, "outbound", at(TUE, "12:06"), "No worries");
    await scheduler.tick(at(TUE, "12:10"));
    expect(sentTexts()).toEqual(["Fourth"]);
  });

  it("waits while a reply to their fresh text is being written", async () => {
    const tester = await seed();
    await exact(tester, "Hello");
    await say(tester, "inbound", at(TUE, "12:00"), "hey");
    await scheduler.tick(at(TUE, "12:01"));
    expect(sentTexts()).toEqual([]);
    await scheduler.tick(at(TUE, "12:03"));
    expect(sentTexts()).toEqual(["Hello"]);
  });

  it("a failed send isn't retried: the request is cancelled and the thread says so", async () => {
    const tester = await seed();
    const request = await exact(tester, "Hello");
    t.sendblue.failSend = true;
    await scheduler.tick(at(TUE, "12:01"));
    t.sendblue.failSend = false;
    await scheduler.tick(at(TUE, "12:02"));
    expect(t.sendblue.sends).toHaveLength(1);
    const [row] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, request.id));
    expect(row!.requestStatus).toBe("cancelled");
    expect((await thread(tester.id)).at(-1)!.body).toContain("Couldn't send your text");
  });

  it("goes out before onboarding is done too (any phase), and that tick sends nothing else", async () => {
    const tester = await seed({ phase: "planning" });
    await exact(tester, "Welcome aboard");
    const decisions = await scheduler.tick(at(TUE, "12:01"));
    expect(sentTexts()).toEqual(["Welcome aboard"]);
    expect(decisions.get(tester.id)).toEqual({ action: "none", reason: "sent the team's text" });
  });
});
