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
      // The page's own fetches (#63): older items, live updates.
      for (const url of [`/console/testers/${id}/thread?before=${now.getTime()}`, `/console/testers/${id}/texts?before=${now.getTime()}`, `/console/testers/${id}/updates?thread=0&texts=0`]) {
        const res = await get(url, cookie);
        expect(res.statusCode).toBe(401);
        expect(res.body).not.toContain("Page 40");
      }
    }
    for (const tab of ["console", "texts", "memory", "progress"]) {
      const res = await get(`/console/testers/${id}?tab=${tab}`);
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain("Sam");
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
    expect(res.body).toContain("Daily reading · 🔥 2");
    expect(res.body).toContain("streak 2 (since 2026-10-26)");
    expect(res.body).toContain("hit rate 100% (2/2)");
    expect(res.body).toContain("Daily exercise");
    expect(res.body).toContain("Page 40, nice.");
    expect(res.body).toContain("2 alerts");
  });

  it("puts testers needing a look first, and counts a waiting suggestion and its alert once (#63)", async () => {
    const sam = await seed();
    const alex = await seed(WESTERN, "Alex");
    const third = await seed("+15555550123", "Kim");
    // Alex: everything seen and decided; texted most recently.
    await t.db.update(consoleMessages).set({ seenAt: now, seenBy: "Yanni" }).where(eq(consoleMessages.testerId, alex.tester.id));
    await t.db.update(suggestions).set({ decision: "approved", decidedBy: "Yanni", decidedAt: now }).where(eq(suggestions.testerId, alex.tester.id));
    await t.db.insert(messages).values({ direction: "inbound", contactNumber: WESTERN, content: "newest text", createdAt: at("2026-11-10", "11:00") });
    // Kim: both alerts seen, the suggestion still waiting: it counts on its own.
    await t.db.update(consoleMessages).set({ seenAt: now, seenBy: "Yanni" }).where(eq(consoleMessages.testerId, third.tester.id));
    const res = await get("/console", cookieFor("Yanni"));
    const order = ["Sam", "Kim", "Alex"].map((n) => res.body.indexOf(`<strong style="font-size:16px">${n}</strong>`));
    expect(order.every((i) => i > 0)).toBe(true);
    // Sam and Kim need a look (Sam texted later), Alex doesn't despite the newest text.
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    const badge = (name: string) => res.body.slice(res.body.indexOf(`>${name}</strong>`)).match(/<span class="badge"[^>]*>(\d+)</)?.[1];
    expect(badge("Sam")).toBe("2"); // two unseen alerts; the waiting suggestion's alert is one of them
    expect(badge("Kim")).toBe("1"); // the waiting suggestion, its alert already seen
    expect(res.body.slice(res.body.indexOf(">Alex</strong>")).split("</a>")[0]).not.toContain('class="badge"');
    void sam;
  });

  it("shows a header and four tabs; Console has the chat, Alerts and Pending, and no alerts in the chat (#63)", async () => {
    const s = await seed();
    await t.db.insert(consoleMessages).values({ testerId: s.tester.id, kind: "founder", author: "Yanni", body: "how is she doing?", createdAt: at("2026-11-10", "10:00") });
    const res = await get(`/console/testers/${s.tester.id}`, cookieFor("Yanni"));
    expect(res.statusCode).toBe(200);
    const page = res.body;
    for (const tab of ["console", "texts", "memory", "progress"]) expect(page).toContain(`?tab=${tab}"`);
    // Same count as the home badge: the waiting suggestion's own alert isn't counted twice.
    expect(page).toContain('aria-current="page">Console <span class="badge">2</span>');
    expect(page).toContain("Focus: <strong>Daily reading</strong>");
    expect(page).toContain("🔥 2</b>");
    const chat = page.slice(page.indexOf('<section id="chat">'), page.indexOf('<div id="side"'));
    const below = page.slice(page.indexOf('<div id="side"'));
    expect(chat).toContain("how is she doing?");
    // The coach's suggestion is a card in the chat, with its buttons…
    expect(chat).toContain("20 pages a night");
    expect(chat).toContain('value="approved"');
    // …and under Pending; the alerts only below the chat.
    expect(below).toContain("Pending suggestions");
    expect(below).toContain("20 pages a night");
    expect(below).toContain("Plan version 3 to review");
    expect(chat).not.toContain("Plan version 3 to review");
    expect(chat).not.toContain("A next step is waiting");
    // No suggestion form any more: founders ask ZOH in the chat.
    expect(page).not.toContain("Suggest a next step yourself");
    expect(page).not.toContain(ME);
  });

  it("shows texts, memory, metrics, plan versions, proofs and past suggestions on their tabs", async () => {
    const s = await seed();
    const tab = async (name: string) => {
      const res = await get(`/console/testers/${s.tester.id}?tab=${name}`, cookieFor("Yanni"));
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`aria-current="page">${name[0]!.toUpperCase()}${name.slice(1)}`);
      expect(res.body).not.toContain(ME);
      return res.body;
    };
    const texts = await tab("texts");
    expect(texts).toContain("Page 40, nice.");
    expect(texts).toContain(`/console/media/${s.photoId}`);
    const memory = await tab("memory");
    expect(memory).toContain("Sam (the tester)");
    expect(memory).toContain("Has a dog named Max");
    const progress = await tab("progress");
    // Metrics: focus streak and hit rate; maintenance proven, then self-reported
    expect(progress).toContain("Streak 2 (since 2026-10-26)");
    expect(progress).toContain("Proven through 2026-10-23, self-reported since · last confirmed 2026-11-09");
    // Plan versions, the deepen waiting for review
    expect(progress).toContain("v3");
    expect(progress).toContain("15 pages of Dune");
    expect(progress).toContain("deepen");
    expect(progress).toContain("needs review");
    // Step log with the proof photo behind the media proxy
    expect(progress).toContain("read on the train");
    expect(progress).toContain("Dune open at page 40");
    expect(progress).toContain(`/console/media/${s.photoId}`);
    // An unknown tab is the console.
    expect(await (await get(`/console/testers/${s.tester.id}?tab=nope`, cookieFor("Yanni"))).body).toContain('aria-current="page">Console');
  });

  it("escapes what testers write, on the page and in live updates", async () => {
    const s = await seed();
    await t.db.insert(messages).values({ direction: "inbound", contactNumber: ME, content: "<script>alert(1)</script>", createdAt: at("2026-11-10", "09:00") });
    await t.db.insert(memoryFacts).values({ pageId: (await t.db.select().from(memoryPages).where(eq(memoryPages.testerId, s.tester.id)))[0]!.id, testerId: s.tester.id, text: "<img src=x onerror=alert(2)>" });
    await t.db.insert(consoleMessages).values({ testerId: s.tester.id, kind: "coach", author: "zoh", body: "<b>bold</b>", createdAt: at("2026-11-10", "09:30") });
    const bodies = [
      (await get(`/console/testers/${s.tester.id}?tab=texts`, cookieFor("Yanni"))).body,
      (await get(`/console/testers/${s.tester.id}?tab=memory`, cookieFor("Yanni"))).body,
      (await get(`/console/testers/${s.tester.id}?tab=console`, cookieFor("Yanni"))).body,
      (await get(`/console/testers/${s.tester.id}/updates?thread=0&texts=0`, cookieFor("Yanni"))).body,
    ];
    for (const body of bodies) {
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).not.toContain("<img src=x");
      expect(body).not.toContain("<b>bold</b>");
    }
    expect(bodies[0]).toContain("&lt;script&gt;");
    expect(bodies[1]).toContain("&lt;img src=x");
    expect(bodies[2]).toContain("&lt;b&gt;bold");
  });

  it("loads texts and the chat in chunks, newest first, and older ones on request (#63)", async () => {
    const s = await seed();
    const start = at("2026-11-03", "08:00").getTime();
    await t.db.insert(messages).values(
      Array.from({ length: 120 }, (_, i) => ({ direction: "inbound" as const, contactNumber: ME, content: `text number ${i}`, createdAt: new Date(start + i * 60_000) })),
    );
    // 2 seeded texts on Nov 2, then 120 more: the newest 50 show first.
    const page = (await get(`/console/testers/${s.tester.id}?tab=texts`, cookieFor("Yanni"))).body;
    expect(page).toContain("text number 119<");
    expect(page).toContain("text number 70<");
    expect(page).not.toContain("text number 69<");
    const before = page.match(/data-kind="texts" data-before="(\d+)"/)![1]!;
    expect(Number(before)).toBe(start + 70 * 60_000);
    const older = (await get(`/console/testers/${s.tester.id}/texts?before=${before}`, cookieFor("Yanni"))).json() as { html: string; before: string | null };
    // At or before the edge: the edge text repeats (the page drops it), then the next 49 older.
    expect(older.html).toContain("text number 70<");
    expect(older.html).toContain("text number 21<");
    expect(older.html).not.toContain("text number 20<");
    expect(older.html.indexOf("text number 21<")).toBeLessThan(older.html.indexOf("text number 70<"));
    const oldest = (await get(`/console/testers/${s.tester.id}/texts?before=${older.before}`, cookieFor("Yanni"))).json() as { html: string; before: string | null };
    expect(oldest.html).toContain("text number 0<");
    expect(oldest.html).toContain("Page 40, nice.");
    expect(oldest.before).toBeNull();

    // The chat works the same way.
    await t.db.insert(consoleMessages).values(
      Array.from({ length: 60 }, (_, i) => ({ testerId: s.tester.id, kind: "founder" as const, author: "Yanni", body: `line ${i}`, createdAt: new Date(start + i * 60_000) })),
    );
    const chat = (await get(`/console/testers/${s.tester.id}`, cookieFor("Yanni"))).body;
    expect(chat).toContain("line 59<");
    expect(chat).not.toContain("line 9<");
    const threadBefore = chat.match(/data-kind="thread" data-before="(\d+)"/)![1]!;
    const olderChat = (await get(`/console/testers/${s.tester.id}/thread?before=${threadBefore}`, cookieFor("Yanni"))).json() as { html: string };
    expect(olderChat.html).toContain("line 0<");
  });

  it("live updates carry only what's new, and the thinking line while ZOH answers (#63)", async () => {
    const s = await seed();
    const after = at("2026-11-10", "11:00").getTime();
    type Chunk = { html: string; after: string };
    type Updates = { thread: Chunk; texts: Chunk; thinking: string; side: { sig: string; html: string } };
    const updates = async () => (await get(`/console/testers/${s.tester.id}/updates?thread=${after}&texts=${after}`, cookieFor("Yanni"))).json() as Updates;
    const quiet = await updates();
    expect(quiet.thread.html).toBe("");
    expect(quiet.texts.html).toBe("");
    expect(quiet.thinking).toBe("");
    expect(quiet.side.html).toContain("Plan version 3 to review");
    await t.db.insert(consoleMessages).values({ testerId: s.tester.id, kind: "founder", author: "Stamati", body: "anything new?", createdAt: at("2026-11-10", "11:59") });
    await t.db.insert(messages).values({ direction: "inbound", contactNumber: ME, content: "on my way", createdAt: at("2026-11-10", "11:58") });
    const fresh = await updates();
    expect(fresh.thread.html).toContain("anything new?");
    expect(fresh.thread.html).not.toContain("20 pages a night");
    expect(fresh.texts.html).toContain("on my way");
    expect(fresh.texts.html).not.toContain("Page 40");
    expect(Number(fresh.thread.after)).toBe(at("2026-11-10", "11:59").getTime());
    expect(fresh.thinking).toBe("ZOH is thinking…");
    // Seeing an alert changes the section (and its signature).
    await post(`/console/testers/${s.tester.id}/alerts/${s.alertId}/seen`, {}, cookieFor("Yanni"));
    expect((await updates()).side.sig).not.toBe(fresh.side.sig);
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
    // The second founder (deciding from a page that still showed it waiting) sees why, on the page.
    const again = await post(`/console/testers/${s.tester.id}/suggestions/${s.suggestionId}/decide`, { decision: "approved" }, cookieFor("Stamati"));
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain("Not saved: Already rejected by Yanni.");
    const [still] = await t.db.select().from(suggestions).where(eq(suggestions.id, s.suggestionId));
    expect(still).toMatchObject({ decision: "rejected", decidedBy: "Yanni" });
    // Decided shows in the chat card; it's gone from Pending.
    const page = (await get(`/console/testers/${s.tester.id}`, cookieFor("Yanni"))).body;
    const chat = page.slice(page.indexOf('<section id="chat">'), page.indexOf('<div id="side"'));
    expect(chat).toContain("rejected by Yanni");
    expect(chat).not.toContain('value="approved"');
    expect(page.slice(page.indexOf('<div id="side"'))).not.toContain("20 pages a night");
  });

  it("decides from the Pending list the same way, back on the Console tab (#63)", async () => {
    const s = await seed();
    const res = await post(`/console/testers/${s.tester.id}/suggestions/${s.suggestionId}/decide`, { decision: "approved", reason: "ok" }, cookieFor("Stamati"));
    expect(res.headers.location).toBe(`/console/testers/${s.tester.id}?tab=console#pending`);
    const [row] = await t.db.select().from(suggestions).where(eq(suggestions.id, s.suggestionId));
    expect(row).toMatchObject({ decision: "approved", decidedBy: "Stamati", decisionReason: "ok" });
  });

  it("never gives the coach a waiting one, or another tester's", async () => {
    const s = await seed();
    const other = await seed(WESTERN, "Alex");
    await post(`/console/testers/${other.tester.id}/suggestions/${other.suggestionId}/decide`, { decision: "approved" }, cookieFor("Yanni"));
    expect(await suggestionsForCoach(t.db, s.tester.id)).toEqual([]);
    // A decision posted under the wrong tester is refused.
    expect((await post(`/console/testers/${s.tester.id}/suggestions/${other.suggestionId}/decide`, { decision: "rejected" }, cookieFor("Yanni"))).statusCode).toBe(409);
  });

  it("has no suggestion form any more: founders' own next steps go through the chat (#63)", async () => {
    const s = await seed();
    const res = await post(`/console/testers/${s.tester.id}/suggestions`, { goal: "reading", kind: "deepen", proposal: "x" }, cookieFor("Stamati"));
    expect(res.statusCode).toBe(404);
    expect(await suggestionsForCoach(t.db, s.tester.id)).toEqual([]);
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
