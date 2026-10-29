import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { raiseAlert } from "../src/console/alerts.js";
import { createConsoleJobs, summaryDate, summaryKey, weekNumbers } from "../src/console/jobs.js";
import { suggestionsForCoach } from "../src/console/suggestions.js";
import {
  consoleMessages,
  maintenanceCheckins,
  memoryFacts,
  memoryPages,
  messages,
  plans,
  stepDays,
  suggestions,
  testerGoals,
  testers,
  type Plan,
  type Tester,
} from "../src/db/schema.js";
import { zonedTime } from "../src/nudges/schedule.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { FakeClaudeModel, ME, WESTERN, makeApp, type TestApp } from "./helpers.js";

const TZ = "America/New_York";
const PASSWORD = "open sesame";
const SECRET = "console-test-secret";
const NAMES = ["Yanni", "Stamati"];
/** Sun Nov 1 2026: Eastern time falls back that morning, so 8 am is 13:00 UTC. */
const SUN = "2026-11-01";
const MON = "2026-11-02";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

let t: TestApp;
let now: Date;

beforeEach(async () => {
  now = at("2026-11-10", "12:00");
  t = await makeApp({ console: { password: PASSWORD, sessionSecret: SECRET, names: NAMES }, now: () => now });
});
afterEach(async () => {
  await t.close();
});

function cookieFor(name?: string, secret = SECRET, issued = now): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(issued, name), secret))}`;
}

async function get(url: string, cookie?: string) {
  return t.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
}

async function post(url: string, form: Record<string, string>, cookie?: string) {
  return t.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    payload: new URLSearchParams(form).toString(),
  });
}

interface Seeded {
  tester: Tester;
  reviewPlan: Plan;
  suggestionId: string;
  alertId: string;
  photoId: string;
}

/**
 * Sam: reading is the focus (v2, then a deepen v3 waiting for review), exercise is maintenance since
 * Nov 5 with one "kept up" check-in, a done Monday with a photo, memory, a waiting suggestion and its alert.
 */
async function seed(phone = ME, name = "Sam"): Promise<Seeded> {
  const [tester] = await t.db
    .insert(testers)
    .values({
      phone,
      name,
      goalSlug: "reading",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at("2026-10-20", "10:00"),
      contextStartedAt: at("2026-10-20", "10:00"),
    })
    .returning();
  const id = tester!.id;
  const base = { testerId: id, status: "locked" as const, proof: "photo" as const, stepTime: "19:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as Plan["days"], reason: "Builds the habit." };
  const [v1] = await t.db
    .insert(plans)
    .values({ ...base, goalSlug: "exercise", version: 1, step: "20 push-ups", startDate: "2026-10-21", lockedAt: at("2026-10-20", "12:00") })
    .returning();
  const [v2] = await t.db
    .insert(plans)
    .values({ ...base, goalSlug: "reading", version: 2, step: "10 pages of Dune", startDate: "2026-10-26", lockedAt: at("2026-10-25", "12:00") })
    .returning();
  const [v3] = await t.db
    .insert(plans)
    .values({ ...base, goalSlug: "reading", version: 3, step: "15 pages of Dune", changeKind: "deepen", needsReview: true, startDate: "2026-11-09", lockedAt: at("2026-11-08", "12:00") })
    .returning();
  await t.db.insert(testerGoals).values([
    { testerId: id, goalSlug: "reading", role: "focus", roleSince: at("2026-10-25", "12:00") },
    { testerId: id, goalSlug: "exercise", role: "maintenance", nudges: false, proof: false, checkinsPerWeek: 2, roleSince: at("2026-11-05", "12:00") },
  ]);
  await t.db.insert(maintenanceCheckins).values({ testerId: id, goalSlug: "exercise", date: "2026-11-09", answer: "kept_up", answeredAt: at("2026-11-09", "10:00") });
  await t.db.insert(stepDays).values([
    // Exercise was the focus first: three proven days, through Oct 23.
    { testerId: id, date: "2026-10-21", planId: v1!.id, status: "done" },
    { testerId: id, date: "2026-10-22", planId: v1!.id, status: "done" },
    { testerId: id, date: "2026-10-23", planId: v1!.id, status: "done" },
    { testerId: id, date: "2026-10-26", planId: v2!.id, status: "done" },
    { testerId: id, date: MON, planId: v2!.id, status: "done", note: "read on the train", proofVerdict: "clear", proofSeen: "Dune open at page 40" },
  ]);
  const [photo] = await t.db
    .insert(messages)
    .values({
      direction: "inbound",
      contactNumber: phone,
      content: "done!",
      mediaUrl: "https://cdn.example/p.jpg",
      mediaKey: `media/${id}/p.jpg`,
      mediaContentType: "image/jpeg",
      description: "A paperback open at page 40",
      createdAt: at(MON, "19:30"),
      sentAt: at(MON, "19:30"),
    })
    .returning();
  await t.media.put(`media/${id}/p.jpg`, new Uint8Array([9, 9, 9]), "image/jpeg");
  await t.db.insert(messages).values({ direction: "outbound", contactNumber: phone, content: "Page 40, nice.", createdAt: at(MON, "19:31") });
  const [self] = await t.db.insert(memoryPages).values({ testerId: id, kind: "self", title: `${name} (the tester)`, summary: "Commutes by train" }).returning();
  await t.db.insert(memoryFacts).values({ pageId: self!.id, testerId: id, text: "Has a dog named Max" });
  const [s] = await t.db
    .insert(suggestions)
    .values({ testerId: id, goalSlug: "reading", kind: "deepen", raisedBy: "coach", proposal: "20 pages a night", reasoning: "Two weeks without a miss" })
    .returning();
  await raiseAlert(t.db, { testerId: id, topic: "suggestion_waiting", key: `suggestion:${s!.id}`, body: "A next step is waiting", suggestionId: s!.id, at: at("2026-11-09", "09:00") });
  await raiseAlert(t.db, { testerId: id, topic: "plan_review", key: `plan_review:${v3!.id}`, body: "Plan version 3 to review", planId: v3!.id, at: at("2026-11-08", "12:00") });
  const [alert] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.eventKey, `plan_review:${v3!.id}`));
  return { tester: tester!, reviewPlan: v3!, suggestionId: s!.id, alertId: alert!.id, photoId: photo!.id };
}

describe("console login", () => {
  it("shows nothing without the password, on every page, action and file", async () => {
    const s = await seed();
    const id = s.tester.id;
    const forged = cookieFor("Yanni", "not-our-secret");
    const expired = cookieFor("Yanni", SECRET, new Date(now.getTime() - 31 * 86_400_000));
    const noName = cookieFor();
    for (const cookie of [undefined, forged, expired, `${SESSION_COOKIE}=garbage`]) {
      for (const url of ["/console", `/console/testers/${id}`]) {
        const res = await get(url, cookie);
        expect(res.statusCode).toBe(401);
        expect(res.body).toContain('name="password"');
        expect(res.body).not.toContain("Sam");
      }
    }
    for (const cookie of [undefined, forged, expired, noName]) {
      expect((await get(`/console/media/${s.photoId}`, cookie)).statusCode).toBe(401);
      expect((await post(`/console/testers/${id}/alerts/${s.alertId}/seen`, {}, cookie)).statusCode).toBe(401);
      expect((await post(`/console/testers/${id}/suggestions/${s.suggestionId}/decide`, { decision: "approved" }, cookie)).statusCode).toBe(401);
      expect((await post(`/console/testers/${id}/suggestions`, { goal: "reading", kind: "deepen", proposal: "x" }, cookie)).statusCode).toBe(401);
    }
    // Nothing changed.
    const [row] = await t.db.select().from(suggestions).where(eq(suggestions.id, s.suggestionId));
    expect(row!.decision).toBe("waiting");
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, s.reviewPlan.id));
    expect(plan!.needsReview).toBe(true);
  });

  it("logs in with the password, asks the name once, then shows the list", async () => {
    await seed();
    const wrong = await post("/console/login", { password: "nope" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    const ok = await post("/console/login", { password: PASSWORD });
    expect(ok.statusCode).toBe(303);
    const loginCookie = String(ok.headers["set-cookie"]).split(";")[0]!;
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/);
    expect(String(ok.headers["set-cookie"])).toMatch(/Max-Age=2592000/);

    const picker = await get("/console", loginCookie);
    expect(picker.statusCode).toBe(200);
    expect(picker.body).toContain("Who's this?");
    expect(picker.body).not.toContain("Sam");

    expect((await post("/console/name", { name: "Mallory" }, loginCookie)).statusCode).toBe(400);
    const named = await post("/console/name", { name: "Stamati" }, loginCookie);
    expect(named.statusCode).toBe(303);
    const cookie = String(named.headers["set-cookie"]).split(";")[0]!;

    const list = await get("/console", cookie);
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("Sam");
    expect(list.body).toContain("Stamati");
    expect(list.body).not.toContain(ME);
    expect(list.body).toContain(`*${ME.slice(-4)}`);
  });

  it("stays shut when the password or secret isn't set", async () => {
    const shut = await makeApp({ console: { names: NAMES } });
    expect((await shut.app.inject({ method: "GET", url: "/console" })).statusCode).toBe(503);
    expect((await shut.app.inject({ method: "POST", url: "/console/login", payload: { password: "" } })).statusCode).toBe(503);
    await shut.close();
  });

  it("serves the home-screen manifest and icon without a login", async () => {
    expect((await get("/console/manifest.webmanifest")).json()).toMatchObject({ name: "ZOH Console", start_url: "/console" });
    const png = await get("/console/icon.png");
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
  });
});

describe("tester list and page", () => {
  it("lists each tester with goals, streak, hit rate, last text and alerts waiting", async () => {
    await seed();
    const res = await get("/console", cookieFor("Yanni"));
    expect(res.body).toContain("Focus: Daily reading · streak 2 (since 2026-10-26)");
    expect(res.body).toContain("hit rate 100% (2/2)");
    expect(res.body).toContain("Daily exercise");
    expect(res.body).toContain("Page 40, nice.");
    expect(res.body).toContain("2 alerts");
  });

  it("shows texts, memory, metrics, plan versions, proofs, suggestions and alerts", async () => {
    const s = await seed();
    const res = await get(`/console/testers/${s.tester.id}`, cookieFor("Yanni"));
    expect(res.statusCode).toBe(200);
    const page = res.body;
    // Texts
    expect(page).toContain("Page 40, nice.");
    // Memory
    expect(page).toContain("Sam (the tester)");
    expect(page).toContain("Has a dog named Max");
    // Metrics: focus streak and hit rate; maintenance proven, then self-reported
    expect(page).toContain("Streak 2 (since 2026-10-26)");
    expect(page).toContain("Proven through 2026-10-23, self-reported since · last confirmed 2026-11-09");
    // Plan versions, the deepen waiting for review
    expect(page).toContain("v3");
    expect(page).toContain("15 pages of Dune");
    expect(page).toContain("deepen");
    expect(page).toContain("needs review");
    // Step log with the proof photo behind the media proxy
    expect(page).toContain("read on the train");
    expect(page).toContain("Dune open at page 40");
    expect(page).toContain(`/console/media/${s.photoId}`);
    // Suggestions and alerts
    expect(page).toContain("20 pages a night");
    expect(page).toContain("Two weeks without a miss");
    expect(page).toContain("Plan version 3 to review");
    // Masked number only
    expect(page).not.toContain(ME);
  });

  it("escapes what testers write", async () => {
    const s = await seed();
    await t.db.insert(messages).values({ direction: "inbound", contactNumber: ME, content: "<script>alert(1)</script>", createdAt: at("2026-11-10", "09:00") });
    const page = (await get(`/console/testers/${s.tester.id}`, cookieFor("Yanni"))).body;
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });

  it("a jumped dev account's page runs on their clock and says how far ahead it is (#14)", async () => {
    const s = await seed();
    const page = async () => (await get(`/console/testers/${s.tester.id}`, cookieFor("Yanni"))).body;
    expect(await page()).not.toContain("test clock");
    await t.db.update(testers).set({ clockOffsetMs: (3 * 24 + 4) * 60 * 60_000 }).where(eq(testers.id, s.tester.id));
    expect(await page()).toContain("⏩ test clock +3d 4h");
  });

  it("streams a proof from the bucket, and only a known tester's", async () => {
    const s = await seed();
    const res = await get(`/console/media/${s.photoId}`, cookieFor("Yanni"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect([...res.rawPayload]).toEqual([9, 9, 9]);
    const [stranger] = await t.db
      .insert(messages)
      .values({ direction: "inbound", contactNumber: "+15555550199", mediaUrl: "https://cdn.example/s.jpg", mediaKey: "media/s.jpg" })
      .returning();
    await t.media.put("media/s.jpg", new Uint8Array([1]), "image/jpeg");
    expect((await get(`/console/media/${stranger!.id}`, cookieFor("Yanni"))).statusCode).toBe(404);
    expect((await get("/console/media/not-a-uuid", cookieFor("Yanni"))).statusCode).toBe(404);
  });
});

describe("deciding next steps", () => {
  it("stores approve with who and why, and the approved step reaches the coach", async () => {
    const s = await seed();
    const res = await post(`/console/testers/${s.tester.id}/suggestions/${s.suggestionId}/decide`, { decision: "approved", reason: "She's ready" }, cookieFor("Yanni"));
    expect(res.statusCode).toBe(303);
    const [row] = await t.db.select().from(suggestions).where(eq(suggestions.id, s.suggestionId));
    expect(row).toMatchObject({ decision: "approved", decidedBy: "Yanni", decisionReason: "She's ready", decidedAt: now });
    expect((await suggestionsForCoach(t.db, s.tester.id)).map((x) => x.id)).toEqual([s.suggestionId]);
    // Its "waiting" alert is seen with the decision.
    const [alert] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.suggestionId, s.suggestionId));
    expect(alert).toMatchObject({ seenBy: "Yanni" });
  });

  it("stores a change, including a changed kind", async () => {
    const s = await seed();
    await post(
      `/console/testers/${s.tester.id}/suggestions/${s.suggestionId}/decide`,
      { decision: "changed", kind: "upgrade", proposal: "Start a second book", reason: "Pages aren't the hard part" },
      cookieFor("Stamati"),
    );
    const [row] = await t.db.select().from(suggestions).where(eq(suggestions.id, s.suggestionId));
    expect(row).toMatchObject({
      decision: "changed",
      kind: "deepen",
      decidedKind: "upgrade",
      proposal: "20 pages a night",
      decidedProposal: "Start a second book",
      decidedBy: "Stamati",
      decisionReason: "Pages aren't the hard part",
    });
    expect(await suggestionsForCoach(t.db, s.tester.id)).toHaveLength(1);
    // A change needs its kind and wording.
    const [other] = await t.db.insert(suggestions).values({ testerId: s.tester.id, goalSlug: "reading", kind: "deepen", raisedBy: "coach", proposal: "x" }).returning();
    expect((await post(`/console/testers/${s.tester.id}/suggestions/${other!.id}/decide`, { decision: "changed", kind: "sideways", proposal: "y" }, cookieFor("Yanni"))).statusCode).toBe(400);
  });

  it("stores a reject, which never reaches the coach, and a second decision is refused", async () => {
    const s = await seed();
    await post(`/console/testers/${s.tester.id}/suggestions/${s.suggestionId}/decide`, { decision: "rejected", reason: "Too soon" }, cookieFor("Yanni"));
    const [row] = await t.db.select().from(suggestions).where(eq(suggestions.id, s.suggestionId));
    expect(row).toMatchObject({ decision: "rejected", decidedBy: "Yanni", decisionReason: "Too soon" });
    expect(await suggestionsForCoach(t.db, s.tester.id)).toEqual([]);
    const again = await post(`/console/testers/${s.tester.id}/suggestions/${s.suggestionId}/decide`, { decision: "approved" }, cookieFor("Stamati"));
    expect(again.statusCode).toBe(409);
    const [still] = await t.db.select().from(suggestions).where(eq(suggestions.id, s.suggestionId));
    expect(still).toMatchObject({ decision: "rejected", decidedBy: "Yanni" });
  });

  it("never gives the coach a waiting one, or another tester's", async () => {
    const s = await seed();
    const other = await seed(WESTERN, "Alex");
    await post(`/console/testers/${other.tester.id}/suggestions/${other.suggestionId}/decide`, { decision: "approved" }, cookieFor("Yanni"));
    expect(await suggestionsForCoach(t.db, s.tester.id)).toEqual([]);
    // A decision posted under the wrong tester is refused.
    expect((await post(`/console/testers/${s.tester.id}/suggestions/${other.suggestionId}/decide`, { decision: "rejected" }, cookieFor("Yanni"))).statusCode).toBe(409);
  });

  it("saves a founder's own suggestion as approved by them", async () => {
    const s = await seed();
    const res = await post(
      `/console/testers/${s.tester.id}/suggestions`,
      { goal: "reading", kind: "new_focus", newGoal: "bedtime", proposal: "Same bedtime every night", reasoning: "Reads late, sleeps badly" },
      cookieFor("Stamati"),
    );
    expect(res.statusCode).toBe(303);
    const mine = (await suggestionsForCoach(t.db, s.tester.id))[0];
    expect(mine).toMatchObject({ raisedBy: "founder", raisedByName: "Stamati", decision: "approved", decidedBy: "Stamati", kind: "new_focus", newGoalSlug: "bedtime" });
    expect((await post(`/console/testers/${s.tester.id}/suggestions`, { goal: "reading", kind: "new_focus", proposal: "x" }, cookieFor("Stamati"))).statusCode).toBe(400);
    expect((await post(`/console/testers/${s.tester.id}/suggestions`, { goal: "knitting", kind: "deepen", proposal: "x" }, cookieFor("Stamati"))).statusCode).toBe(400);
  });
});

describe("alerts", () => {
  it("marks an alert seen once, and seeing a plan to review clears its needs review", async () => {
    const s = await seed();
    const res = await post(`/console/testers/${s.tester.id}/alerts/${s.alertId}/seen`, {}, cookieFor("Stamati"));
    expect(res.statusCode).toBe(303);
    const [alert] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, s.alertId));
    expect(alert).toMatchObject({ seenBy: "Stamati", seenAt: now });
    const [plan] = await t.db.select().from(plans).where(eq(plans.id, s.reviewPlan.id));
    expect(plan!.needsReview).toBe(false);
    // A second look keeps the first.
    now = new Date(now.getTime() + 60_000);
    await post(`/console/testers/${s.tester.id}/alerts/${s.alertId}/seen`, {}, cookieFor("Yanni"));
    const [again] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, s.alertId));
    expect(again).toMatchObject({ seenBy: "Stamati" });
    // Another tester's alert can't be marked from this page.
    const other = await seed(WESTERN, "Alex");
    expect((await post(`/console/testers/${s.tester.id}/alerts/${other.alertId}/seen`, {}, cookieFor("Yanni"))).statusCode).toBe(404);
  });

  it("writes each alert's why once, in the background", async () => {
    const s = await seed();
    const model = new FakeClaudeModel().script("Fifteen pages after two clean weeks: worth a look.");
    const jobs = createConsoleJobs({ db: t.db, log: silent, model });
    await jobs.tick(now);
    await jobs.tick(now);
    const alerts = await t.db.select().from(consoleMessages).where(eq(consoleMessages.testerId, s.tester.id));
    expect(alerts.every((a) => a.why)).toBe(true);
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests)).not.toContain(ME);
  });

  it("waits before retrying a why that failed, and skips old alerts", async () => {
    const s = await seed();
    await t.db.update(consoleMessages).set({ createdAt: new Date(now.getTime() - 3 * 86_400_000) }).where(eq(consoleMessages.testerId, s.tester.id));
    await raiseAlert(t.db, { testerId: s.tester.id, topic: "went_quiet", key: "fresh", body: "Quiet 2 days", at: now });
    const model = new FakeClaudeModel().script(new Error("overloaded"));
    const jobs = createConsoleJobs({ db: t.db, log: silent, model });
    expect((await jobs.tick(now)).whys).toBe(0);
    expect((await jobs.tick(new Date(now.getTime() + 60_000))).whys).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect((await jobs.tick(new Date(now.getTime() + 61 * 60_000))).whys).toBe(1);
  });
});

describe("weekly summary", () => {
  it("is due from 8 am Eastern on Sundays only", () => {
    expect(summaryDate(at(SUN, "07:59"))).toBeUndefined();
    expect(summaryDate(new Date("2026-11-01T12:59:00Z"))).toBeUndefined();
    expect(summaryDate(new Date("2026-11-01T13:00:00Z"))).toBe(SUN);
    expect(summaryDate(at(SUN, "23:59"))).toBe(SUN);
    expect(summaryDate(at("2026-10-31", "08:00"))).toBeUndefined();
    expect(summaryDate(at(MON, "08:00"))).toBeUndefined();
  });

  it("is written once per tester, Sunday 8 am Eastern", async () => {
    const s = await seed();
    const model = new FakeClaudeModel("Did: read most nights.\nNotable: nothing stood out.\nNext step: ready to deepen.");
    const jobs = createConsoleJobs({ db: t.db, log: silent, model });
    const sunday = "2026-11-15";
    const summaries = async () => t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "summary"));
    expect((await jobs.tick(at("2026-11-14", "23:59"))).summaries).toBe(0);
    expect((await jobs.tick(at(sunday, "07:59"))).summaries).toBe(0);
    expect((await jobs.tick(at(sunday, "08:00"))).summaries).toBe(1);
    expect((await jobs.tick(at(sunday, "08:01"))).summaries).toBe(0);
    expect((await jobs.tick(at(sunday, "20:00"))).summaries).toBe(0);
    const rows = await summaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ testerId: s.tester.id, eventKey: summaryKey(s.tester.id, sunday), createdAt: at(sunday, "08:00") });
    expect(rows[0]!.body).toContain("Week of 2026-11-08 to 2026-11-14");
    expect(rows[0]!.body).toContain("Next step: ready to deepen.");
    // The next Sunday gets its own.
    expect((await jobs.tick(at("2026-11-22", "08:00"))).summaries).toBe(1);
  });

  it("counts step days done of committed in the week, and the streak", async () => {
    const s = await seed();
    // The week of Nov 1 to 7: v2 every day; done Mon (seeded), Tue and Wed (reduced), missed Thu.
    const [v2] = await t.db.select().from(plans).where(eq(plans.version, 2));
    await t.db.insert(stepDays).values([
      { testerId: s.tester.id, date: "2026-11-03", planId: v2!.id, status: "done" },
      { testerId: s.tester.id, date: "2026-11-04", planId: v2!.id, status: "done_reduced" },
      { testerId: s.tester.id, date: "2026-11-05", planId: v2!.id, status: "missed" },
    ]);
    const n = await weekNumbers(t.db, s.tester, "2026-11-08");
    expect(n).toMatchObject({ from: "2026-11-01", to: "2026-11-07", committed: 7, done: 3, reduced: 1, streak: 0 });
    // Without Claude, the numbers alone.
    const jobs = createConsoleJobs({ db: t.db, log: silent });
    await jobs.tick(at("2026-11-08", "09:00"));
    const [row] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "summary"));
    expect(row!.body).toBe("Week of 2026-11-01 to 2026-11-07: 3 of 7 step days done (1 reduced), streak 0.");
  });

  it("skips testers without a plan yet", async () => {
    await t.db.insert(testers).values({ phone: WESTERN, name: "New", phase: "onboarding", timeZone: TZ, timeZoneStatus: "assumed_eastern", consentAt: now, contextStartedAt: now });
    const jobs = createConsoleJobs({ db: t.db, log: silent });
    expect((await jobs.tick(at("2026-11-08", "09:00"))).summaries).toBe(0);
  });
});
