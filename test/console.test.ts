import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { raiseAlert } from "../src/console/alerts.js";
import { createConsoleJobs, summaryDate, summaryKey, weekNumbers } from "../src/console/jobs.js";
import { suggestionsForCoach } from "../src/console/suggestions.js";
import {
  consoleMessages,
  maintenanceCheckins,
  memoryFacts,
  memoryLinks,
  memoryPages,
  messages,
  pauses,
  planInputs,
  plans,
  stepDays,
  suggestions,
  takeaways,
  testerGoals,
  testers,
  type Plan,
  type StepDay,
  type Tester,
} from "../src/db/schema.js";
import type { StepDayView } from "../src/console/data.js";
import { stepLogSections } from "../src/console/views/progress.js";
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
    .values({ ...base, goalSlug: "reading", version: 3, step: "15 pages of Dune", destination: "finish Dune by Dec 1", changeKind: "deepen", needsReview: true, startDate: "2026-11-09", lockedAt: at("2026-11-08", "12:00") })
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
    { testerId: id, date: MON, planId: v2!.id, status: "done", note: "read on the train", proofVerdict: "clear", proofSeen: "Dune open at page 40", step: "chapter 3 of Dune on the train, about 20 min", stepMinutes: 25, stepKind: "harder" },
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
    .values({ testerId: id, goalSlug: "reading", kind: "deepen", raisedBy: "coach", proposal: "20 pages a night", reasoning: "Two weeks without a miss", createdAt: at("2026-11-09", "09:00") })
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
    expect(res.body).toContain('finish Dune by Dec 1 <span class="muted">· Read &amp; learn more (books, ideas, any topic)</span> · 🔥 2');
    expect(res.body).toContain("streak 2 (since 2026-10-26)");
    expect(res.body).toContain("hit rate 100% (2/2)");
    expect(res.body).toContain('figuring it out <span class="muted">· Get fitter</span> · 7');
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
    expect(page).toContain('aria-current="page" title="Console">');
    expect(page).toContain('<span class="tlabel">Console</span> <span class="badge">2</span>');
    expect(page).toContain("Focus: <strong>finish Dune by Dec 1</strong>");
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
      expect(res.body).toContain(`aria-current="page" title="${name[0]!.toUpperCase()}${name.slice(1)}"`);
      expect(res.body).not.toContain(ME);
      return res.body;
    };
    const texts = await tab("texts");
    expect(texts).toContain("Page 40, nice.");
    expect(texts).toContain(`/console/media/${s.photoId}`);
    const memory = await tab("memory");
    expect(memory).toContain("Sam (the tester)");
    expect(memory).toContain("Commutes by train");
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
    // Each day's own step and the plan's destination (#76)
    expect(progress).toContain("Step: chapter 3 of Dune on the train, about 20 min");
    expect(progress).toContain("25 min");
    expect(progress).toContain("Destination: finish Dune by Dec 1");
    // Each day's kind of step (#88); days from before kinds were recorded show a dash.
    expect(progress).toContain(`${MON} · done · kind: harder`);
    expect(progress).toContain("2026-10-26 · done · kind: –");
    // An unknown tab is the console.
    expect(await (await get(`/console/testers/${s.tester.id}?tab=nope`, cookieFor("Yanni"))).body).toContain('aria-current="page" title="Console"');
  });

  it("shows memory as cards with kind filters and search text, each opening its own page whose links resolve (#63)", async () => {
    const s = await seed();
    const id = s.tester.id;
    const [self] = await t.db.select().from(memoryPages).where(and(eq(memoryPages.testerId, id), eq(memoryPages.kind, "self")));
    const [maya] = await t.db.insert(memoryPages).values({ testerId: id, kind: "person", title: "Maya (her sister)", summary: "Lends her books" }).returning();
    const [day1] = await t.db.insert(memoryPages).values({ testerId: id, kind: "daily", title: "Nov 9", summary: "Read on the train", body: "Did 10 pages on the train.", date: "2026-11-09" }).returning();
    const [day2] = await t.db.insert(memoryPages).values({ testerId: id, kind: "daily", title: "Nov 10", summary: "Short day", date: "2026-11-10" }).returning();
    await t.db.insert(memoryFacts).values({ pageId: maya!.id, testerId: id, text: "Recommended Dune", section: "stated" });
    await t.db.insert(memoryLinks).values([
      { testerId: id, fromPageId: self!.id, toPageId: maya!.id, kind: "related" },
      { testerId: id, fromPageId: day1!.id, toPageId: day2!.id, kind: "leads_to" },
    ]);
    const tab = (await get(`/console/testers/${id}?tab=memory`, cookieFor("Yanni"))).body;
    // A card per page, each in its chip's group, linking to its own page.
    for (const [page, group] of [[self!, "about"], [maya!, "person"], [day1!, "daily"], [day2!, "daily"]] as const) {
      expect(tab).toContain(`href="/console/testers/${id}/memory/${page.id}" data-group="${group}"`);
    }
    for (const chip of ["all", "about", "goal", "person", "subject", "daily", "timeline"]) expect(tab).toContain(`data-chip="${chip}"`);
    // Facts are searchable even when the card shows the summary.
    expect(tab).toContain('data-search="sam (the tester) commutes by train  has a dog named max"');
    // The timeline groups daily pages by their local day (now is Nov 10).
    const timeline = tab.slice(tab.indexOf('class="mem-timeline"'));
    expect(timeline.indexOf("<h3>Today</h3>")).toBeLessThan(timeline.indexOf("<h3>Yesterday</h3>"));

    // Their own page: facts under headings, the related page as a link.
    const own = await get(`/console/testers/${id}/memory/${self!.id}`, cookieFor("Yanni"));
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain("Has a dog named Max");
    expect(own.body).toContain("<h3>Related</h3>");
    expect(own.body).toContain(`href="/console/testers/${id}/memory/${maya!.id}">Maya (her sister)</a>`);
    // Related reads both ways; a daily page shows its body and the path through it.
    expect((await get(`/console/testers/${id}/memory/${maya!.id}`, cookieFor("Yanni"))).body).toContain(`/memory/${self!.id}">Sam (the tester)</a>`);
    const daily = (await get(`/console/testers/${id}/memory/${day1!.id}`, cookieFor("Yanni"))).body;
    expect(daily).toContain("Did 10 pages on the train.");
    expect(daily).toContain(`<strong>Nov 9</strong> → <a href="/console/testers/${id}/memory/${day2!.id}">Nov 10</a>`);
    // Another tester's page isn't reachable under this one; nothing without the password.
    const other = await seed(WESTERN, "Alex");
    const [theirs] = await t.db.select().from(memoryPages).where(eq(memoryPages.testerId, other.tester.id));
    const cross = await get(`/console/testers/${id}/memory/${theirs!.id}`, cookieFor("Yanni"));
    expect(cross.statusCode).toBe(404);
    expect(cross.body).not.toContain("Alex");
    const locked = await get(`/console/testers/${id}/memory/${self!.id}`);
    expect(locked.statusCode).toBe(401);
    expect(locked.body).not.toContain("Has a dog named Max");
  });

  it("shows the step log as day dots that jump to each day, with a letter as well as a color (#63)", async () => {
    const s = await seed();
    const progress = (await get(`/console/testers/${s.tester.id}?tab=progress`, cookieFor("Yanni"))).body;
    expect(progress).toContain(`<a class="dot done proof" href="#day-${MON}" title="Mon, Nov 2: done, with proof"`);
    expect(progress).toContain(`id="day-${MON}"`);
    expect(progress).toContain(">✓</a>");
    // Oldest first, left to right.
    expect(progress.indexOf('href="#day-2026-10-21"')).toBeLessThan(progress.indexOf(`href="#day-${MON}"`));
    expect(progress).toContain("<b>🔥 2</b><span>current streak</span>");
  });

  it("#78: learnings: understood with evidence, then explained only", async () => {
    const s = await seed();
    const empty = (await get(`/console/testers/${s.tester.id}?tab=progress`, cookieFor("Yanni"))).body;
    expect(empty).toContain("No lessons yet.");
    await t.db.insert(takeaways).values([
      { testerId: s.tester.id, goalSlug: "reading", day: MON, text: "Phone in the other room", evidence: "explained", createdAt: at(MON, "20:00") },
      { testerId: s.tester.id, goalSlug: "reading", day: "2026-11-04", text: "Phone in the other room", evidence: "applied", createdAt: at("2026-11-04", "20:00") },
      { testerId: s.tester.id, goalSlug: "reading", day: "2026-11-05", text: "One line per chapter", evidence: "explained", createdAt: at("2026-11-05", "20:00") },
    ]);
    const progress = (await get(`/console/testers/${s.tester.id}?tab=progress`, cookieFor("Yanni"))).body;
    expect(progress).toContain("Phone in the other room<div class=\"muted\">explained Mon 2026-11-02, applied Wed 2026-11-04</div>");
    expect(progress).toContain("One line per chapter<div class=\"muted\">explained Thu 2026-11-05</div>");
    const order = ["Understood (applied or recalled)", "Phone in the other room", "Explained only, starting to click", "One line per chapter"].map((x) => progress.indexOf(x));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
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

  it("#97: serves a voice note in pieces when the browser asks (Safari), with the same guards", async () => {
    const s = await seed();
    const [voice] = await t.db
      .insert(messages)
      .values({ direction: "inbound", contactNumber: ME, mediaUrl: "https://cdn.example/v.caf", mediaKey: `media/${s.tester.id}/v.caf`, mediaContentType: "audio/x-caf", transcript: "did my pages", createdAt: at(MON, "20:00") })
      .returning();
    await t.media.put(`media/${s.tester.id}/v.caf`, new Uint8Array([1, 2, 3, 4, 5, 6]), "audio/x-caf");
    const ranged = (range: string, id = voice!.id) => t.app.inject({ method: "GET", url: `/console/media/${id}`, headers: { cookie: cookieFor("Yanni"), range } });
    const part = await ranged("bytes=0-1");
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 0-1/6");
    expect(part.headers["accept-ranges"]).toBe("bytes");
    expect(part.headers["content-security-policy"]).toBe("sandbox");
    expect(part.headers["x-content-type-options"]).toBe("nosniff");
    expect([...part.rawPayload]).toEqual([1, 2]);
    expect([...(await ranged("bytes=4-")).rawPayload]).toEqual([5, 6]);
    expect([...(await ranged("bytes=-2")).rawPayload]).toEqual([5, 6]);
    expect((await ranged("bytes=9-12")).statusCode).toBe(416);
    // A plain request still gets the whole file.
    const whole = await get(`/console/media/${voice!.id}`, cookieFor("Yanni"));
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect([...whole.rawPayload]).toEqual([1, 2, 3, 4, 5, 6]);
    // Never someone else's file, range or not, and never without a login.
    const [stranger] = await t.db
      .insert(messages)
      .values({ direction: "inbound", contactNumber: "+15555550199", mediaUrl: "https://cdn.example/s.caf", mediaKey: "media/s.caf" })
      .returning();
    await t.media.put("media/s.caf", new Uint8Array([1, 2]), "audio/x-caf");
    expect((await ranged("bytes=0-1", stranger!.id)).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: `/console/media/${voice!.id}`, headers: { range: "bytes=0-1" } })).statusCode).not.toBe(206);
  });

  it("#97: a voice note Chrome can't play offers a download; one it can play doesn't", async () => {
    const s = await seed();
    const [caf] = await t.db
      .insert(messages)
      .values({ direction: "inbound", contactNumber: ME, mediaUrl: "https://cdn.example/v.caf", mediaKey: `media/${s.tester.id}/v.caf`, mediaContentType: "audio/x-caf", transcript: "caf note", createdAt: at(MON, "20:00") })
      .returning();
    const [m4a] = await t.db
      .insert(messages)
      .values({ direction: "inbound", contactNumber: ME, mediaUrl: "https://cdn.example/v.m4a", mediaKey: `media/${s.tester.id}/v.m4a`, mediaContentType: "audio/mp4", transcript: "m4a note", createdAt: at(MON, "20:05") })
      .returning();
    const texts = (await get(`/console/testers/${s.tester.id}?tab=texts`, cookieFor("Yanni"))).body;
    expect(texts).toContain(`<audio controls preload="none" src="/console/media/${caf!.id}"`);
    expect(texts).toContain(`<a class="media-download" href="/console/media/${caf!.id}" download hidden>`);
    expect(texts).not.toContain(`href="/console/media/${m4a!.id}" download`);
  });
});

describe("#106: compact header and side tab rail", () => {
  const header = (page: string) => page.slice(page.indexOf('<details class="card hdr"'), page.indexOf("</details>", page.indexOf('<details class="card hdr"')));

  it("puts name, status, number, streak and hit rate on one line, and focus and settings only under More", async () => {
    const s = await seed();
    await t.db.update(testers).set({ clockOffsetMs: 2 * 24 * 60 * 60_000 }).where(eq(testers.id, s.tester.id));
    const page = (await get(`/console/testers/${s.tester.id}`, cookieFor("Yanni"))).body;
    const h = header(page);
    const line = h.slice(0, h.indexOf("</summary>"));
    const more = h.slice(h.indexOf("</summary>"));
    for (const x of ["Sam", '<span class="chip">active</span>', "⏩ test clock +2d", ME.slice(-4), "🔥 2", "100%", "More"]) expect(line).toContain(x);
    for (const x of ["Focus: <strong>finish Dune by Dec 1</strong>", "Category: Read &amp; learn more", "America/New_York", "quiet 22:00 to 09:00", "(maintenance)"]) {
      expect(more).toContain(x);
      expect(line).not.toContain(x);
    }
  });

  it("keeps a pause on the main line", async () => {
    const s = await seed();
    await t.db.insert(pauses).values({ testerId: s.tester.id, startedAt: at("2026-11-09", "10:00"), until: "2026-11-16" });
    const line = header((await get(`/console/testers/${s.tester.id}`, cookieFor("Yanni"))).body).split("</summary>")[0]!;
    expect(line).toContain("paused until 2026-11-16");
  });

  it("starts with the tab rail closed, every tab a plain link, the Console badge on its icon", async () => {
    const s = await seed();
    const page = (await get(`/console/testers/${s.tester.id}?tab=memory`, cookieFor("Yanni"))).body;
    const start = page.indexOf('<nav class="rail closed"');
    expect(start).toBeGreaterThan(0);
    const rail = page.slice(start, page.indexOf("</nav>", start));
    for (const tab of ["console", "texts", "memory", "progress"]) expect(rail).toContain(`href="/console/testers/${s.tester.id}?tab=${tab}"`);
    expect(rail).toContain('<span class="badge">2</span>');
    expect(rail).toContain('aria-current="page" title="Memory"');
    // The old tab bar is gone.
    expect(page).not.toContain('<nav class="tabs">');
  });
});

describe("#107: pauses in the step log", () => {
  const progressOf = async (id: string) => (await get(`/console/testers/${id}?tab=progress`, cookieFor("Yanni"))).body;
  const goalNumbers = (page: string) => page.slice(page.indexOf('id="goals"'), page.indexOf('id="learnings"')).match(/<b>[^<]*<\/b>/g);

  it("shows a pause between the step days around it, with start, return date, actual end, how it ended and why", async () => {
    const s = await seed();
    await t.db.insert(pauses).values({ testerId: s.tester.id, startedAt: at("2026-10-28", "18:00"), until: "2026-11-01", reason: "family trip", endedAt: at("2026-11-01", "09:00"), endedBy: "end_date" });
    const progress = await progressOf(s.tester.id);
    const card = progress.slice(progress.indexOf('class="card pause-row"'));
    expect(card).toContain("Paused Wed, Oct 28");
    expect(card).toContain("said back Sun, Nov 1");
    expect(card).toContain("ended Sun, Nov 1, 9:00 AM (their return date)");
    expect(card).toContain("“family trip”");
    // Newest first: Nov 2, the pause, then Oct 26.
    const order = [`id="day-${MON}"`, 'class="card pause-row"', 'id="day-2026-10-26"'].map((x) => progress.indexOf(x));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The dot strip, oldest first: Oct 26, the ⏸ marker, Nov 2; still five step days.
    const strip = [`href="#day-2026-10-26"`, 'class="dot pause"', `href="#day-${MON}"`].map((x) => progress.indexOf(x));
    expect(strip).toEqual([...strip].sort((a, b) => a - b));
    expect(progress).toContain("Last 5 step days");
  });

  it("says ongoing for a pause still on, and has no reason line without a reason", async () => {
    const s = await seed();
    await t.db.insert(pauses).values({ testerId: s.tester.id, startedAt: at("2026-11-08", "10:00"), until: "2026-11-16" });
    const card = (await progressOf(s.tester.id)).split('class="card pause-row"')[1]!.split("</div></div>")[0]!;
    expect(card).toContain("Paused Sun, Nov 8");
    expect(card).toContain("said back Mon, Nov 16");
    expect(card).toContain("ongoing");
    expect(card).not.toContain("“");
  });

  it("says in plain words when they came back early", async () => {
    const s = await seed();
    await t.db.insert(pauses).values({ testerId: s.tester.id, startedAt: at("2026-10-28", "18:00"), endedAt: at("2026-10-30", "12:00"), endedBy: "tester" });
    expect(await progressOf(s.tester.id)).toContain("ended Fri, Oct 30, 12:00 PM (they came back)");
  });

  it("never changes the streak or hit rate", async () => {
    const s = await seed();
    const before = goalNumbers(await progressOf(s.tester.id));
    await t.db.insert(pauses).values({ testerId: s.tester.id, startedAt: at("2026-10-28", "18:00"), until: "2026-11-01", endedAt: at("2026-11-01", "09:00"), endedBy: "end_date" });
    expect(goalNumbers(await progressOf(s.tester.id))).toEqual(before);
    expect(before?.length).toBeGreaterThan(0);
  });
});

describe("#181: their own goal as Focus, the menu choice as Category", () => {
  const READING = "Read &amp; learn more (books, ideas, any topic)";
  const page = async (id: string, tab = "progress") => (await get(`/console/testers/${id}?tab=${tab}`, cookieFor("Yanni"))).body;

  it("shows the plan's destination as Focus and the menu choice as Category, in the header and on the goal card", async () => {
    const s = await seed();
    const progress = await page(s.tester.id);
    expect(progress).toContain("Focus: <strong>finish Dune by Dec 1</strong>");
    expect(progress).toContain(`Category: ${READING}`);
    expect(progress).toContain(`<h3 style="margin:0">finish Dune by Dec 1</h3><span class="chip">focus</span>`);
    expect(progress).not.toContain(`Focus: <strong>${READING}`);
    // The separate "Headed for" card is gone: the focus card says it.
    expect(progress).not.toContain("Headed for:");
  });

  it("falls back to what they said in onboarding, then to \"figuring it out\", always keeping the category", async () => {
    const s = await seed();
    // Exercise (maintenance) has no destination: its onboarding answer is the focus.
    await t.db.insert(planInputs).values({ testerId: s.tester.id, goalSlug: "exercise", what: "push-ups before work" });
    // A dropped goal with nothing at all.
    await t.db.insert(testerGoals).values({ testerId: s.tester.id, goalSlug: "bedtime", role: "dropped", roleSince: at("2026-10-20", "12:00") });
    const progress = await page(s.tester.id);
    expect(progress).toContain(`<h3 style="margin:0">push-ups before work</h3><span class="chip">maintenance</span>`);
    expect(progress).toMatch(/<h3 style="margin:0">figuring it out<\/h3><span class="chip">dropped<\/span>/);
    expect(progress).toContain("Category: Get fitter");
    // The focus with no destination and no answer: "figuring it out", never the category.
    await t.db.update(plans).set({ destination: null }).where(eq(plans.testerId, s.tester.id));
    const header = await page(s.tester.id, "console");
    expect(header).toContain("Focus: <strong>figuring it out</strong>");
    expect(header).toContain(`Category: ${READING}`);
  });

  it("uses the newest locked plan's destination, not a draft's", async () => {
    const s = await seed();
    await t.db.insert(plans).values({ testerId: s.tester.id, goalSlug: "reading", status: "draft", step: "x", destination: "a draft idea", stepTime: "19:00", days: ["mon"], proof: "photo", reason: "r" });
    expect(await page(s.tester.id)).toContain("Focus: <strong>finish Dune by Dec 1</strong>");
  });

  it("shows the same Focus and Category on the home list", async () => {
    await seed();
    const home = (await get("/console", cookieFor("Yanni"))).body;
    expect(home).toContain(`finish Dune by Dec 1 <span class="muted">· ${READING}</span> · 🔥 2`);
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
    expect(row!.body).toBe(
      "Week of 2026-11-01 to 2026-11-07: 3 of 7 step days done (1 reduced), streak 0.\nHeaded for: no destination yet.\nNo lessons applied or recalled this week.",
    );
  });

  it("#78: shows the week's learnings with their evidence, and the destination", async () => {
    const s = await seed();
    const lesson = (day: string, text: string, evidence: "explained" | "applied" | "recalled") => ({
      testerId: s.tester.id,
      goalSlug: "reading",
      day,
      text,
      evidence,
      createdAt: at(day, "20:00"),
    });
    await t.db.insert(takeaways).values([
      lesson("2026-11-03", "Recall the chapter before the next", "recalled"),
      lesson("2026-11-09", "Phone in the other room", "explained"),
      lesson("2026-11-11", "Phone in the other room", "applied"),
      lesson("2026-11-12", "One line per chapter", "explained"),
    ]);
    const n = await weekNumbers(t.db, s.tester, "2026-11-15");
    expect(n).toMatchObject({ destination: "finish Dune by Dec 1" });
    const jobs = createConsoleJobs({ db: t.db, log: silent });
    await jobs.tick(at("2026-11-15", "09:00"));
    const [row] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.kind, "summary"));
    const lines = row!.body.split("\n");
    expect(lines.slice(1)).toEqual([
      "Headed for: finish Dune by Dec 1.",
      'Understood this week: "Phone in the other room" (explained Mon 2026-11-09, applied Wed 2026-11-11)',
      'Explained only so far: "One line per chapter" (explained Thu 2026-11-12)',
    ]);
    // Last week's recall was last week's progress.
    expect(row!.body).not.toContain("Recall the chapter");
  });

  it("skips testers without a plan yet", async () => {
    await t.db.insert(testers).values({ phone: WESTERN, name: "New", phase: "onboarding", timeZone: TZ, timeZoneStatus: "assumed_eastern", consentAt: now, contextStartedAt: now });
    const jobs = createConsoleJobs({ db: t.db, log: silent });
    expect((await jobs.tick(at("2026-11-08", "09:00"))).summaries).toBe(0);
  });
});

describe("the Step log card's reflection sections (#93)", () => {
  const base: StepDay = {
    id: "d",
    testerId: "t1",
    date: "2026-11-02",
    planId: null,
    status: "done",
    movedTime: null,
    onItAt: null,
    agreedAt: null,
    note: null,
    proofVerdict: "clear",
    proofSeen: "Dune open at page 40",
    proofPendingAt: null,
    step: "chapter 3 of Dune",
    stepMinutes: null,
    stepProof: null,
    stepKind: "same",
    reflection: null,
    howItWentSaid: false,
    inTheWay: null,
    coachTake: null,
    nextReason: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const view = (day: Partial<StepDay>, learned: string[] = []): StepDayView => ({ day: { ...base, ...day }, proofs: [], learned });

  it("shows each section with its label, the reflection and the next step's reason, with a link to that day's texts", () => {
    const mon = view({ reflection: "Felt easy, wants a longer chapter", howItWentSaid: true, coachTake: "Did the full step, found it easy, wants more. Proof clear." }, ["Reading on the train beats bedtime"]);
    const tue = view({ date: "2026-11-03", step: "chapter 4 and 5 of Dune", nextReason: "Said one chapter felt easy", agreedAt: new Date(0), status: null });
    const html = stepLogSections(mon, [tue, mon], "t1");
    for (const label of ["Reflection:", "Learned:", "ZOH's take:", "Next step:"]) expect(html).toContain(label);
    expect(html).toContain("Felt easy, wants a longer chapter");
    expect(html).toContain("Reading on the train beats bedtime");
    expect(html).toContain("Did the full step, found it easy, wants more. Proof clear.");
    expect(html).toContain("chapter 4 and 5 of Dune");
    expect(html).toContain("Said one chapter felt easy");
    expect(html).toContain(">agreed<");
    expect(html).toContain('href="/console/testers/t1?tab=texts&amp;day=2026-11-02"');
    // A done day in full doesn't show what got in the way.
    expect(html).not.toContain("What got in the way");
  });

  it('says "None" when empty, "not recorded" for days from before, and shows what got in the way on a missed day', () => {
    const empty = stepLogSections(view({}), [], "t1");
    expect(empty.match(/>None</g)).toHaveLength(4);
    const old = stepLogSections(view({ howItWentSaid: null }), [], "t1");
    expect(old.match(/>not recorded</g)).toHaveLength(4);
    expect(old).not.toContain(">None<");
    const missed = stepLogSections(view({ status: "missed", inTheWay: "work ran late" }), [], "t1");
    expect(missed).toContain("What got in the way:</span> work ran late");
    const proposed = stepLogSections(view({}), [view({ date: "2026-11-04", step: "chapter 4" }), view({})], "t1");
    expect(proposed).toContain(">proposed<");
  });

  it("is on the Progress tab below the proof", async () => {
    const s = await seed();
    await t.db.update(stepDays).set({ reflection: "Train reading works", howItWentSaid: true, coachTake: "Steady, proof clear." }).where(eq(stepDays.testerId, s.tester.id));
    const page = (await get(`/console/testers/${s.tester.id}?tab=progress`, cookieFor("Yanni"))).body;
    expect(page).toContain("Train reading works");
    expect(page).toContain("Steady, proof clear.");
    expect(page.indexOf("Dune open at page 40")).toBeLessThan(page.indexOf("Train reading works"));
  });
});
