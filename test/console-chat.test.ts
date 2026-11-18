import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { CAPABILITIES, CONSOLE_INSTRUCTIONS, createConsoleCoach, nextChance, stepLog } from "../src/console/chat.js";
import { addRequest, addThreadLine, APP_AUTHOR, claimRequest, COACH_AUTHOR, NOT_SENT_TOPIC, requestRef } from "../src/console/requests.js";
import { createCoach } from "../src/coach/coach.js";
import { buildStateBlock, FIXED_INSTRUCTIONS, fullVoiceInstructions, NUDGES, PLAN_AGREEMENT, TEAM } from "../src/coach/prompt.js";
import { loadCoachState } from "../src/coach/state.js";
import { runTool } from "../src/coach/tools.js";
import { loadVoiceDoc, splitVoicePage } from "../src/coach/voice.js";
import { consoleMessages, messages, nudges, pauses, plans, stepDays, suggestions, testerGoals, testers, type ConsoleMessage, type Tester } from "../src/db/schema.js";
import { testerHeader, testerRows } from "../src/console/data.js";
import { addFounderSuggestion, suggestionsForCoach } from "../src/console/suggestions.js";
import { optOut } from "../src/testers/commands.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { createNudgeScheduler, MAX_UNANSWERED, EXACT_MOMENT, type NudgeScheduler } from "../src/nudges/scheduler.js";
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

/** A founder clicks Do it on the newest open draft (#155). */
async function confirmNewest(tester: Tester, as = "Yanni") {
  const draft = (await thread(tester.id)).filter((r) => r.kind === "draft" && r.draftStatus === "draft").at(-1);
  expect(draft).toBeDefined();
  now = new Date(now.getTime() + 60_000);
  return post(`/console/testers/${tester.id}/drafts/${draft!.id}/confirm`, {}, cookieFor(as));
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
    expect(res.headers.location).toBe(`/console/testers/${tester.id}?tab=console#chat`);
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
    expect(rows.at(-1)).toMatchObject({ kind: "coach", author: COACH_AUTHOR });
    expect(rows.at(-1)!.body).toContain("isn't set up");
  });

  it("a failed Claude call leaves an apology in the thread, not silence", async () => {
    const tester = await seed();
    model.script(new Error("Claude down"));
    await chat(tester, "how's she doing?");
    expect((await thread(tester.id)).at(-1)).toMatchObject({ kind: "coach", author: COACH_AUTHOR, body: "Sorry, I couldn't answer that just now. Try again?" });
    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}`, headers: { cookie: cookieFor("Yanni") } });
    expect(page.body).not.toContain("ZOH is thinking");
  });

  it("a word-for-word text drafted in quiet hours says it waits for them; to a stopped tester, it can't be drafted", async () => {
    now = at(TUE, "23:00");
    const tester = await seed();
    model.script({ tools: [{ name: "send_text", input: { words: "Night!" } }] }, "Ready.");
    await chat(tester, "send her exactly: Night!");
    expect((await thread(tester.id)).find((r) => r.kind === "draft")!.body).toContain("when their quiet hours end, at Wed 9:00 AM their time");
    await t.db.update(testers).set({ stoppedAt: now }).where(eq(testers.id, tester.id));
    model.script({ tools: [{ name: "send_text", input: { words: "Come back!", even_in_quiet_hours: true } }] }, "They've stopped.");
    await chat(tester, "send him now: Come back!");
    expect(JSON.stringify(model.requests.at(-1)!.messages.at(-1))).toContain("They texted stop");
    expect((await thread(tester.id)).filter((r) => r.kind === "draft")).toHaveLength(1);
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
    expect(page.body).not.toContain('name="exact"');
  });
});

describe("console coach capabilities", () => {
  it("is a list of capabilities, each drafted for a founder to confirm (#155)", () => {
    expect(Object.keys(CAPABILITIES)).toEqual(["save_note", "plan_request", "send_text", "suggest_next_step", "propose_plan_change", "decide_suggestion", "cancel", "take_back", "mark_alert"]);
  });

  it("suggest_next_step files the founder's next step as approved by them, shown in the chat as a card (#63)", async () => {
    const tester = await seed();
    model.script(
      { tools: [{ name: "suggest_next_step", input: { goal: "Read & learn more (books, ideas, any topic)", kind: "deepen", proposal: "15 pages a night", reasoning: "Two clean weeks" } }] },
      "Filed: a deepen on Read & learn more (books, ideas, any topic), 15 pages a night.",
    );
    await chat(tester, "let's bump her reading to 15 pages", { as: "Stamati" });
    expect(await t.db.select().from(suggestions)).toEqual([]);
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("File a next step for Sam (deepen on Read & learn more (books, ideas, any topic))");
    await confirmNewest(tester, "Stamati");
    const [row] = await t.db.select().from(suggestions).where(eq(suggestions.testerId, tester.id));
    expect(row).toMatchObject({ raisedBy: "founder", raisedByName: "Stamati", decision: "approved", decidedBy: "Stamati", goalSlug: "reading", kind: "deepen", proposal: "15 pages a night", reasoning: "Two clean weeks" });
    expect(await suggestionsForCoach(t.db, tester.id)).toHaveLength(1);
    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}`, headers: { cookie: cookieFor("Yanni") } });
    const chatHtml = page.body.slice(page.body.indexOf('<section id="chat">'), page.body.indexOf('<div id="side"'));
    expect(chatHtml).toContain("15 pages a night");
    expect(chatHtml).toContain("approved by Stamati");
  });

  it("suggest_next_step refuses an unknown goal, a new focus without one, and a stopped tester", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "suggest_next_step", input: { goal: "knitting", kind: "deepen", proposal: "x" } }] }, "Which goal?");
    await chat(tester, "suggest more knitting");
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain('No goal \\"knitting\\". Goals:');
    model.script({ tools: [{ name: "suggest_next_step", input: { goal: "reading", kind: "new_focus", proposal: "Switch focus" } }] }, "To which goal?");
    await chat(tester, "move her focus");
    expect(JSON.stringify(model.requests[3]!.messages.at(-1))).toContain("A new focus needs new_goal");
    expect(await t.db.select().from(suggestions).where(eq(suggestions.testerId, tester.id))).toHaveLength(0);
    await t.db.update(testers).set({ stoppedAt: now }).where(eq(testers.id, tester.id));
    model.script({ tools: [{ name: "suggest_next_step", input: { goal: "reading", kind: "deepen", proposal: "more" } }] }, "They've stopped.");
    await chat(tester, "bump her up");
    expect(JSON.stringify(model.requests[5]!.messages.at(-1))).toContain("They texted stop");
    expect(await t.db.select().from(suggestions).where(eq(suggestions.testerId, tester.id))).toHaveLength(0);
  });

  it("save_note stores the founder's context under their name", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "save_note", input: { note: "Traveling next week; go easy" } }] }, "Got it: I'll go easy on her next week.");
    await chat(tester, "she's traveling next week, go easy", { as: "Stamati" });
    expect((await thread(tester.id)).map((r) => [r.kind, r.author])).toEqual([
      ["founder", "Stamati"],
      ["draft", "Stamati"],
      ["coach", COACH_AUTHOR],
    ]);
    await confirmNewest(tester, "Yanni");
    const [note] = (await thread(tester.id)).filter((r) => r.kind === "note");
    expect(note).toMatchObject({ author: "Yanni", body: "Traveling next week; go easy" });
  });

  it("plan_request queues a request (with a not-before time in their zone); cancel_request cancels it", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "plan_request", input: { what: "Suggest a protein target", at: "2026-11-05 09:00" } }] }, "Got it. Thursday morning.");
    await chat(tester, "propose a protein target after Wednesday");
    expect((await thread(tester.id)).filter((r) => r.kind === "request")).toEqual([]);
    await confirmNewest(tester);
    const [request] = (await thread(tester.id)).filter((r) => r.kind === "request");
    expect(request).toMatchObject({ author: "Yanni", body: "Suggest a protein target", exact: false, requestStatus: "pending" });
    expect(request!.dueAt).toEqual(at("2026-11-05", "09:00"));
    // The draft told the coach when it goes.
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("not before Thu");

    model.script({ tools: [{ name: "cancel", input: { id: requestRef(request!.id) } }] }, "Cancelled.");
    await chat(tester, "actually cancel that");
    await confirmNewest(tester);
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

  it("an app line landing before the answer (an exact text queued, a Done) doesn't swallow the question", async () => {
    const tester = await seed();
    await addThreadLine(t.db, { testerId: tester.id, kind: "founder", author: "Yanni", body: "why did she miss Tuesday?", at: now });
    await addThreadLine(t.db, { testerId: tester.id, kind: "coach", author: APP_AUTHOR, body: "Queued word for word: it goes out within a minute.", at: new Date(now.getTime() + 1000) });
    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}`, headers: { cookie: cookieFor("Yanni") } });
    expect(page.body).toContain("ZOH is thinking");
    model.script("She didn't miss Tuesday.");
    expect(await createConsoleCoach({ db: t.db, model, voice: "v" }).answer(tester.id, new Date(now.getTime() + 2000))).toMatchObject({ author: COACH_AUTHOR, body: "She didn't miss Tuesday." });
  });

  it("reads the voice, not the texting coach's rule sections (#196)", async () => {
    const tester = await seed();
    await addThreadLine(t.db, { testerId: tester.id, kind: "founder", author: "Yanni", body: "how's she doing?", at: now });
    model.script("Doing well.");
    await createConsoleCoach({ db: t.db, model }).answer(tester.id, new Date(now.getTime() + 1000));
    const system = model.requests.at(-1)!.system[0]!.text;
    expect(system).toContain(`VOICE PAGE (how you text testers)\n${splitVoicePage(loadVoiceDoc()).voice}`);
    expect(system).not.toContain(PLAN_AGREEMENT);
    expect(system).not.toContain("<!-- rules:");
  });

  it("answers nothing when the latest founder line already has an answer", async () => {
    const tester = await seed();
    await chat(tester, "hi");
    const coach = createConsoleCoach({ db: t.db, model, voice: "v" });
    expect(await coach.answer(tester.id, now)).toBeUndefined();
    expect(model.requests).toHaveLength(1);
  });

  it("shows a dated step log: past days with how they went, rest days, today and the week ahead", async () => {
    const tester = await seed();
    const [plan] = await t.db
      .update(plans)
      .set({ days: ["mon", "wed", "fri"], startDate: "2026-10-26" })
      .where(eq(plans.testerId, tester.id))
      .returning();
    await t.db.insert(stepDays).values([
      { testerId: tester.id, date: "2026-10-28", planId: plan!.id, status: "missed" },
      { testerId: tester.id, date: "2026-10-30", planId: plan!.id, status: "done_reduced", note: "half" },
      { testerId: tester.id, date: "2026-11-02", planId: plan!.id, status: "done", step: "20 pages", stepKind: "harder" },
    ]);
    const log = await stepLog(t.db, tester, plan!, TUE);
    const lines = log.split("\n");
    expect(lines[0]).toBe("Tue, Oct 20: before this plan");
    expect(lines).toContain("Mon, Oct 26: step day, nothing recorded");
    expect(lines).toContain("Tue, Oct 27: rest day");
    expect(lines).toContain("Wed, Oct 28: missed");
    expect(lines).toContain("Fri, Oct 30: done (smaller version) (half)");
    // Each day's step with its kind (#88).
    expect(lines).toContain("Mon, Nov 2 (yesterday): done, step (harder): 20 pages");
    expect(lines).toContain("Tue, Nov 3 (today): rest day");
    expect(lines).toContain("Wed, Nov 4 (tomorrow): step day at 19:00");
    expect(lines.at(-1)).toBe("Tue, Nov 10: rest day");

    // The console coach gets it in its record.
    await chat(tester, "how's her week?");
    expect(model.requests[0]!.system.at(-1)!.text).toContain("STEP LOG (their focus goal");
    expect(model.requests[0]!.system.at(-1)!.text).toContain("Wed, Oct 28: missed");
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
    expect(fullVoiceInstructions()).toContain(TEAM);
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
    // #199: the sheet lists them as facts; never quoting a note, and doing a request as your own idea, are THE TEAM's.
    expect(block).toContain("FROM THE TEAM, notes:\n- Nov 3: Traveling next week");
    expect(block).toContain(`FROM THE TEAM, request [${requestRef(due.id)}], not done yet: Share https://example.com/sleep`);
    expect(TEAM).toContain("A note is context: let it shape how you coach; never quote it or say where it came from.");
    expect(TEAM).toContain("A request: do it as your own idea, in your voice, at a natural moment (this text if it fits), then mark_request_done.");
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
    // #199: under "This text carries", so the text doesn't drop it.
    expect(buildStateBlock(sameReply)).toContain(`This text carries (not sent yet):\n- the team's request [${requestRef(request.id)}] (you marked it done): Share the sleep article`);
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

  it("the carried request is written by the real coach from its This text carries line", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Share https://example.com/sleep", exact: false, sendNow: false, at: now });
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    await t.db.insert(stepDays).values({ testerId: tester.id, date: TUE, planId: plan!.id, status: "done" });
    const coachModel = new FakeClaudeModel("Kalimera Sam! Saw this and thought of you: https://example.com/sleep");
    const coach = createCoach({ db: t.db, model: coachModel, voice: "v" });
    await coach.nudge!({ tester, turns: [{ role: "user", text: "hi" }], now: at(WED, "09:00"), moment: "kickoff", carry: { requestId: request.id } });
    const state = coachModel.requests[0]!.system.at(-1)!.text;
    // #199: a fact about this text, recorded by the app; how a carried text does it is NUDGES'.
    expect(state).toContain(`This text carries (not sent yet):\n- the team's request [${requestRef(request.id)}] (the app records it): Share https://example.com/sleep`);
    expect(state).not.toContain("then mark_request_done");
    expect(state).not.toContain("not done yet");
    expect(NUDGES).toContain("What a text carries (state): in place of its usual question, as its only one, and as your own idea; 1 to 3 sentences, no proof ask.");
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
    const [slot] = await t.db.select().from(nudges).where(and(eq(nudges.testerId, tester.id), eq(nudges.moment, EXACT_MOMENT)));
    expect(slot).toMatchObject({ status: "sent", kind: `exact:${request.id}` });
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

describe("a request stuck going out (#188)", () => {
  // The app died between claiming a request for the text going out and finishing the send: the claim is left.
  async function stuck(tester: Tester, o: { exact: boolean; claimedAt: Date }) {
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Hey Sam! Thought of you today", exact: o.exact, sendNow: false, at: now });
    expect(await claimRequest(t.db, request.id, o.claimedAt)).toBe(true);
    return request;
  }
  const status = async (id: string) => (await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, id)))[0]!.requestStatus;
  const notSent = async (testerId: string) =>
    (await thread(testerId)).filter((r) => r.kind === "alert" && r.topic === NOT_SENT_TOPIC);
  const mayNot = async (testerId: string) => (await thread(testerId)).filter((r) => r.kind === "coach" && r.body.startsWith("May not have gone out"));

  for (const exact of [true, false]) {
    it(`${exact ? "a word-for-word text" : "a request the morning text carried"}: cancelled after 15 minutes, once, with a line and an alert`, async () => {
      const tester = await seed();
      const request = await stuck(tester, { exact, claimedAt: at(TUE, "12:00") });
      await scheduler.tick(at(TUE, "12:16"));
      expect(await status(request.id)).toBe("cancelled");
      expect(await mayNot(tester.id)).toHaveLength(1);
      expect((await mayNot(tester.id))[0]!.body).toBe("May not have gone out (the app stopped while sending it): check their messages and resend if needed: Hey Sam! Thought of you today");
      expect(await notSent(tester.id)).toHaveLength(1);
      expect(t.sendblue.sends).toEqual([]);
      await scheduler.tick(at(TUE, "12:17"));
      expect(await mayNot(tester.id)).toHaveLength(1);
      expect(await notSent(tester.id)).toHaveLength(1);
    });
  }

  it("one claimed a minute ago is still going out: left alone", async () => {
    const tester = await seed();
    const request = await stuck(tester, { exact: true, claimedAt: at(TUE, "12:00") });
    await scheduler.tick(at(TUE, "12:01"));
    expect(await status(request.id)).toBe("sending");
    expect(await mayNot(tester.id)).toEqual([]);
    expect(await notSent(tester.id)).toEqual([]);
  });
});

describe("when a request goes: agreed in the console chat", () => {
  /** Has the console coach queue a request with these inputs, and returns it. */
  async function queue(tester: Tester, input: Record<string, unknown>): Promise<ConsoleMessage | undefined> {
    model.script({ tools: [{ name: "plan_request", input: { what: "Ask how the new shoes feel", ...input } }] }, "Got it.");
    await chat(tester, "text him about the shoes");
    const draft = (await thread(tester.id)).find((r) => r.kind === "draft" && r.draftStatus === "draft");
    // Confirmed right away, at the time it was drafted.
    if (draft) await post(`/console/testers/${tester.id}/drafts/${draft.id}/confirm`, {}, cookieFor("Yanni"));
    return (await thread(tester.id)).find((r) => r.kind === "request");
  }
  const toolResult = () => JSON.stringify(model.requests.at(-1)!.messages.at(-1));
  const nudgeMoments = () => t.replier.nudges.map((n) => n.moment);

  it("\"now\" is its own text, due now, dropped once their day ends", async () => {
    const tester = await seed();
    const request = await queue(tester, { when: "own_text" });
    expect(request).toMatchObject({ delivery: "own_text", requestStatus: "pending" });
    expect(request!.dueAt).toEqual(now);
    expect(request!.expiresAt).toEqual(at(TUE, "22:00"));
    expect(toolResult()).toContain("its own text, within a minute");
  });

  it("its own text at a time in their quiet hours is refused, with what to offer instead", async () => {
    const tester = await seed();
    expect(await queue(tester, { when: "own_text", at: "2026-11-03 23:30" })).toBeUndefined();
    expect(toolResult()).toContain("inside their quiet hours (22:00 to 09:00 their time)");
  });

  it("with the morning text needs a locked plan; a too-late-after time must come after it can go", async () => {
    const planning = await seed({ phase: "planning" });
    expect(await queue(planning, { when: "morning" })).toBeUndefined();
    expect(toolResult()).toContain("no morning texts yet");
    await t.db.update(testers).set({ phase: "active" }).where(eq(testers.id, planning.id));
    expect(await queue({ ...planning, phase: "active" }, { when: "own_text", at: "2026-11-03 17:00", too_late_after: "2026-11-03 16:00" })).toBeUndefined();
    expect(toolResult()).toContain("too_late_after has to be after");
  });

  it("the tick sends its own text at the agreed time, written by ZOH, and marks it done", async () => {
    const tester = await seed();
    const request = await queue(tester, { when: "own_text", at: "2026-11-03 17:00" });
    await scheduler.tick(at(TUE, "16:59"));
    expect(nudgeMoments()).toEqual([]);
    await scheduler.tick(at(TUE, "17:00"));
    expect(t.replier.nudges.at(-1)).toMatchObject({ moment: "team", carry: { requestId: request!.id } });
    const [sent] = await t.db.select().from(messages).where(eq(messages.content, "Yo, team text"));
    const [row] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, request!.id));
    expect(row).toMatchObject({ requestStatus: "done", messageId: sent!.id });
    expect((await thread(tester.id)).at(-1)!.body).toContain("Done (in its own text");
    // A nudge like ZOH's own: it takes a slot and counts toward the unanswered cap.
    const [slot] = await t.db.select().from(nudges).where(eq(nudges.kind, `team:${request!.id}`));
    expect(slot).toMatchObject({ moment: "team", status: "sent" });
    await scheduler.tick(at(TUE, "17:01"));
    expect(nudgeMoments()).toEqual(["team"]);
  });

  it("the texting coach writes it as the text's whole job", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Ask how the new shoes feel", exact: false, sendNow: false, delivery: "own_text", dueAt: now, at: now });
    const coachModel = new FakeClaudeModel("Sam! How are the new shoes feeling?");
    const coach = createCoach({ db: t.db, model: coachModel, voice: "v" });
    await coach.nudge!({ tester, turns: [{ role: "user", text: "hi" }], now, moment: "team", carry: { requestId: request.id } });
    // #199: the sheet says this text carries it; that it's the text's whole job is THE TEAM's (NUDGE MOMENT team).
    const state = coachModel.requests[0]!.system.at(-1)!.text;
    expect(state).toContain(`- the team's request [${requestRef(request.id)}] (the app records it): Ask how the new shoes feel`);
    expect(state).toContain("NUDGE MOMENT: team.");
    expect(TEAM).toContain("NUDGE MOMENT team: a text they asked you to send. Its one job is the request, as your own idea; no step or proof push.");
  });

  it("follows the nudge rules: never after a stop or past 3 unanswered; dropped with a note when it's too late", async () => {
    const stopped = await seed({ stopped: true });
    await addRequest(t.db, { testerId: stopped.id, author: "Yanni", body: "Hi", exact: false, sendNow: false, delivery: "own_text", dueAt: now, expiresAt: at(TUE, "22:00"), at: now });
    await scheduler.tick(at(TUE, "12:01"));
    expect(nudgeMoments()).toEqual([]);
    await scheduler.tick(at(TUE, "22:00"));
    expect((await thread(stopped.id)).findLast((r) => r.kind === "coach")!.body).toBe("Didn't go out in time (they texted stop), so I dropped it: Hi");
    // #155: the founders get an alert for what couldn't go out.
    expect((await thread(stopped.id)).findLast((r) => r.kind === "alert")).toMatchObject({ topic: "not_sent" });
  });

  it("past 3 unanswered texts it waits, and is dropped (not sent tomorrow) when their day ends", async () => {
    const tester = await seed();
    for (const [i, kind] of ["kickoff", "checkin", "followup"].entries()) {
      const when = at(TUE, `09:0${i}`);
      await t.db.insert(nudges).values({ testerId: tester.id, date: TUE, kind, moment: kind, status: "sent", createdAt: when });
    }
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Ask about the shoes", exact: false, sendNow: false, delivery: "own_text", dueAt: now, expiresAt: at(TUE, "22:00"), at: now });
    await scheduler.tick(at(TUE, "12:01"));
    expect(nudgeMoments()).toEqual([]);
    await scheduler.tick(at(TUE, "22:00"));
    const [row] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, request.id));
    expect(row!.requestStatus).toBe("cancelled");
    expect((await thread(tester.id)).findLast((r) => r.kind === "coach")!.body).toContain("Didn't go out in time (3 texts from ZOH unanswered)");
    await scheduler.tick(at(WED, "09:00"));
    expect(nudgeMoments()).not.toContain("team");
  });

  it("mid-conversation it rides in ZOH's reply instead of a text on top; after 10 quiet minutes it goes on its own", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Ask about the shoes", exact: false, sendNow: false, delivery: "own_text", dueAt: now, at: now });
    await say(tester, "inbound", at(TUE, "11:55"), "hey");
    await scheduler.tick(at(TUE, "12:00"));
    expect(nudgeMoments()).toEqual([]);
    const reply = buildStateBlock(await loadCoachState(t.db, tester, { now: at(TUE, "12:00"), isFirstText: false }));
    expect(reply).toContain(`FROM THE TEAM, request [${requestRef(request.id)}], not done yet: Ask about the shoes`);
    await scheduler.tick(at(TUE, "12:05"));
    expect(nudgeMoments()).toEqual(["team"]);
  });

  it("with the morning text: never in a reply, carried by the next morning text", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Share the sleep article", exact: false, sendNow: false, delivery: "morning", at: now });
    expect(buildStateBlock(await loadCoachState(t.db, tester, { now, isFirstText: false }))).not.toContain("Share the sleep article");
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    await t.db.insert(stepDays).values({ testerId: tester.id, date: TUE, planId: plan!.id, status: "done" });
    await scheduler.tick(at(WED, "09:00"));
    expect(t.replier.nudges.at(-1)).toMatchObject({ moment: "kickoff", carry: { requestId: request.id } });
  });

  it("the page shows each request's timing", async () => {
    const tester = await seed();
    await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Shoes", exact: false, sendNow: false, delivery: "own_text", dueAt: at(TUE, "17:00"), expiresAt: at(TUE, "22:00"), at: now });
    await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Article", exact: false, sendNow: false, delivery: "morning", at: now });
    const page = await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}`, headers: { cookie: cookieFor("Yanni") } });
    expect(page.body).toContain("its own text");
    expect(page.body).toContain("at Nov 3, 5:00 PM");
    expect(page.body).toContain("dropped if not out by Nov 3, 10:00 PM");
    expect(page.body).toContain("with the morning text");
  });
});

describe("#155: the console chat drafts, a founder confirms", () => {
  const drafts = async (testerId: string) => (await thread(testerId)).filter((r) => r.kind === "draft");
  const confirm = (tester: Tester, draft: ConsoleMessage, as = "Yanni") => post(`/console/testers/${tester.id}/drafts/${draft.id}/confirm`, {}, cookieFor(as));
  const toolResults = () => JSON.stringify(model.requests.at(-1)!.messages.at(-1));
  const page = async (tester: Tester) => (await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}`, headers: { cookie: cookieFor("Yanni") } })).body;

  it("#162: asked to find something, it searches and drafts it; nothing reaches the tester until a founder confirms", async () => {
    const tester = await seed();
    model.script(
      {
        web: [{ search: "beginner reading habit guide", results: ["https://jamesclear.com/reading"] }],
        tools: [{ name: "send_text", input: { words: "Found you a short one on making reading stick: https://jamesclear.com/reading" } }],
      },
      "Drafted it with the link.",
    );
    await chat(tester, "find Sam something good on sticking with reading");
    expect((model.requests[0]!.tools as { name: string }[]).map((x) => x.name)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    const [draft] = await drafts(tester.id);
    expect(draft).toMatchObject({ draftStatus: "draft", draftAction: "send_text" });
    expect(draft!.body).toContain("https://jamesclear.com/reading");
    await scheduler.tick(at(TUE, "12:05"));
    expect(t.sendblue.sends).toEqual([]);
    expect((await confirm(tester, draft!)).statusCode).toBe(303);
    await scheduler.tick(at(TUE, "12:06"));
    await scheduler.tick(at(TUE, "12:07"));
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["Found you a short one on making reading stick: https://jamesclear.com/reading"]);
  });

  it("a plan change in chat is only a draft: nothing changes and nothing is pending until a founder confirms", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "propose_plan_change", input: { time: "07:30", place: "the gym" } }] }, "Here's the draft.");
    await chat(tester, "let's get her on mornings, 7:30 at the gym");
    const [draft] = await drafts(tester.id);
    expect(draft).toMatchObject({ draftStatus: "draft", draftAction: "propose_plan_change", author: "Yanni" });
    expect(draft!.body).toContain("Propose to Sam");
    expect(draft!.body).toContain("7:30 am");
    expect(draft!.body).toContain("asks them first");
    expect(await t.db.select().from(suggestions)).toEqual([]);
    const html = await page(tester);
    expect(html).toContain("Do it");
    expect(html.slice(html.indexOf('id="waiting-on-tester"'))).not.toContain("7:30");

    // Do it: a founder-approved plan change, waiting on the tester; the plan is untouched.
    expect((await confirm(tester, draft!)).statusCode).toBe(303);
    const [s] = await t.db.select().from(suggestions);
    expect(s).toMatchObject({ kind: "adjust", raisedBy: "founder", decision: "approved", decidedBy: "Yanni", planChanges: { stepTime: "07:30", place: "the gym" } });
    expect((await drafts(tester.id))[0]).toMatchObject({ draftStatus: "confirmed" });
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    expect(plan!.stepTime).toBe("19:00");
    const after = await page(tester);
    expect(after.slice(after.indexOf('id="waiting-on-tester"'))).toContain("7:30");

    // A second click (or the other founder's) does nothing more.
    expect((await confirm(tester, draft!, "Stamati")).statusCode).toBe(409);
    expect(await t.db.select().from(suggestions)).toHaveLength(1);
  });

  it("\"reject it\" in chat: a draft, then a typed yes rejects it exactly as the button would", async () => {
    const tester = await seed();
    const [waiting] = await t.db.insert(suggestions).values({ testerId: tester.id, goalSlug: "reading", kind: "new_focus", newGoalSlug: "exercise", raisedBy: "tester", proposal: "Learn the cube" }).returning();
    await t.db.insert(consoleMessages).values({ testerId: tester.id, kind: "alert", topic: "new_goal_request", eventKey: `suggestion:${waiting!.id}`, body: "They asked", suggestionId: waiting!.id });
    const ref = waiting!.id.slice(0, 8);
    model.script({ tools: [{ name: "decide_suggestion", input: { suggestion: ref, decision: "reject", reason: "stick with interviews for now" } }] }, "Draft's up.");
    await chat(tester, "reject it, he should stick with the interviews for now");
    expect((await t.db.select().from(suggestions))[0]!.decision).toBe("waiting");
    expect((await drafts(tester.id))[0]!.body).toContain("Reject");

    model.script({ tools: [{ name: "confirm_draft", input: {} }] }, "Done: rejected.");
    await chat(tester, "yes, do it");
    expect((await t.db.select().from(suggestions))[0]).toMatchObject({ decision: "rejected", decidedBy: "Yanni", decisionReason: "stick with interviews for now" });
    const [alert] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "alert"));
    expect(alert!.seenBy).toBe("Yanni");
    const html = await page(tester);
    expect(html).not.toContain('value="approved"');
    expect(html.slice(html.indexOf('id="needs-you"'))).not.toContain("Learn the cube");
  });

  it("the console coach sees next steps waiting for the founders, and knows a draft it just made is its own", async () => {
    const tester = await seed();
    const [waiting] = await t.db.insert(suggestions).values({ testerId: tester.id, goalSlug: "reading", kind: "new_focus", newGoalSlug: "exercise", raisedBy: "tester", proposal: "Learn the cube" }).returning();
    model.script({ tools: [{ name: "save_note", input: { note: "Busy week" } }] }, "Drafted.");
    await chat(tester, "she's busy this week");
    const first = model.requests[0]!.system.at(-1)!.text;
    expect(first).toContain(`[${waiting!.id.slice(0, 8)}] new focus to exercise, raised by them: Learn the cube`);
    expect(model.requests[1]!.system.at(-1)!.text).toContain("you just drafted it in this answer");
  });

  it("can't confirm its own draft in the answer that made it: only after the founder says so", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "save_note", input: { note: "Traveling next week, go easy" } }, { name: "confirm_draft", input: {} }] }, "Saved.");
    await chat(tester, "she's traveling next week, go easy");
    expect(toolResults()).toContain("only once they say so");
    expect((await drafts(tester.id))[0]).toMatchObject({ draftStatus: "draft" });
    expect((await thread(tester.id)).some((r) => r.kind === "note")).toBe(false);
  });

  it("a text drafted and confirmed goes out word for word, exactly once", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "send_text", input: { words: "Proud of you Sam!" } }] }, "Ready when you are.");
    await chat(tester, "send her exactly: Proud of you Sam!");
    const [draft] = await drafts(tester.id);
    expect(draft!.body).toContain('"Proud of you Sam!"');
    const clicks = await Promise.all([confirm(tester, draft!), confirm(tester, draft!, "Stamati")]);
    expect(clicks.map((r) => r.statusCode).sort()).toEqual([303, 409]);
    const requests = (await thread(tester.id)).filter((r) => r.kind === "request");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ exact: true, body: "Proud of you Sam!", requestStatus: "pending" });
    // Dropped at the end of their day if it couldn't go out by then.
    expect(requests[0]!.expiresAt).toEqual(at(TUE, "22:00"));
    await scheduler.tick(at(TUE, "12:05"));
    await scheduler.tick(at(TUE, "12:06"));
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["Proud of you Sam!"]);
  });

  it("confirming for a tester who has since stopped does nothing and says why", async () => {
    const tester = await seed();
    model.script({ tools: [{ name: "send_text", input: { words: "Hey!" } }] }, "Ready.");
    await chat(tester, "send him: Hey!");
    const [draft] = await drafts(tester.id);
    await t.db.update(testers).set({ stoppedAt: now }).where(eq(testers.id, tester.id));
    await confirm(tester, draft!);
    expect((await drafts(tester.id))[0]).toMatchObject({ draftStatus: "failed", draftResult: expect.stringContaining("stop") });
    expect((await thread(tester.id)).some((r) => r.kind === "request")).toBe(false);
  });

  it("a request a kickoff carries stays in the coach's state while it's claimed for that text", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Share https://example.com/sleep", exact: false, sendNow: false, at: now });
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    await t.db.insert(stepDays).values({ testerId: tester.id, date: TUE, planId: plan!.id, status: "done" });
    const coachModel = new FakeClaudeModel("Kalimera Sam! Saw this and thought of you: https://example.com/sleep");
    const real = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: createCoach({ db: t.db, model: coachModel, voice: "v" }), allowedNumbers: [ME], lineNumber: LINE });
    await real.tick(at(WED, "09:00"));
    await real.stop();
    expect(coachModel.stateOf()).toContain(`This text carries (not sent yet):\n- the team's request [${requestRef(request.id)}]`);
    expect((await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, request.id)))[0]!.requestStatus).toBe("done");
  });

  it("cancelling a live text before it goes means it never reaches them; once it's going out, cancel is refused", async () => {
    const tester = await seed();
    const one = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "One", exact: true, sendNow: false, at: now });
    expect((await post(`/console/testers/${tester.id}/requests/${one.id}/cancel`, {}, cookieFor("Yanni"))).statusCode).toBe(303);
    await scheduler.tick(at(TUE, "12:05"));
    expect(t.sendblue.sends).toEqual([]);
    const two = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Two", exact: true, sendNow: false, at: now });
    await t.db.update(consoleMessages).set({ requestStatus: "sending" }).where(eq(consoleMessages.id, two.id));
    expect((await post(`/console/testers/${tester.id}/requests/${two.id}/cancel`, {}, cookieFor("Yanni"))).statusCode).toBe(409);
  });

  it("the scheduler claims a request before it sends, so a Cancel clicked mid-send is refused (word for word or carried)", async () => {
    const tester = await seed();
    const exact = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "One", exact: true, sendNow: false, at: now });
    const carried = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Share https://example.com/sleep", exact: false, sendNow: false, at: now });
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    await t.db.insert(stepDays).values({ testerId: tester.id, date: TUE, planId: plan!.id, status: "done" });
    const midSend: number[] = [];
    const send = t.sendblue.sendMessage.bind(t.sendblue);
    t.sendblue.sendMessage = async (input) => {
      const open = await t.db.select().from(consoleMessages).where(eq(consoleMessages.requestStatus, "sending"));
      for (const r of open) midSend.push((await post(`/console/testers/${tester.id}/requests/${r.id}/cancel`, {}, cookieFor("Yanni"))).statusCode);
      return send(input);
    };
    await scheduler.tick(at(TUE, "12:05"));
    const coachModel = new FakeClaudeModel("Kalimera Sam! Saw this and thought of you: https://example.com/sleep");
    const real = createNudgeScheduler({ db: t.db, log: silent, sendblue: t.sendblue, replier: createCoach({ db: t.db, model: coachModel, voice: "v" }), allowedNumbers: [ME], lineNumber: LINE });
    await real.tick(at(WED, "09:00"));
    await real.stop();
    expect(midSend).toEqual([409, 409]);
    const status = async (id: string) => (await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, id)))[0]!.requestStatus;
    expect([await status(exact.id), await status(carried.id)]).toEqual(["sent", "done"]);
  });

  it("a plan change ZOH already raised is taken back with a note ZOH carries, not cancelled silently", async () => {
    const tester = await seed();
    const s = await addFounderSuggestion(t.db, { testerId: tester.id, goalSlug: "reading", kind: "adjust", proposal: "Step at 7:30 am", planChanges: { stepTime: "07:30" }, by: "Yanni", at: now });
    await t.db.update(suggestions).set({ outcome: "delivered", deliveredAt: now }).where(eq(suggestions.id, s.id));
    model.script({ tools: [{ name: "cancel", input: { id: s.id.slice(0, 8) } }] }, "It's already been raised.");
    await chat(tester, "cancel the morning idea");
    expect(toolResults()).toContain("take_back");
    model.script({ tools: [{ name: "take_back", input: { suggestion: s.id.slice(0, 8), say: "let's keep your evenings as they are" } }] }, "Draft's up.");
    await chat(tester, "ok take it back");
    const [draft] = (await drafts(tester.id)).filter((d) => d.draftStatus === "draft");
    await confirm(tester, draft!);
    expect((await t.db.select().from(suggestions))[0]!.decision).toBe("withdrawn");
    const [note] = (await thread(tester.id)).filter((r) => r.kind === "request");
    expect(note).toMatchObject({ exact: false, requestStatus: "pending" });
    expect(note!.body).toContain("let's keep your evenings as they are");
  });

  it("texting stop clears what's queued for them", async () => {
    const tester = await seed();
    const request = await addRequest(t.db, { testerId: tester.id, author: "Yanni", body: "Ask about the trip", exact: false, sendNow: false, at: now });
    const s = await addFounderSuggestion(t.db, { testerId: tester.id, goalSlug: "reading", kind: "adjust", proposal: "Step at 7:30 am", planChanges: { stepTime: "07:30" }, by: "Yanni", at: now });
    await optOut(t.db, tester, now);
    const [row] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, request.id));
    expect(row!.requestStatus).toBe("cancelled");
    expect((await t.db.select().from(suggestions).where(eq(suggestions.id, s.id)))[0]!.decision).toBe("withdrawn");
  });

  it("the chat box has no send-options checkboxes any more: everything goes through the chat", async () => {
    const tester = await seed();
    const html = await page(tester);
    expect(html).not.toContain("Send exactly this");
    expect(html).not.toContain('name="sendNow"');
  });
});

describe("#69: marking an alert from the chat", () => {
  it("\"mark it reviewed\" is a draft; confirmed, it does what the button does", async () => {
    const tester = await seed();
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    await t.db.update(plans).set({ needsReview: true }).where(eq(plans.id, plan!.id));
    await t.db.insert(consoleMessages).values({ testerId: tester.id, kind: "alert", topic: "plan_review", eventKey: `plan_review:${plan!.id}`, body: "Plan version 1 to review", planId: plan!.id, createdAt: at(TUE, "10:00") });
    const [alert] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "alert"));
    // The console coach sees the alert with its id.
    model.script("It's her first plan, already active since she committed.");
    await chat(tester, "what's this plan review about?");
    expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain(`alert ${alert!.id.slice(0, 8)}: plan_review`);

    model.script({ tools: [{ name: "mark_alert", input: { alert: alert!.id.slice(0, 8) } }] }, "Draft's up.");
    await chat(tester, "mark it reviewed");
    expect((await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, alert!.id)))[0]!.seenAt).toBeNull();
    const draft = (await thread(tester.id)).find((r) => r.kind === "draft");
    expect(draft!.body).toContain("Mark reviewed");
    await confirmNewest(tester);
    expect((await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, alert!.id)))[0]).toMatchObject({ seenBy: "Yanni" });
    expect((await t.db.select().from(plans).where(eq(plans.id, plan!.id)))[0]!.needsReview).toBe(false);
  });
});

describe("#214: drafts under Needs You", () => {
  const page = async (tester: Tester) => (await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}`, headers: { cookie: cookieFor("Yanni") } })).body;
  /** The Needs You list, cut out of the page. */
  const needsYou = (html: string) => html.slice(html.indexOf('id="needs-you"'), html.indexOf('id="waiting-on-tester"'));
  const waitingOn = (html: string) => html.slice(html.indexOf('id="waiting-on-tester"'));
  const updates = async (tester: Tester, live: string[]) =>
    (await t.app.inject({ method: "GET", url: `/console/testers/${tester.id}/updates?thread=1&live=${live.join(",")}`, headers: { cookie: cookieFor("Yanni") } })).json() as {
      side: { sig: string; html: string };
      cards?: { id: string; html: string }[];
    };
  async function draftPlanChange(tester: Tester) {
    model.script({ tools: [{ name: "propose_plan_change", input: { time: "07:30" } }] }, "Here's the draft.");
    await chat(tester, "move her to 7:30");
    return (await thread(tester.id)).find((r) => r.kind === "draft")!;
  }

  it("a draft shows in chat and under Needs You, with its buttons; nothing is sent and the plan is unchanged", async () => {
    const tester = await seed();
    const draft = await draftPlanChange(tester);
    model.script({ tools: [{ name: "save_note", input: { note: "Traveling next week" } }] }, "Noted.");
    await chat(tester, "she's traveling next week");
    model.script({ tools: [{ name: "send_text", input: { words: "Safe travels!" } }] }, "Drafted.");
    await chat(tester, "text her safe travels");
    const html = needsYou(await page(tester));
    expect(html).toContain("7:30 am");
    expect(html).toContain("Traveling next week");
    expect(html).toContain("Safe travels!");
    expect(html).toContain(`/drafts/${draft.id}/confirm`);
    expect(html).toContain(`/drafts/${draft.id}/cancel`);
    expect(html).toContain(`draft [${draft.id.slice(0, 8)}]`);
    expect(html).toContain('<span class="badge">3</span>');
    expect(await t.db.select().from(suggestions)).toEqual([]);
    expect((await t.db.select().from(plans).where(eq(plans.testerId, tester.id)))[0]!.stepTime).toBe("19:00");
    await scheduler.tick(at(TUE, "12:10"));
    expect(t.sendblue.sends).toEqual([]);
  });

  it("Do it from Needs You: it leaves Needs You, runs once, waits on the tester, and the chat card says so too", async () => {
    const tester = await seed();
    const draft = await draftPlanChange(tester);
    const before = await updates(tester, [draft.id]);
    expect(before.cards![0]!.html).toContain("Do it");
    expect(needsYou(before.side.html)).toContain(`/drafts/${draft.id}/confirm`);
    expect((await post(`/console/testers/${tester.id}/drafts/${draft.id}/confirm`, {}, cookieFor("Stamati"))).statusCode).toBe(303);
    const html = await page(tester);
    expect(needsYou(html)).not.toContain("7:30 am");
    expect(waitingOn(html)).toContain("7:30");
    expect(await t.db.select().from(suggestions)).toHaveLength(1);
    // The other tab's next poll: a new side panel and the chat card swapped for its confirmed version.
    const after = await updates(tester, [draft.id]);
    expect(after.side.sig).not.toBe(before.side.sig);
    expect(needsYou(after.side.html)).not.toContain("7:30 am");
    expect(after.cards![0]!.html).not.toContain("Do it");
    expect(after.cards![0]!.html).toContain("Proposed [");
    // A second click, from either place, does nothing more.
    expect((await post(`/console/testers/${tester.id}/drafts/${draft.id}/confirm`, {}, cookieFor("Yanni"))).statusCode).toBe(409);
    expect(await t.db.select().from(suggestions)).toHaveLength(1);
  });

  it("Cancel from Needs You: gone from both places, nothing happens, the plan is kept", async () => {
    const tester = await seed();
    const draft = await draftPlanChange(tester);
    expect(needsYou(await page(tester))).toContain(`/drafts/${draft.id}/cancel`);
    expect((await post(`/console/testers/${tester.id}/drafts/${draft.id}/cancel`, {}, cookieFor("Yanni"))).statusCode).toBe(303);
    const html = await page(tester);
    expect(needsYou(html)).not.toContain("7:30 am");
    expect(waitingOn(html)).not.toContain("7:30");
    expect((await updates(tester, [draft.id])).cards![0]!.html).not.toContain("Do it");
    expect(await t.db.select().from(suggestions)).toEqual([]);
    expect((await t.db.select().from(plans).where(eq(plans.testerId, tester.id)))[0]!.stepTime).toBe("19:00");
  });

  it("badges count an open draft once; a draft deciding a waiting next step or marking an alert adds nothing", async () => {
    const tester = await seed();
    const count = async () => {
      const h = (await testerHeader(t.db, tester.id, now))!;
      const row = (await testerRows(t.db, now)).find((r) => r.tester.id === tester.id)!;
      expect(row.alertsWaiting + row.suggestionsWaiting + row.draftsWaiting).toBe(h.alertsWaiting + h.suggestionsWaiting + h.draftsWaiting);
      return h.alertsWaiting + h.suggestionsWaiting + h.draftsWaiting;
    };
    expect(await count()).toBe(0);
    await draftPlanChange(tester);
    expect(await count()).toBe(1);
    // A next step waiting for the founders, with its unseen alert: counted once.
    const [waiting] = await t.db.insert(suggestions).values({ testerId: tester.id, goalSlug: "reading", kind: "deepen", raisedBy: "coach", proposal: "15 pages" }).returning();
    await t.db.insert(consoleMessages).values({ testerId: tester.id, kind: "alert", topic: "next_step", eventKey: `suggestion:${waiting!.id}`, body: "A next step", suggestionId: waiting!.id });
    expect(await count()).toBe(2);
    model.script({ tools: [{ name: "decide_suggestion", input: { suggestion: waiting!.id.slice(0, 8), decision: "approve" } }] }, "Draft's up.");
    await chat(tester, "approve it");
    const [alert] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "alert"));
    model.script({ tools: [{ name: "mark_alert", input: { alert: alert!.id.slice(0, 8) } }] }, "Draft's up.");
    await chat(tester, "mark it seen");
    expect((await thread(tester.id)).filter((r) => r.kind === "draft" && r.draftStatus === "draft")).toHaveLength(3);
    expect(await count()).toBe(2);
    // The waiting next step still shows and works as before.
    expect(needsYou(await page(tester))).toContain("15 pages");
  });
});

describe("#214: when ZOH asks about a founder's proposal", () => {
  const nudgeMoments = () => t.replier.nudges.map((n) => n.moment);
  const toolResult = () => JSON.stringify(model.requests.at(-1)!.messages.at(-1));
  /** Drafts and confirms a founder proposal through the chat; returns the draft and its suggestion. */
  async function propose(tester: Tester, input: Record<string, unknown>, tool = "propose_plan_change") {
    model.script({ tools: [{ name: tool, input }] }, "Here's the draft.");
    await chat(tester, "propose it");
    const draft = (await thread(tester.id)).findLast((r) => r.kind === "draft");
    expect(draft).toBeDefined();
    expect((await post(`/console/testers/${tester.id}/drafts/${draft!.id}/confirm`, {}, cookieFor("Yanni"))).statusCode).toBe(303);
    return { draft: draft!, suggestion: (await t.db.select().from(suggestions).orderBy(asc(suggestions.createdAt))).at(-1)! };
  }
  const reply = async (tester: Tester, when: Date) => buildStateBlock(await loadCoachState(t.db, tester, { now: when, isFirstText: false }));
  const notRaised = "Next step the team approved, not raised yet";

  it("\"now\": the card says so; ZOH's own text asks it within a minute, once; the plan waits for their answer", async () => {
    const tester = await seed();
    const { draft, suggestion } = await propose(tester, { time: "20:00", when: "now" });
    expect(draft.body).toContain("in its own text now");
    expect(suggestion.delivery).toBe("own_text");
    await scheduler.tick(new Date(now.getTime() + 60_000));
    expect(t.replier.nudges.at(-1)).toMatchObject({ moment: "team", carry: { suggestionId: suggestion.id } });
    expect((await t.db.select().from(suggestions))[0]).toMatchObject({ outcome: "delivered" });
    expect((await t.db.select().from(plans).where(eq(plans.testerId, tester.id)))[0]!.stepTime).toBe("19:00");
    // Raised once: neither the next tick nor a reply raises it again.
    await scheduler.tick(new Date(now.getTime() + 120_000));
    expect(nudgeMoments()).toEqual(["team"]);
    expect(await reply(tester, new Date(now.getTime() + 180_000))).not.toContain(notRaised);
  });

  it("\"now\" mid-conversation: the reply carries it; after 10 quiet minutes it goes on its own", async () => {
    const tester = await seed();
    await say(tester, "inbound", new Date(now.getTime() + 30_000), "hey");
    const { suggestion } = await propose(tester, { time: "20:00", when: "now" });
    await scheduler.tick(new Date(now.getTime() + 60_000));
    expect(nudgeMoments()).toEqual([]);
    expect(await reply(tester, now)).toContain(`${notRaised} [${suggestion.id.slice(0, 8)}]`);
    await scheduler.tick(new Date(now.getTime() + 11 * 60_000));
    expect(nudgeMoments()).toEqual(["team"]);
  });

  it("\"morning\": never in a reply; the next morning text carries it, a rest day's included", async () => {
    const tester = await seed();
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    // Wednesday is a rest day.
    await t.db.update(plans).set({ days: ["mon", "tue", "thu", "fri", "sat", "sun"] }).where(eq(plans.id, plan!.id));
    const { draft, suggestion } = await propose(tester, { time: "20:00", when: "morning" });
    expect(draft.body).toContain("with the morning text");
    expect(suggestion.delivery).toBe("morning");
    expect(await reply(tester, now)).not.toContain(notRaised);
    await t.db.insert(stepDays).values({ testerId: tester.id, date: TUE, planId: plan!.id, status: "done" });
    await scheduler.tick(at(WED, "09:00"));
    expect(t.replier.nudges.at(-1)).toMatchObject({ moment: "rest_day", carry: { suggestionId: suggestion.id } });
  });

  it("\"morning\" after a miss: the after-a-miss kickoff doesn't carry it; the next ordinary one does", async () => {
    const tester = await seed();
    const [plan] = await t.db.select().from(plans).where(eq(plans.testerId, tester.id));
    const { suggestion } = await propose(tester, { time: "20:00", when: "morning" });
    await t.db.insert(stepDays).values({ testerId: tester.id, date: TUE, planId: plan!.id, status: "missed" });
    await scheduler.tick(at(WED, "09:00"));
    expect(t.replier.nudges.at(-1)).toMatchObject({ moment: "after_miss" });
    expect(t.replier.nudges.at(-1)!.carry).toBeUndefined();
    await t.db.insert(stepDays).values({ testerId: tester.id, date: WED, planId: plan!.id, status: "done" });
    await scheduler.tick(at("2026-11-05", "09:00"));
    expect(t.replier.nudges.at(-1)).toMatchObject({ moment: "kickoff", carry: { suggestionId: suggestion.id } });
  });

  it("no timing said: as today, the next fitting text (a reply lists it)", async () => {
    const tester = await seed();
    const { draft, suggestion } = await propose(tester, { time: "20:00" });
    expect(draft.body).toContain("in its next text to them");
    expect(suggestion.delivery).toBe("natural");
    expect(await reply(tester, now)).toContain(`${notRaised} [${suggestion.id.slice(0, 8)}]`);
  });

  it("deepen, upgrade and a new focus take the same timing", async () => {
    const tester = await seed();
    const { draft, suggestion } = await propose(tester, { goal: "reading", kind: "deepen", proposal: "15 pages a night", when: "now" }, "suggest_next_step");
    expect(draft.body).toContain("in its own text now");
    expect(suggestion).toMatchObject({ kind: "deepen", delivery: "own_text" });
    await scheduler.tick(new Date(now.getTime() + 60_000));
    expect(t.replier.nudges.at(-1)).toMatchObject({ moment: "team", carry: { suggestionId: suggestion.id } });
  });

  it("\"now\" drafted in their quiet hours: the card says it waits for the next text, and nothing goes out tonight", async () => {
    const tester = await seed();
    now = at(TUE, "22:30");
    const { draft, suggestion } = await propose(tester, { time: "20:00", when: "now" });
    expect(draft.body).toContain("quiet hours");
    expect(suggestion.delivery).toBe("natural");
    await scheduler.tick(at(TUE, "22:40"));
    expect(nudgeMoments()).toEqual([]);
  });

  for (const block of ["3 unanswered", "a break"] as const) {
    it(`"now" that can't go out (${block}): nothing is sent, it waits for the next text, and the founders are told`, async () => {
      const tester = await seed();
      if (block === "3 unanswered") {
        for (const [i, kind] of ["kickoff", "checkin", "followup"].entries()) {
          await t.db.insert(nudges).values({ testerId: tester.id, date: TUE, kind, moment: kind, status: "sent", createdAt: at(TUE, `09:0${i}`) });
        }
      } else {
        await t.db.insert(pauses).values({ testerId: tester.id, startedAt: at(TUE, "10:00") });
      }
      const { suggestion } = await propose(tester, { time: "20:00", when: "now" });
      await scheduler.tick(new Date(now.getTime() + 60_000));
      expect(nudgeMoments()).not.toContain("team");
      expect((await t.db.select().from(suggestions).where(eq(suggestions.id, suggestion.id)))[0]).toMatchObject({ delivery: "natural", outcome: null });
      const alert = (await thread(tester.id)).findLast((r) => r.kind === "alert");
      expect(alert).toMatchObject({ topic: NOT_SENT_TOPIC });
      expect(alert!.body).toContain("Couldn't text Sam now");
      expect(alert!.body).toContain("next text");
    });
  }

  it("a new focus sent \"now\" at their goal limit waits, and the founders are told why", async () => {
    const tester = await seed();
    for (const [goalSlug, role] of [["reading", "focus"], ["exercise", "maintenance"], ["nutrition", "maintenance"]] as const) {
      await t.db.insert(testerGoals).values({ testerId: tester.id, goalSlug, role });
    }
    const { suggestion } = await propose(tester, { goal: "reading", kind: "new_focus", new_goal: "bedtime", proposal: "Wind down by 10", when: "now" }, "suggest_next_step");
    await scheduler.tick(new Date(now.getTime() + 60_000));
    expect(nudgeMoments()).not.toContain("team");
    expect((await t.db.select().from(suggestions).where(eq(suggestions.id, suggestion.id)))[0]).toMatchObject({ delivery: "natural", outcome: null });
    expect((await thread(tester.id)).findLast((r) => r.kind === "alert")!.body).toContain("goal limit");
  });

  it("a stopped tester: it can't be drafted, and one queued before the stop never sends", async () => {
    const stopped = await seed({ stopped: true });
    model.script({ tools: [{ name: "propose_plan_change", input: { time: "20:00", when: "now" } }] }, "Can't.");
    await chat(stopped, "propose 8pm now");
    expect(toolResult()).toContain("They texted stop");
    await addFounderSuggestion(t.db, { testerId: stopped.id, goalSlug: "reading", kind: "adjust", proposal: "step at 8:00 pm", planChanges: { stepTime: "20:00" }, delivery: "own_text", by: "Yanni", at: now });
    await scheduler.tick(new Date(now.getTime() + 60_000));
    expect(nudgeMoments()).toEqual([]);
  });

  it("the team text's job is the request or the proposal it carries", () => {
    expect(TEAM).toContain("NUDGE MOMENT team: a text they asked you to send. Its one job is what it carries (a request, or a next step or plan change to ask them about), as your own idea; no step or proof push.");
  });
});
