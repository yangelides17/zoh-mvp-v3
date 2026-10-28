import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoach } from "../src/coach/coach.js";
import { flags, memoryFacts, memoryLinks, memoryPages, messages, plans, testers, type Message, type Tester } from "../src/db/schema.js";
import type { MediaDescriber } from "../src/memory/describe.js";
import { createMemoryKeeper, daysDue, KEEPER_MAX_ROUNDS, runKeeperTool, writeDay } from "../src/memory/keeper.js";
import { renderPage } from "../src/memory/render.js";
import {
  addFact,
  createPage,
  ensureCorePages,
  ensureGoalPages,
  factRef,
  findPage,
  link,
  messageRef,
  pageRef,
  pathThrough,
  relatedPages,
  searchMemory,
  timeline,
} from "../src/memory/store.js";
import { zonedTime } from "../src/nudges/schedule.js";
import type { Logger } from "../src/pipeline/inbound.js";
import { getTester, resetTester } from "../src/testers/testers.js";
import { DEV, FakeClaudeModel, inboundEvent, makeApp, ME, postWebhook, WESTERN, type TestApp } from "./helpers.js";

const TZ = "America/New_York";
const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const THU = "2026-11-05";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);
const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function tester(phone = ME, o: Partial<typeof testers.$inferInsert> = {}): Promise<Tester> {
  const [row] = await t.db
    .insert(testers)
    .values({
      phone,
      name: "Mike",
      goalSlug: "reading",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at(MON, "08:00"),
      contextStartedAt: at(MON, "08:00"),
      ...o,
    })
    .returning();
  return row!;
}

async function say(who: Tester, direction: "inbound" | "outbound", when: Date, content: string, extra: Partial<Message> = {}): Promise<Message> {
  const [m] = await t.db.insert(messages).values({ direction, contactNumber: who.phone, content, createdAt: when, sentAt: when, ...extra }).returning();
  return m!;
}

const pagesOf = (who: Tester) => t.db.select().from(memoryPages).where(eq(memoryPages.testerId, who.id));
const dailyDocs = async (who: Tester) => (await pagesOf(who)).filter((p) => p.kind === "daily");

function keeper(model: FakeClaudeModel, phones = [ME]) {
  return createMemoryKeeper({ db: t.db, log: silent, model, allowedNumbers: phones });
}

describe("the overnight pass", () => {
  it("writes exactly one daily doc per texting day at 3 am, none for a silent day, and never runs a day twice", async () => {
    const mike = await tester();
    const m1 = await say(mike, "inbound", at(MON, "19:30"), "done, 10 pages");
    await say(mike, "outbound", at(MON, "19:31"), "LFG Mike!");
    // Tuesday: silence. Wednesday: one text.
    await say(mike, "inbound", at(WED, "20:00"), "did it again");

    const model = new FakeClaudeModel().script(
      { tools: [{ name: "write_daily_doc", input: { title: "Mon Nov 2: 10 pages", summary: "Read 10 pages.", body: `Done at 7:30 (${messageRef(m1.id)}).` } }] },
      "",
      { tools: [{ name: "write_daily_doc", input: { title: "Wed Nov 4: 10 pages", summary: "Read again.", body: "Done." } }] },
      "",
    );
    const k = keeper(model);

    // Before 3 am Tuesday, Monday isn't over for memory yet.
    expect((await k.tick(at(TUE, "02:59"))).size).toBe(0);
    expect(await dailyDocs(mike)).toHaveLength(0);

    expect([...(await k.tick(at(TUE, "03:00"))).values()]).toEqual([[MON]]);
    expect((await dailyDocs(mike)).map((d) => d.date)).toEqual([MON]);

    // Wednesday 3 am files Tuesday: no texts, so no doc and no Claude call.
    const calls = model.requests.length;
    await k.tick(at(WED, "03:00"));
    expect(model.requests.length).toBe(calls);
    expect((await getTester(t.db, mike.id))!.memoryThrough).toBe(TUE);

    await k.tick(at(THU, "03:00"));
    await k.tick(at(THU, "03:30"));
    await k.tick(at(THU, "09:00"));
    const docs = await dailyDocs(mike);
    expect(docs.map((d) => d.date).sort()).toEqual([MON, WED]);
    expect(docs.find((d) => d.date === MON)!.title).toBe("Mon Nov 2: 10 pages");
    expect(model.requests.length).toBe(4);
  });

  it("writes a plain daily doc when Claude never does, so every texting day still has one", async () => {
    const mike = await tester();
    await say(mike, "inbound", at(MON, "19:30"), "done");
    const model = new FakeClaudeModel("Nothing to file.");
    expect(await writeDay(t.db, model, mike, MON, at(TUE, "03:00"))).toBe(true);
    const [doc] = await dailyDocs(mike);
    expect(doc!.summary).toBe("1 text from them; no summary written.");
  });

  it("stops after its round limit", async () => {
    const mike = await tester();
    const m = await say(mike, "inbound", at(MON, "19:30"), "my sister Ana reads with me");
    const self = (await ensureCorePages(t.db, mike, at(MON, "20:00"))).self;
    const model = new FakeClaudeModel();
    for (let i = 0; i < KEEPER_MAX_ROUNDS + 3; i++) {
      model.script({ tools: [{ name: "add_fact", input: { page: pageRef(self.id), text: `fact ${i}`, source: messageRef(m.id) } }] });
    }
    await writeDay(t.db, model, mike, MON, at(TUE, "03:00"));
    expect(model.requests).toHaveLength(KEEPER_MAX_ROUNDS);
    expect(model.requests.at(-1)!.toolChoice).toBe("none");
  });

  it("reads the day's texts with refs, photos by their description, and the tester's core pages", async () => {
    const mike = await tester();
    const m = await say(mike, "inbound", at(MON, "19:30"), "page 112!", { mediaUrl: "https://cdn/x.jpg", mediaContentType: "image/jpeg", description: "A book open at page 112" });
    const model = new FakeClaudeModel();
    await writeDay(t.db, model, mike, MON, at(TUE, "03:00"));
    const req = model.requests[0]!;
    const texts = JSON.stringify(req.messages);
    expect(texts).toContain(messageRef(m.id));
    expect(texts).toContain("[photo: A book open at page 112] page 112!");
    expect(req.system[1]!.text).toContain("Mike (the tester)");
    expect(req.system[1]!.text).toContain("How they like to be coached");
    expect(req.system[1]!.text).toContain("Goal: Daily reading");
  });

  it("backfills up to 14 days on a tester's first run, never before their context started", async () => {
    const mike = await tester(ME, { contextStartedAt: at("2026-10-01", "08:00") });
    expect(daysDue(mike, at(THU, "03:00"))).toHaveLength(14);
    expect(daysDue(mike, at(THU, "03:00"))[0]).toBe("2026-10-22");
    const fresh = await tester(DEV, { contextStartedAt: at(TUE, "08:00") });
    expect(daysDue(fresh, at(THU, "03:00"))).toEqual([TUE, WED]);
    expect(daysDue({ ...fresh, memoryThrough: TUE }, at(THU, "02:00"))).toEqual([]);
  });

  it("only runs for allowed testers", async () => {
    const other = await tester(WESTERN);
    await say(other, "inbound", at(MON, "19:30"), "hi");
    const model = new FakeClaudeModel();
    await keeper(model, [ME]).tick(at(TUE, "03:00"));
    expect(model.requests).toHaveLength(0);
  });

  it("waits an hour after a failed day instead of retrying every minute", async () => {
    const mike = await tester();
    await say(mike, "inbound", at(MON, "19:30"), "done");
    const model = new FakeClaudeModel().script(new Error("overloaded"));
    const k = keeper(model);
    await k.tick(at(TUE, "03:00"));
    await k.tick(at(TUE, "03:01"));
    expect(model.requests).toHaveLength(1);
    expect((await getTester(t.db, mike.id))!.memoryThrough).toBeNull();
    await k.tick(at(TUE, "04:01"));
    expect(model.requests.length).toBeGreaterThan(1);
    expect((await getTester(t.db, mike.id))!.memoryThrough).toBe(MON);
  });
});

describe("facts cite the tester's own texts", () => {
  async function ctxFor(who: Tester) {
    return { db: t.db, tester: who, date: MON, at: at(TUE, "03:00"), wroteDoc: false };
  }

  it("creates a cited person page linked to the tester's page", async () => {
    const mike = await tester();
    const m = await say(mike, "inbound", at(MON, "19:30"), "my dog Max helps me sleep");
    const { self } = await ensureCorePages(t.db, mike, at(MON, "20:00"));
    const out = await runKeeperTool(await ctxFor(mike), "create_page", {
      kind: "subject",
      title: "Max (his dog)",
      summary: "His dog; helps him sleep.",
      facts: [{ text: "Max helps him sleep", source: messageRef(m.id) }],
    });
    expect(out.ok).toBe(true);
    const max = (await pagesOf(mike)).find((p) => p.title === "Max (his dog)")!;
    const [fact] = await t.db.select().from(memoryFacts).where(eq(memoryFacts.pageId, max.id));
    expect(fact!.sourceMessageId).toBe(m.id);
    expect(fact!.day).toBe(MON);
    expect((await relatedPages(t.db, max)).map((p) => p.id)).toEqual([self.id]);
  });

  it("rejects a fact citing another tester's text, ZOH's own text, or nothing real", async () => {
    const mike = await tester();
    const other = await tester(DEV);
    const theirs = await say(other, "inbound", at(MON, "19:30"), "my brother Leo");
    const zoh = await say(mike, "outbound", at(MON, "19:31"), "Your sister Ana sounds great");
    const { self } = await ensureCorePages(t.db, mike, at(MON, "20:00"));
    const ctx = await ctxFor(mike);
    for (const source of [messageRef(theirs.id), messageRef(zoh.id), "m:deadbeef", "not-a-ref"]) {
      const out = await runKeeperTool(ctx, "add_fact", { page: pageRef(self.id), text: "has a brother Leo", source });
      expect(out.ok, source).toBe(false);
    }
    const bad = await runKeeperTool(ctx, "create_page", { kind: "person", title: "Leo", summary: "x", facts: [{ text: "x", source: messageRef(theirs.id) }] });
    expect(bad.ok).toBe(false);
    expect(await t.db.select().from(memoryFacts).where(eq(memoryFacts.testerId, mike.id))).toHaveLength(0);
    expect((await pagesOf(mike)).map((p) => p.kind).sort()).toEqual(["preferences", "self"]);
  });

  it("never finds another tester's page or fact by ref", async () => {
    const mike = await tester();
    const other = await tester(DEV);
    const m = await say(other, "inbound", at(MON, "19:30"), "x");
    const theirs = await createPage(t.db, other.id, { kind: "person", title: "Leo", summary: "" }, at(MON, "20:00"));
    const fact = await addFact(t.db, theirs, { text: "secret", sourceMessageId: m.id }, at(MON, "20:00"));
    expect(await findPage(t.db, mike.id, pageRef(theirs.id))).toBeUndefined();
    const ctx = await ctxFor(mike);
    expect((await runKeeperTool(ctx, "open_page", { page: pageRef(theirs.id) })).ok).toBe(false);
    expect((await runKeeperTool(ctx, "remove_fact", { fact: factRef(fact.id) })).ok).toBe(false);
  });

  it("keeps stated preferences on the preferences page and voice on their own page", async () => {
    const mike = await tester();
    const m = await say(mike, "inbound", at(MON, "19:30"), "less hype pls lol");
    const { self, preferences } = await ensureCorePages(t.db, mike, at(MON, "20:00"));
    const ctx = await ctxFor(mike);
    expect((await runKeeperTool(ctx, "add_fact", { page: pageRef(self.id), text: "less hype", source: messageRef(m.id), section: "stated" })).ok).toBe(false);
    expect((await runKeeperTool(ctx, "add_fact", { page: pageRef(preferences.id), text: "less hype", source: messageRef(m.id), section: "stated" })).ok).toBe(true);
    expect((await runKeeperTool(ctx, "add_fact", { page: pageRef(self.id), text: "texts in lowercase, says lol", source: messageRef(m.id), section: "voice" })).ok).toBe(true);
  });

  it("carries style notes saved before memory over as stated preferences", async () => {
    const mike = await tester(ME, { styleNotes: "no emojis; gentler" });
    const { preferences } = await ensureCorePages(t.db, mike, at(MON, "20:00"));
    const text = await renderPage(t.db, mike, preferences);
    expect(text).toContain("Stated (they said so; always wins):\n- no emojis\n- gentler");
  });
});

describe("learned preferences need a pattern", () => {
  it(`refuses one from a single moment, and allows it after 3 observations on 3 different days`, async () => {
    const mike = await tester();
    const days = [MON, TUE, WED];
    const sources = [];
    for (const d of days) sources.push(await say(mike, "inbound", at(d, "08:05"), "ok ok im up, doing it"));
    const learn = { pattern: "replies fast to challenges", text: "Challenges work: lead with one." };

    const ctx = (date: string) => ({ db: t.db, tester: mike, date, at: at(date, "23:00"), wroteDoc: false });
    await runKeeperTool(ctx(MON), "record_observation", { pattern: learn.pattern, text: "Replied in 2 min to a challenge", source: messageRef(sources[0]!.id) });
    expect((await runKeeperTool(ctx(MON), "learn_preference", learn)).ok).toBe(false);
    // Two on the same day still isn't a pattern.
    await runKeeperTool(ctx(MON), "record_observation", { pattern: learn.pattern, text: "Again", source: messageRef(sources[0]!.id) });
    await runKeeperTool(ctx(TUE), "record_observation", { pattern: learn.pattern, text: "Replied fast again", source: messageRef(sources[1]!.id) });
    expect((await runKeeperTool(ctx(TUE), "learn_preference", learn)).ok).toBe(false);
    await runKeeperTool(ctx(WED), "record_observation", { pattern: learn.pattern, text: "And again", source: messageRef(sources[2]!.id) });
    expect((await runKeeperTool(ctx(WED), "learn_preference", learn)).ok).toBe(true);

    const learned = await t.db.select().from(memoryFacts).where(and(eq(memoryFacts.testerId, mike.id), eq(memoryFacts.section, "learned")));
    expect(learned.map((f) => f.text)).toEqual([learn.text]);
  });
});

describe("goal paths", () => {
  async function switched(who: Tester, from: string, to: string, reason: string, when: Date) {
    await t.db.insert(flags).values({ testerId: who.id, kind: "goal_switch", detail: `${from} → ${to}: ${reason}`, createdAt: when });
  }

  it("links goal pages in the order they had them and reads the whole path from either end", async () => {
    const mike = await tester(ME, { goalSlug: "exercise" });
    await switched(mike, "reading", "bedtime", "reading at night kept him up", at(MON, "10:00"));
    await switched(mike, "bedtime", "exercise", "sleep is fine now, wants to move", at(WED, "10:00"));
    await t.db.insert(plans).values([
      { testerId: mike.id, goalSlug: "exercise", status: "locked", version: 1, step: "10 push-ups", stepTime: "07:00", days: ["mon", "wed", "fri"], proof: "photo", reason: "Start small.", lockedAt: at(WED, "11:00") },
      { testerId: mike.id, goalSlug: "exercise", status: "locked", version: 2, step: "20 push-ups", stepTime: "07:00", days: ["mon", "wed", "fri"], proof: "photo", reason: "Building up.", lockedAt: at(THU, "11:00") },
    ]);
    const pages = await ensureGoalPages(t.db, mike, at(THU, "12:00"));
    expect(pages.map((p) => [p.goalSlug, p.status])).toEqual([
      ["reading", "past"],
      ["bedtime", "past"],
      ["exercise", "active"],
    ]);

    const [reading, , exercise] = pages;
    const forward = await pathThrough(t.db, reading!);
    const backward = await pathThrough(t.db, exercise!);
    expect(forward.map((p) => p.goalSlug)).toEqual(["reading", "bedtime", "exercise"]);
    expect(backward.map((p) => p.goalSlug)).toEqual(["reading", "bedtime", "exercise"]);

    const text = await renderPage(t.db, mike, exercise!);
    expect(text).toMatch(/Goal path, first to latest: .*Goal: Daily reading .*→ .*Goal: Same bedtime every night \[switched Nov 2: reading at night kept him up\] → .*Goal: Daily exercise \(this page\) \[switched Nov 4: sleep is fine now, wants to move\]/);
    expect(text).toContain("Step path, first to latest: v1 (Nov 4): 10 push-ups → v2 (Nov 5): 20 push-ups (current)");

    // Running it again changes nothing.
    await ensureGoalPages(t.db, mike, at(THU, "13:00"));
    expect(await t.db.select().from(memoryLinks).where(eq(memoryLinks.kind, "leads_to"))).toHaveLength(2);
  });

  it("shows related links on both pages", async () => {
    const mike = await tester();
    const ana = await createPage(t.db, mike.id, { kind: "person", title: "Ana (his sister)", summary: "" }, at(MON, "20:00"));
    const [goal] = await ensureGoalPages(t.db, mike, at(MON, "20:00"));
    await link(t.db, mike.id, ana.id, goal!.id, "related");
    await link(t.db, mike.id, goal!.id, ana.id, "related");
    expect((await relatedPages(t.db, ana)).map((p) => p.id)).toEqual([goal!.id]);
    expect((await relatedPages(t.db, goal!)).map((p) => p.id)).toEqual([ana.id]);
    expect(await renderPage(t.db, mike, goal!)).toContain(`Related: ${pageRef(ana.id)} Ana (his sister)`);
    expect(await t.db.select().from(memoryLinks).where(eq(memoryLinks.kind, "related"))).toHaveLength(1);
  });
});

describe("search and the timeline", () => {
  it("finds facts, pages and texts by word form, only for this tester and never forgotten texts", async () => {
    const mike = await tester();
    const other = await tester(DEV);
    const m = await say(mike, "inbound", at(MON, "19:30"), "my knee was hurting after running");
    await say(other, "inbound", at(MON, "19:30"), "my knee is fine");
    const page = await createPage(t.db, mike.id, { kind: "subject", title: "Left knee", summary: "Sore after runs" }, at(MON, "20:00"));
    await addFact(t.db, page, { text: "Knee hurts after long runs", sourceMessageId: m.id }, at(MON, "20:00"));

    const hits = await searchMemory(t.db, mike, "knee run");
    expect(hits.map((h) => h.ref)).toEqual(expect.arrayContaining([pageRef(page.id), messageRef(m.id)]));
    expect(hits.some((h) => h.text === "my knee is fine")).toBe(false);

    await t.db.insert((await import("../src/db/schema.js")).memoryForgotten).values({ testerId: mike.id, messageId: m.id });
    expect((await searchMemory(t.db, mike, "hurting")).some((h) => h.ref === messageRef(m.id))).toBe(false);
  });

  it("lists pages, daily docs and media newest first", async () => {
    const mike = await tester();
    await say(mike, "inbound", at(MON, "08:00"), "", { mediaUrl: "https://cdn/a.caf", mediaContentType: "audio/x-caf", transcript: "ran 3 miles" });
    const ana = await createPage(t.db, mike.id, { kind: "person", title: "Ana (his sister)", summary: "Reads with him" }, at(MON, "09:00"));
    await say(mike, "inbound", at(MON, "10:00"), "", { mediaUrl: "https://cdn/b.jpg", mediaContentType: "image/jpeg", description: "Dune open at page 40" });
    const items = await timeline(t.db, mike, 30);
    expect(items.map((i) => [i.kind, i.summary])).toEqual([
      ["photo", "Dune open at page 40"],
      ["person", "Reads with him"],
      ["voice note", "ran 3 miles"],
    ]);
    expect(items[1]!.ref).toBe(pageRef(ana.id));
  });
});

describe("media goes into memory as it arrives", () => {
  class FakeDescriber implements MediaDescriber {
    calls: { caption?: string; at: number }[] = [];
    async describe(_image: unknown, caption?: string) {
      this.calls.push({ caption, at: performance.now() });
      return "Dune open at page 112";
    }
  }

  it("describes a photo right after the reply is sent, and search finds it at once", async () => {
    await t.close();
    const describer = new FakeDescriber();
    t = await makeApp({ describer });
    await postWebhook(t, inboundEvent({ content: "pages done", media_url: "https://cdn.example/photo.jpg" }));
    await t.queue.idle();
    const [stored] = await t.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(stored!.description).toBe("Dune open at page 112");
    expect(describer.calls[0]!.caption).toBe("pages done");
    expect(describer.calls[0]!.at).toBeGreaterThan(t.sendblue.sends[0]!.at);

    const mike = (await t.db.select().from(testers))[0]!;
    expect((await searchMemory(t.db, mike, "Dune")).map((h) => h.ref)).toContain(messageRef(stored!.id));
    expect((await timeline(t.db, mike))[0]!.summary).toBe("Dune open at page 112 · pages done");
  });

  it("makes a voice note searchable by its transcript right away", async () => {
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.example/note.caf" }));
    await t.queue.idle();
    const mike = (await t.db.select().from(testers))[0]!;
    const hits = await searchMemory(t.db, mike, "run");
    expect(hits[0]!.where).toBe("their voice note");
    expect(hits[0]!.text).toBe("I went for a run this morning");
  });

  it("never lets a failed description touch the reply", async () => {
    await t.close();
    t = await makeApp({ describer: { describe: async () => { throw new Error("Claude down"); } } });
    await postWebhook(t, inboundEvent({ media_url: "https://cdn.example/photo.jpg" }));
    await t.queue.idle();
    expect(t.sendblue.sends).toHaveLength(1);
    const [stored] = await t.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(stored!.status).toBe("REPLIED");
    expect(stored!.description).toBeNull();
  });
});

describe("stop and reset", () => {
  it("keeps memory when a tester texts stop, and wipes it on a dev-account reset", async () => {
    await postWebhook(t, inboundEvent({ from_number: DEV, number: DEV, content: "hi" }));
    await t.queue.idle();
    let dev = (await t.db.select().from(testers).where(eq(testers.phone, DEV)))[0]!;
    const m = (await t.db.select().from(messages).where(eq(messages.direction, "inbound")))[0]!;
    const { self } = await ensureCorePages(t.db, dev, new Date());
    await addFact(t.db, self, { text: "likes dogs", sourceMessageId: m.id }, new Date());

    await postWebhook(t, inboundEvent({ from_number: DEV, number: DEV, content: "stop" }));
    await t.queue.idle();
    expect(await pagesOf(dev)).toHaveLength(2);

    dev = (await getTester(t.db, dev.id))!;
    dev = await resetTester(t.db, { ...dev, memoryThrough: MON }, new Date());
    expect(await pagesOf(dev)).toHaveLength(0);
    expect(await t.db.select().from(memoryFacts).where(eq(memoryFacts.testerId, dev.id))).toHaveLength(0);
    expect(dev.memoryThrough).toBeNull();
  });
});

describe("replies and nudges are unchanged by memory (part 1)", () => {
  it("gives the coach exactly the same input with or without memory rows", async () => {
    const mike = await tester();
    const m = await say(mike, "inbound", at(MON, "19:30"), "my sister Ana reads with me");
    const model = new FakeClaudeModel("Love that.");
    const coach = createCoach({ db: t.db, model, voice: "VOICE" });
    const input = { tester: mike, turns: [{ role: "user" as const, text: "my sister Ana reads with me" }], now: at(MON, "19:31") };

    await coach.reply(input);
    const { self } = await ensureCorePages(t.db, mike, at(MON, "20:00"));
    const ana = await createPage(t.db, mike.id, { kind: "person", title: "Ana (his sister)", summary: "Reads with him" }, at(MON, "20:00"));
    await addFact(t.db, self, { text: "has a sister Ana", sourceMessageId: m.id }, at(MON, "20:00"));
    await link(t.db, mike.id, self.id, ana.id, "related");
    await coach.reply(input);

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toEqual(model.requests[0]);
    expect(JSON.stringify(model.requests[1])).not.toContain("Ana (his sister)");
  });
});
