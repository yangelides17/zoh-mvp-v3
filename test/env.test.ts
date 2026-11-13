import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { encodeSession, newSession, SESSION_COOKIE } from "../src/console/auth.js";
import { addRequest } from "../src/console/requests.js";
import { createDraft } from "../src/console/drafts.js";
import { consoleMessages, messages, plans, testers, type Tester } from "../src/db/schema.js";
import { createMemoryKeeper } from "../src/memory/keeper.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { createNudgeScheduler } from "../src/nudges/scheduler.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { envReply, owns, parseEnv, routeOf, versionLabel, type AppEnv, type Routing } from "../src/testers/env.js";
import { getTesterByPhone } from "../src/testers/testers.js";
import { DEV, FakeClaudeModel, LINE, ME, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

/** Staging and production (#82): one Sendblue line, two apps, separate records. */

const TZ = "America/New_York";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
const silent = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const STAGING_BUILD = { release: "0.3.0", commit: "a1b2c3d" };
const PROD_BUILD = { release: "0.2.0", commit: "9f8e7d6" };
const PASSWORD = "open sesame";
const SECRET = "console-test-secret";

let t: TestApp;
let open = false;
afterEach(async () => {
  if (open) await t.close();
  open = false;
});

async function app(appEnv: AppEnv, extra: Parameters<typeof makeApp>[0] = {}) {
  const made = await makeApp({ appEnv, build: appEnv === "staging" ? STAGING_BUILD : PROD_BUILD, ...extra });
  open = true;
  return made;
}

async function text(content: string, from = DEV, extra: Record<string, unknown> = {}) {
  const res = await postWebhook(t, inboundEvent({ content, number: from, from_number: from, ...extra }));
  await t.queue.idle();
  return res;
}

const allMessages = () => t.db.select().from(messages).orderBy(messages.createdAt);
const routeOfDev = async () => (await getTesterByPhone(t.db, DEV))?.route;

/** A dev account on a given route, active on a daily reading plan. */
async function devTester(route: AppEnv, phone = DEV): Promise<Tester> {
  const [row] = await t.db
    .insert(testers)
    .values({
      phone,
      name: "Stamati",
      goalSlug: "reading",
      phase: "active",
      isTestUser: phone === DEV,
      route,
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at("2026-11-01", "10:00"),
      contextStartedAt: at("2026-11-01", "10:00"),
    })
    .returning();
  await t.db.insert(plans).values({
    testerId: row!.id,
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
  return row!;
}

describe("who owns a number", () => {
  const prod: Routing = { appEnv: "production", devNumbers: [DEV] };
  const staging: Routing = { appEnv: "staging", devNumbers: [DEV] };

  it("with no route saved, a dev number belongs to production, not staging", () => {
    expect(routeOf(prod, DEV, undefined)).toBe("production");
    expect(owns(prod, DEV, undefined)).toBe(true);
    expect(owns(staging, DEV, undefined)).toBe(false);
  });

  it("a dev number follows its route; a tester is always production's, whatever a row says", () => {
    expect(owns(staging, DEV, "staging")).toBe(true);
    expect(owns(prod, DEV, "staging")).toBe(false);
    expect(owns(prod, ME, "staging")).toBe(true);
    expect(owns(staging, ME, "staging")).toBe(false);
  });

  it("reads env, env staging, env production / prod in any case; nothing else", () => {
    expect(parseEnv("env")).toEqual({ kind: "show" });
    expect(parseEnv(" ENV Staging! ")).toEqual({ kind: "switch", to: "staging" });
    expect(parseEnv("env production")).toEqual({ kind: "switch", to: "production" });
    expect(parseEnv("Env prod")).toEqual({ kind: "switch", to: "production" });
    for (const other of ["envelope", "env staging please", "the env is staging", "", null]) expect(parseEnv(other)).toBeUndefined();
  });

  it("the reply names the app and its version", () => {
    expect(envReply("staging", STAGING_BUILD)).toBe("You're on staging (v0.3.0, a1b2c3d).");
    expect(envReply("production", { commit: "9f8e7d6" })).toBe("You're on production (9f8e7d6).");
    expect(envReply("production")).toBe("You're on production.");
    expect(versionLabel({ release: "0.2.0" })).toBe("v0.2.0");
  });
});

describe("production", () => {
  it("answers a dev number with no route, as today", async () => {
    t = await app("production");
    await text("Hi");
    expect(await allMessages()).toHaveLength(2);
    expect(t.replier.received).toHaveLength(1);
  });

  it("stores nothing from a dev number switched to staging, and never answers it", async () => {
    t = await app("production");
    await devTester("staging");
    const res = await text("did my 10 pages", DEV, { media_url: "https://cdn.example/photo.jpg" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ignored: "other environment" });
    expect(await allMessages()).toHaveLength(0);
    expect(t.sendblue.calls).toHaveLength(0);
    expect(t.media.objects.size).toBe(0);
    expect(t.replier.received).toHaveLength(0);
    // A jump from it is the other app's too.
    await text("jump 3h");
    expect(t.sendblue.calls).toHaveLength(0);
  });

  it("env staging: saves the route, stores nothing and stays quiet (staging answers)", async () => {
    t = await app("production");
    await text("env staging");
    expect(await routeOfDev()).toBe("staging");
    expect(await allMessages()).toHaveLength(0);
    expect(t.sendblue.calls).toHaveLength(0);
    // From now on its texts are staging's.
    await text("Hi");
    expect(await allMessages()).toHaveLength(0);
  });

  it("env production from a number on staging: switches back, stores both texts and confirms with its version", async () => {
    t = await app("production");
    await devTester("staging");
    await text("env production");
    expect(await routeOfDev()).toBe("production");
    const rows = await allMessages();
    expect(rows.map((m) => [m.direction, m.content])).toEqual([
      ["inbound", "env production"],
      ["outbound", "You're on production (v0.2.0, 9f8e7d6)."],
    ]);
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["You're on production (v0.2.0, 9f8e7d6)."]);
    expect(t.replier.received).toHaveLength(0);
  });

  it("env from a non-dev number is an ordinary text for the coach, and changes no route", async () => {
    t = await app("production");
    await text("env staging", ME);
    expect((await allMessages()).map((m) => m.content)).toEqual(["env staging", "Hey! Thanks for the message."]);
    expect(t.replier.received).toHaveLength(1);
    expect((await getTesterByPhone(t.db, ME))!.route).toBe("production");
  });

  it("ignores status events for messages it never sent", async () => {
    t = await app("production");
    const res = await postWebhook(t, { ...inboundEvent({ is_outbound: true, status: "DELIVERED", number: DEV }), message_handle: "staging-handle-1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outbound: true, updated: 0 });
    expect(await allMessages()).toHaveLength(0);
  });
});

describe("staging", () => {
  it("stores nothing from a tester: no row, no media copy, no reply", async () => {
    t = await app("staging");
    const res = await text("Here's my photo", ME, { media_url: "https://cdn.example/photo.jpg" });
    expect(res.json()).toMatchObject({ ignored: "other environment" });
    expect(await allMessages()).toHaveLength(0);
    expect(await t.db.select().from(testers)).toHaveLength(0);
    expect(t.sendblue.calls).toHaveLength(0);
    expect(t.replier.received).toHaveLength(0);
  });

  it("stores nothing from a dev number that hasn't switched (production by default), even env", async () => {
    t = await app("staging");
    await text("Hi");
    await text("env");
    expect(await allMessages()).toHaveLength(0);
    expect(t.sendblue.calls).toHaveLength(0);
  });

  it("env staging: saves the route, stores the text, confirms with its version; then the coach answers here", async () => {
    t = await app("staging");
    await text("env staging");
    expect(await routeOfDev()).toBe("staging");
    expect((await allMessages()).map((m) => m.content)).toEqual(["env staging", "You're on staging (v0.3.0, a1b2c3d)."]);
    await text("env");
    expect(t.sendblue.sends.at(-1)!.content).toBe("You're on staging (v0.3.0, a1b2c3d).");
    await text("Hi");
    expect(t.replier.received).toHaveLength(1);
    expect(await allMessages()).toHaveLength(6);
  });

  it("env production: saves the route, stores nothing and stays quiet; later texts aren't its own", async () => {
    t = await app("staging");
    await devTester("staging");
    await text("env production");
    expect(await routeOfDev()).toBe("production");
    expect(await allMessages()).toHaveLength(0);
    expect(t.sendblue.calls).toHaveLength(0);
    await text("Hi");
    expect(await allMessages()).toHaveLength(0);
  });
});

describe("texts ZOH starts follow the route", () => {
  const NOON = at("2026-11-03", "12:00");

  function scheduler(appEnv: AppEnv) {
    return createNudgeScheduler({
      db: t.db,
      log: silent,
      sendblue: t.sendblue,
      replier: t.replier,
      allowedNumbers: [ME, DEV],
      lineNumber: LINE,
      routing: { appEnv, devNumbers: [DEV] },
    });
  }

  it("a founder's queued text to a number on staging goes out from staging, never production", async () => {
    t = await app("production");
    const dev = await devTester("staging");
    await addRequest(t.db, { testerId: dev.id, author: "Yanni", body: "Exactly this", exact: true, sendNow: true, at: NOON });

    const production = scheduler("production");
    await production.tick(NOON);
    await production.tickTester(dev, NOON);
    expect(t.sendblue.sends).toHaveLength(0);

    await scheduler("staging").tick(NOON);
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["Exactly this"]);
  });

  it("ZOH's own nudges skip a number the app doesn't own", async () => {
    t = await app("production");
    await devTester("staging");
    await t.db.insert(messages).values([
      { direction: "inbound", contactNumber: DEV, content: "I'm in", createdAt: at("2026-11-01", "11:59") },
      { direction: "outbound", contactNumber: DEV, content: "LET'S GO", createdAt: at("2026-11-01", "12:00") },
    ]);
    const tuesday = async (s: ReturnType<typeof scheduler>) => {
      for (let ms = at("2026-11-02", "09:00").getTime(); ms <= at("2026-11-02", "21:00").getTime(); ms += 5 * 60_000) await s.tick(new Date(ms));
    };
    await tuesday(scheduler("production"));
    expect(t.replier.nudges).toHaveLength(0);
    await tuesday(scheduler("staging"));
    expect(t.replier.nudges.length).toBeGreaterThan(0);
  });

  it("the overnight memory pass skips a number the app doesn't own", async () => {
    t = await app("production");
    const dev = await devTester("staging");
    await t.db.insert(messages).values({ direction: "inbound", contactNumber: dev.phone, content: "done", createdAt: at("2026-11-02", "19:30") });
    const model = new FakeClaudeModel();
    const keeper = (appEnv: AppEnv) =>
      createMemoryKeeper({ db: t.db, log: silent, model, allowedNumbers: [DEV], routing: { appEnv, devNumbers: [DEV] } });
    expect((await keeper("production").tick(at("2026-11-03", "03:00"))).size).toBe(0);
    expect(model.requests).toHaveLength(0);
    await keeper("staging").tick(at("2026-11-03", "03:00"));
    expect(model.requests.length).toBeGreaterThan(0);
  });
});

describe("the console", () => {
  const consoleConfig = { password: PASSWORD, sessionSecret: SECRET, names: ["Yanni"] };
  const cookie = () => `${SESSION_COOKIE}=${encodeURIComponent(encodeSession(newSession(new Date(), "Yanni"), SECRET))}`;

  it("says STAGING (with its version) on every staging page, login included, and never on production", async () => {
    t = await app("staging", { console: consoleConfig });
    const login = await t.app.inject({ method: "GET", url: "/console" });
    expect(login.body).toContain("STAGING · v0.3.0, a1b2c3d");
    const home = await t.app.inject({ method: "GET", url: "/console", headers: { cookie: cookie() } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('class="env-banner"');
    await t.close();

    t = await app("production", { console: consoleConfig });
    for (const headers of [{}, { cookie: cookie() }]) {
      const page = await t.app.inject({ method: "GET", url: "/console", headers });
      expect(page.body).not.toContain("STAGING");
    }
  });

  it("refuses a founder text to a number on the other app, saying where it is", async () => {
    t = await app("production", { console: consoleConfig });
    const dev = await devTester("staging");
    const res = await t.app.inject({
      method: "POST",
      url: `/console/testers/${dev.id}/chat`,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() },
      payload: new URLSearchParams({ text: "Hey from Yanni" }).toString(),
    });
    expect(res.statusCode).toBeLessThan(400);
    await t.queue.idle();
    const thread = await t.db.select().from(consoleMessages).where(eq(consoleMessages.testerId, dev.id));
    expect(thread.find((m) => m.kind === "founder")).toMatchObject({ body: "Hey from Yanni" });
    expect(thread.some((m) => m.kind === "request")).toBe(false);
    expect(thread.some((m) => m.body.includes("This number is on staging right now"))).toBe(true);
    // #155: a draft for a number the other app owns can't be confirmed here either.
    const draft = await createDraft(t.db, { testerId: dev.id, author: "Yanni", action: "send_text", input: { words: "Hey from Yanni" }, summary: "Text them", at: new Date() });
    const confirm = await t.app.inject({ method: "POST", url: `/console/testers/${dev.id}/drafts/${draft.id}/confirm`, headers: { cookie: cookie() } });
    expect(confirm.statusCode).toBe(409);
    const [still] = await t.db.select().from(consoleMessages).where(eq(consoleMessages.id, draft.id));
    expect(still!.draftStatus).toBe("draft");
    await createNudgeScheduler({
      db: t.db,
      log: silent,
      sendblue: t.sendblue,
      replier: t.replier,
      allowedNumbers: [DEV],
      routing: { appEnv: "staging", devNumbers: [DEV] },
    }).tick(new Date());
    // Only the refused text matters: on the wall clock, day 1's own kickoff can be due (its start date is fixed).
    expect(t.sendblue.sends.filter((s) => s.content?.includes("Hey from Yanni"))).toHaveLength(0);
  });
});
