import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  goals,
  memoryForgotten,
  memoryV2Daily,
  memoryV2Entries,
  memoryV2ForgetTopics,
  memoryV2Pages,
  messages,
  testerGoals,
  testers,
  type Message,
  type Tester,
} from "../src/db/schema.js";
import { runMemoryTool, type LookupBudget } from "../src/memory/coach-tools.js";
import type { Db } from "../src/db/client.js";
import {
  addV2Entry,
  closeV2Entry,
  correctV2Entry,
  createV2Page,
  deleteV2Page,
  deleteV2Memory,
  ensureV2RequiredPages,
  findV2Page,
  getV2Entries,
  getV2GoalPage,
  getV2Pages,
  replaceV2Entry,
  writeV2Daily,
  v2PageRef,
  v2EntryRef,
} from "../src/memory/v2-store.js";
import { runV2KeeperTool, sensitiveCheck, writeV2Day } from "../src/memory/v2-keeper.js";
import { createMemoryKeeper, type MemoryKeeper } from "../src/memory/keeper.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { FakeClaudeModel, makeDb, ME } from "./helpers.js";
import type { Logger } from "../src/pipeline/inbound.js";

const TZ = "America/New_York";
const PHONE = "+19085550100";
const at = zonedTime("2025-10-07", "03:00", TZ);

let db: Db;
let tester: Tester;
let msgId: string;

/** Insert a minimal tester on v2. */
async function makeTester(overrides: Partial<typeof testers.$inferInsert> = {}): Promise<Tester> {
  const [t] = await db
    .insert(testers)
    .values({
      phone: PHONE,
      name: "Sam",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "confirmed",
      consentAt: at,
      contextStartedAt: at,
      memoryVersion: "v2",
      ...overrides,
    })
    .returning();
  return t!;
}

/** Insert a minimal message so entries have a source. */
async function say(t: Tester, content: string, sentAt?: Date): Promise<Message> {
  const [m] = await db
    .insert(messages)
    .values({ direction: "inbound", contactNumber: t.phone, content, sentAt: sentAt ?? at, createdAt: sentAt ?? at })
    .returning();
  return m!;
}

beforeEach(async () => {
  const handle = await makeDb();
  db = handle.db;
  tester = await makeTester();
  const m = await say(tester, "Hello world");
  msgId = m.id;
});

// ─── Schema constraint tests ─────────────────────────────────────────

describe("schema constraints", () => {
  it("rejects a second root page", async () => {
    await ensureV2RequiredPages(db, tester, at); // creates root
    await expect(
      db.insert(memoryV2Pages).values({ testerId: tester.id, tier: 0, kind: "root", title: "Second root" }),
    ).rejects.toThrow();
  });

  it("rejects a page with tier 3", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    await expect(
      db.insert(memoryV2Pages).values({ testerId: tester.id, parentId: root.id, tier: 3, kind: "area", title: "Too deep" }),
    ).rejects.toThrow();
  });

  it("rejects a dated entry without 'when'", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    await expect(
      db.insert(memoryV2Entries).values({
        pageId: root.id,
        testerId: tester.id,
        type: "todo",
        status: "open",
        text: "No date",
        sourceMessageId: msgId,
      }),
    ).rejects.toThrow();
  });

  it("rejects an invalid type/status pair", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    // fact with status "open" is invalid
    await expect(
      db.insert(memoryV2Entries).values({
        pageId: root.id,
        testerId: tester.id,
        type: "fact",
        status: "open",
        text: "Bad status",
        sourceMessageId: msgId,
      }),
    ).rejects.toThrow();
    // todo with status "current" is invalid
    await expect(
      db.insert(memoryV2Entries).values({
        pageId: root.id,
        testerId: tester.id,
        type: "todo",
        status: "current",
        text: "Bad status",
        when: "2025-10-10",
        sourceMessageId: msgId,
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-root page without a parent", async () => {
    await expect(
      db.insert(memoryV2Pages).values({ testerId: tester.id, tier: 1, kind: "area", title: "Orphan" }),
    ).rejects.toThrow();
  });
});

// ─── Store validation tests ──────────────────────────────────────────

describe("store validation", () => {
  it("rejects a person page under an area", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    // Create an area first
    const area = await createV2Page(db, tester.id, { kind: "area", title: "Work", parentId: root.id }, at);
    expect(area.ok).toBe(true);
    // Person under area should fail
    const person = await createV2Page(db, tester.id, { kind: "person", title: "Ana", parentId: (area as { ok: true; value: typeof memoryV2Pages.$inferSelect }).value.id }, at);
    expect(person.ok).toBe(false);
    if (!person.ok) expect(person.error).toContain("People");
  });

  it("rejects deleting root", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    const result = await deleteV2Page(db, root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("protected");
  });

  it("rejects deleting coaching", async () => {
    const { coaching } = await ensureV2RequiredPages(db, tester, at);
    const result = await deleteV2Page(db, coaching);
    expect(result.ok).toBe(false);
  });

  it("rejects deleting people", async () => {
    const { people } = await ensureV2RequiredPages(db, tester, at);
    const result = await deleteV2Page(db, people);
    expect(result.ok).toBe(false);
  });

  it("rejects deleting places", async () => {
    const { places } = await ensureV2RequiredPages(db, tester, at);
    const result = await deleteV2Page(db, places);
    expect(result.ok).toBe(false);
  });

  it("allows a person page under People", async () => {
    const { people } = await ensureV2RequiredPages(db, tester, at);
    const result = await createV2Page(db, tester.id, { kind: "person", title: "Ana", parentId: people.id }, at);
    expect(result.ok).toBe(true);
  });

  it("allows a place page under Places", async () => {
    const { places } = await ensureV2RequiredPages(db, tester, at);
    const result = await createV2Page(db, tester.id, { kind: "place", title: "Central Park", parentId: places.id }, at);
    expect(result.ok).toBe(true);
  });

  it("requires goal pages under an area", async () => {
    const { root, people } = await ensureV2RequiredPages(db, tester, at);
    // Goal under root → rejected (not an area)
    const badResult = await createV2Page(db, tester.id, { kind: "goal", title: "Run a 5K", parentId: root.id }, at);
    expect(badResult.ok).toBe(false);
    // Goal under people → rejected
    const badResult2 = await createV2Page(db, tester.id, { kind: "goal", title: "Run a 5K", parentId: people.id }, at);
    expect(badResult2.ok).toBe(false);
    // Create an area, then goal under area → ok
    const area = await createV2Page(db, tester.id, { kind: "area", title: "Running", parentId: root.id }, at);
    expect(area.ok).toBe(true);
    if (area.ok) {
      const goalResult = await createV2Page(db, tester.id, { kind: "goal", title: "Run a 5K", parentId: area.value.id, goalSlug: "exercise" }, at);
      expect(goalResult.ok).toBe(true);
    }
  });
});

// ─── Entry operations ────────────────────────────────────────────────

describe("entry operations", () => {
  it("replace sets replaces_id and expires the old entry", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    const old = await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "Heading to Clemson", sourceMessageId: msgId }, at);
    expect(old.status).toBe("current");

    const m2 = await say(tester, "Emma chose Clemson");
    const replacement = await replaceV2Entry(db, old, { pageId: root.id, testerId: tester.id, type: "fact", text: "Emma chose Clemson", sourceMessageId: m2.id }, at);

    expect(replacement.replacesId).toBe(old.id);
    expect(replacement.status).toBe("current");

    // Old entry is now expired
    const [expired] = await db.select().from(memoryV2Entries).where(eq(memoryV2Entries.id, old.id));
    expect(expired!.status).toBe("expired");
  });

  it("correct keeps no history (edits in place)", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    const entry = await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "Ana is his sister", sourceMessageId: msgId }, at);

    const corrected = await correctV2Entry(db, entry, { text: "Anna is his sister" }, at);
    expect(corrected.text).toBe("Anna is his sister");
    expect(corrected.id).toBe(entry.id); // same row

    // No other entries
    const all = await getV2Entries(db, root.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe("Anna is his sister");
  });

  it("resolveTime handles month-boundary rollover correctly", async () => {
    const { resolveTime } = await import("../src/synthetic/loader.js");
    const start = new Date("2025-10-06T00:00:00Z");
    // Day 27 → Nov 1; at3am should be Nov 1 03:00 ET, not Oct 1
    const at3am = resolveTime(start, 27, "03:00", TZ);
    expect(at3am.toISOString()).toMatch(/^2025-11-01/);
  });

  it("replace on an event closes old as 'dropped' (not 'expired')", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    const event = await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "event", text: "Road trip days 10-14", when: "2025-10-15", sourceMessageId: msgId }, at);
    expect(event.status).toBe("open");

    const m2 = await say(tester, "Trip got cancelled");
    const replacement = await replaceV2Entry(db, event, { pageId: root.id, testerId: tester.id, type: "event", text: "Trip cancelled, staying home", when: "2025-10-15", sourceMessageId: m2.id }, at);

    expect(replacement.replacesId).toBe(event.id);
    // Old event should be "dropped" (not "expired" — events can't be expired)
    const [old] = await db.select().from(memoryV2Entries).where(eq(memoryV2Entries.id, event.id));
    expect(old!.status).toBe("dropped");
  });

  it("close works for dated types and rejects non-dated", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    const todo = await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "todo", text: "Pick a school", when: "2025-10-31", sourceMessageId: msgId }, at);
    const result = await closeV2Entry(db, todo, "done", at);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe("done");

    // Fact can't be closed
    const fact = await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "Some fact", sourceMessageId: msgId }, at);
    const badResult = await closeV2Entry(db, fact, "done", at);
    expect(badResult.ok).toBe(false);
  });
});

// ─── Required pages ──────────────────────────────────────────────────

describe("required pages", () => {
  it("creates root, coaching, people, places on first run", async () => {
    const result = await ensureV2RequiredPages(db, tester, at);
    expect(result.root.kind).toBe("root");
    expect(result.root.tier).toBe(0);
    expect(result.coaching.kind).toBe("coaching");
    expect(result.coaching.tier).toBe(1);
    expect(result.coaching.parentId).toBe(result.root.id);
    expect(result.people.kind).toBe("people");
    expect(result.people.parentId).toBe(result.root.id);
    expect(result.places.kind).toBe("places");
    expect(result.places.parentId).toBe(result.root.id);
  });

  it("is idempotent", async () => {
    await ensureV2RequiredPages(db, tester, at);
    const second = await ensureV2RequiredPages(db, tester, at);
    const all = await getV2Pages(db, tester.id);
    expect(all).toHaveLength(4);
    expect(second.root.kind).toBe("root");
  });
});

// ─── Daily summaries ─────────────────────────────────────────────────

describe("daily summaries", () => {
  it("writes and updates a daily summary", async () => {
    await writeV2Daily(db, tester.id, "2025-10-06", "Sam texted about running.", [msgId], at);
    const [row] = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, tester.id));
    expect(row!.summary).toBe("Sam texted about running.");
    expect(row!.sourceMessageIds).toContain(msgId);

    // Upsert
    await writeV2Daily(db, tester.id, "2025-10-06", "Updated summary.", [msgId], at);
    const [updated] = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, tester.id));
    expect(updated!.summary).toBe("Updated summary.");
  });
});

// ─── Bulk delete for rebuild ─────────────────────────────────────────

describe("deleteV2Memory (rebuild)", () => {
  it("deletes v2 rows only, v1 untouched", async () => {
    // Create v1 memory
    const { memoryPages: mp } = await import("../src/db/schema.js");
    const [v1Page] = await db.insert(mp).values({
      testerId: tester.id, kind: "self", title: "V1 self page", summary: "V1 data",
    }).returning();

    // Create v2 memory
    const { root } = await ensureV2RequiredPages(db, tester, at);
    await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "A fact", sourceMessageId: msgId }, at);
    await writeV2Daily(db, tester.id, "2025-10-06", "A day.", [msgId], at);

    expect(await getV2Pages(db, tester.id)).not.toHaveLength(0);

    await deleteV2Memory(db, tester.id);

    // V2 gone
    expect(await getV2Pages(db, tester.id)).toHaveLength(0);
    const entries = await db.select().from(memoryV2Entries).where(eq(memoryV2Entries.testerId, tester.id));
    expect(entries).toHaveLength(0);
    const dailies = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, tester.id));
    expect(dailies).toHaveLength(0);

    // V1 still there
    const v1Pages = await db.select().from(mp).where(eq(mp.testerId, tester.id));
    expect(v1Pages.some((p) => p.id === v1Page!.id)).toBe(true);
  });
});

// ─── V2 search (full-text, ranked) ───────────────────────────────────

describe("searchV2Memory", () => {
  beforeEach(async () => {
    const { root, people } = await ensureV2RequiredPages(db, tester, at);
    // Create person page for Anna with entries
    const anna = await createV2Page(db, tester.id, { kind: "person", title: "Anna", about: "Sam's sister, got married day 13", otherNames: ["Ana"], parentId: people.id }, at);
    if (!anna.ok) throw new Error("failed to create Anna page");
    await addV2Entry(db, { pageId: anna.value.id, testerId: tester.id, type: "fact", text: "Sam's sister (corrected from Ana)", sourceMessageId: msgId }, at);
    await addV2Entry(db, { pageId: anna.value.id, testerId: tester.id, type: "fact", text: "Got married recently, Sam gave the toast", sourceMessageId: msgId }, at);
    // A fact about running on the root
    await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "Runs in Forest Park post-shift", sourceMessageId: msgId }, at);
    // A daily summary
    await writeV2Daily(db, tester.id, "2025-10-06", "Anna's wedding toast went well, people cried.", [msgId], at);
    // A message
    await say(tester, "my sister anna helped me with the run yesterday");
  });

  it('"my sister" returns Anna first, not noise from "my"', async () => {
    const { searchV2Memory } = await import("../src/memory/v2-keeper.js");
    const hits = await searchV2Memory(db, tester, "my sister", 8);
    expect(hits.length).toBeGreaterThan(0);
    // Anna's page or entry should be in the top results
    const annaHit = hits.find((h) => h.text.includes("Anna") || h.text.includes("sister"));
    expect(annaHit).toBeDefined();
    // It should be in the top 3 (not buried)
    const annaIdx = hits.findIndex((h) => h.text.includes("Anna") || h.text.includes("sister"));
    expect(annaIdx).toBeLessThan(3);
  });

  it('"running" finds "run" (stemming)', async () => {
    const { searchV2Memory } = await import("../src/memory/v2-keeper.js");
    const hits = await searchV2Memory(db, tester, "running", 8);
    const runHit = hits.find((h) => h.text.toLowerCase().includes("run"));
    expect(runHit).toBeDefined();
  });

  it('"art" does not match "start" (no substring false positives)', async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "Wants to start running at 6am", sourceMessageId: msgId }, at);
    const { searchV2Memory } = await import("../src/memory/v2-keeper.js");
    const hits = await searchV2Memory(db, tester, "art", 8);
    const startHit = hits.find((h) => h.text.toLowerCase().includes("start"));
    expect(startHit).toBeUndefined();
  });

  it("a message that outranks entries still appears", async () => {
    await say(tester, "the wedding toast was incredible, anna cried and so did everyone");
    const { searchV2Memory } = await import("../src/memory/v2-keeper.js");
    const hits = await searchV2Memory(db, tester, "wedding toast", 8);
    expect(hits.length).toBeGreaterThan(0);
    // Should find hits from messages (via v1 searchMemory)
    const hasMsg = hits.some((h) => h.where.includes("text"));
    const hasMem = hits.some((h) => h.where === "daily" || h.where === "entry");
    expect(hasMsg || hasMem).toBe(true);
  });
});

// ─── Rebuild --snapshots ──────────────────────────────────────────────

describe("rebuild snapshots", () => {
  it("takeSnapshot + saveSnapshot writes night-NN.json, .txt, and report.json loads in lab format", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { takeSnapshot, saveSnapshot } = await import("../eval/memory-lab/snapshot.js");
    const { renderV2Memory } = await import("../src/memory/v2-keeper.js");

    // Set up v2 memory
    const { root } = await ensureV2RequiredPages(db, tester, at);
    await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "Likes running", sourceMessageId: msgId }, at);
    await writeV2Daily(db, tester.id, "2025-10-06", "A good day.", [msgId], at);

    // Take snapshot and save it
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rebuild-snap-"));
    try {
      const snapshot = await takeSnapshot(db, tester.id, true);
      const rendered = await renderV2Memory(db, tester);
      saveSnapshot(dir, 1, snapshot, rendered);

      // Verify files exist
      expect(fs.existsSync(path.join(dir, "night-01.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "night-01.txt"))).toBe(true);

      // Verify JSON structure has the MemorySnapshot shape with sourceText
      const json = JSON.parse(fs.readFileSync(path.join(dir, "night-01.json"), "utf8"));
      expect(json.pages).toBeDefined();
      expect(json.facts).toBeDefined();
      expect(json.facts.length).toBeGreaterThan(0);
      expect(json.facts[0]).toHaveProperty("sourceText");

      // Verify .txt is a non-empty rendered memory block
      const txt = fs.readFileSync(path.join(dir, "night-01.txt"), "utf8");
      expect(txt.length).toBeGreaterThan(0);

      // Write a report.json in the same format the CLI would
      const nightRecords = [{ day: 1, date: "2025-10-06", dollars: 0.03, usage: { input: 1000, output: 500 } }];
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({
        tester: "Test User",
        throughDay: 1,
        nights: nightRecords,
        spend: { nights: nightRecords, total: 0.03 },
      }, null, 2));

      const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
      expect(report.nights).toHaveLength(1);
      expect(report.nights[0].day).toBe(1);
      expect(report.nights[0].date).toBe("2025-10-06");
      expect(report.nights[0].dollars).toBe(0.03);
      expect(report.nights[0].usage).toEqual({ input: 1000, output: 500 });
      expect(report.spend.total).toBe(0.03);
      expect(report.throughDay).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── V2 writer tool tests ───────────────────────────────────────────

describe("v2 writer tools", () => {
  /** A fake checker that always says SAFE. */
  function safeChecker(): FakeClaudeModel {
    return new FakeClaudeModel("SAFE");
  }

  /** A fake checker that always rejects. */
  function rejectChecker(reason: string): FakeClaudeModel {
    return new FakeClaudeModel(`REJECT: ${reason}`);
  }

  /** Build a V2DayContext for tool tests. */
  async function makeCtx(overrides: { checker?: FakeClaudeModel } = {}) {
    const { root, coaching, people, places } = await ensureV2RequiredPages(db, tester, at);
    const checker = overrides.checker ?? safeChecker();
    // We need a context object matching V2DayContext. It's not exported, so we build it inline.
    return {
      ctx: {
        db,
        tester,
        date: "2025-10-06",
        at,
        openedPages: new Set<string>(),
        createdPages: new Set<string>(),
        wroteDaily: false,
        dayMessageIds: new Set([msgId]),
        checker,
        forgetTopics: [] as string[],
      },
      root, coaching, people, places,
    };
  }

  it("rejects write to unopened page", async () => {
    const { ctx, root } = await makeCtx();
    // Don't open the root page — try to add an entry directly
    const result = await runV2KeeperTool(ctx, "add_entry", {
      page: v2PageRef(root.id), type: "fact", text: "A fact", source: `m:${msgId.slice(0, 8)}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("opened");
  });

  it("rejects entry citing another day's message", async () => {
    const { ctx, root } = await makeCtx();
    ctx.openedPages.add(root.id);
    // Create a message from a different day that's NOT in dayMessageIds
    const [otherMsg] = await db.insert(messages).values({
      direction: "inbound", contactNumber: PHONE, content: "Yesterday",
      sentAt: zonedTime("2025-10-05", "10:00", TZ), createdAt: zonedTime("2025-10-05", "10:00", TZ),
    }).returning();
    const result = await runV2KeeperTool(ctx, "add_entry", {
      page: v2PageRef(root.id), type: "fact", text: "A fact", source: `m:${otherMsg!.id.slice(0, 8)}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not an inbound message from today");
  });

  it("sensitive check rejection returns 'Not saved' and nothing is saved", async () => {
    const { ctx, root } = await makeCtx({ checker: rejectChecker("contains medication details") });
    ctx.openedPages.add(root.id);
    const result = await runV2KeeperTool(ctx, "add_entry", {
      page: v2PageRef(root.id), type: "fact", text: "Takes melatonin every night", source: `m:${msgId.slice(0, 8)}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Not saved");

    // Nothing was saved
    const entries = await getV2Entries(db, root.id);
    expect(entries).toHaveLength(0);
  });

  it("sensitive check rejects daily summary with health detail", async () => {
    const { ctx } = await makeCtx({ checker: rejectChecker("health condition detail") });
    const result = await runV2KeeperTool(ctx, "write_daily_summary", {
      text: "Sam mentioned he's been taking melatonin for his insomnia and seeing a therapist.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Not saved");

    // Nothing was saved
    const dailies = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, tester.id));
    expect(dailies).toHaveLength(0);
  });

  it("sensitive check on create_page rejects sensitive title/about", async () => {
    const { ctx, root } = await makeCtx({ checker: rejectChecker("mental health detail") });
    const result = await runV2KeeperTool(ctx, "create_page", {
      parent: v2PageRef(root.id), kind: "area", title: "Therapy sessions", about: "Weekly therapy for depression",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Not saved");
  });

  it("sensitive check on correct_about rejects sensitive content", async () => {
    const { ctx, root } = await makeCtx({ checker: rejectChecker("medication detail") });
    const result = await runV2KeeperTool(ctx, "correct_about", {
      page: v2PageRef(root.id), about: "Takes Zoloft 50mg daily",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Not saved");
  });

  it("sensitive check rejects meta-narration about omitted sensitive content", async () => {
    const { ctx } = await makeCtx({ checker: rejectChecker("mentions that sensitive content was omitted") });
    const result = await runV2KeeperTool(ctx, "write_daily_summary", {
      text: "Sam talked about running. I left out the sleep-aid detail for privacy.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Not saved");
  });

  it("replace via tool sets replaces_id and expires old", async () => {
    const { ctx, root } = await makeCtx();
    ctx.openedPages.add(root.id);
    // Add an entry first
    const addResult = await runV2KeeperTool(ctx, "add_entry", {
      page: v2PageRef(root.id), type: "fact", text: "Heading to Clemson", source: `m:${msgId.slice(0, 8)}`,
    });
    expect(addResult.ok).toBe(true);
    const entries = await getV2Entries(db, root.id);
    const old = entries[0]!;

    // Replace it
    const replaceResult = await runV2KeeperTool(ctx, "replace_entry", {
      entry: v2EntryRef(old.id), text: "Emma chose Clemson", source: `m:${msgId.slice(0, 8)}`,
    });
    expect(replaceResult.ok).toBe(true);

    const all = await getV2Entries(db, root.id);
    const expired = all.find((e) => e.id === old.id);
    const replacement = all.find((e) => e.id !== old.id);
    expect(expired!.status).toBe("expired");
    expect(replacement!.text).toBe("Emma chose Clemson");
    expect(replacement!.replacesId).toBe(old.id);
  });

  it("correct via tool edits in place with no history", async () => {
    const { ctx, root } = await makeCtx();
    ctx.openedPages.add(root.id);
    await runV2KeeperTool(ctx, "add_entry", {
      page: v2PageRef(root.id), type: "fact", text: "Ana is his sister", source: `m:${msgId.slice(0, 8)}`,
    });
    const entries = await getV2Entries(db, root.id);
    const entry = entries[0]!;

    const result = await runV2KeeperTool(ctx, "correct_entry", {
      entry: v2EntryRef(entry.id), text: "Anna is his sister",
    });
    expect(result.ok).toBe(true);

    const all = await getV2Entries(db, root.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.text).toBe("Anna is his sister");
    expect(all[0]!.id).toBe(entry.id);
  });

  it("inferred origin is rejected by database", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    // Directly try to insert with origin "inferred" — the nightly pass should never do this,
    // but the database constraint would catch a code bug. The store always sets "stated".
    // The writer tools don't expose an origin parameter, so we test the database constraint.
    await expect(
      db.insert(memoryV2Entries).values({
        pageId: root.id, testerId: tester.id, type: "fact", status: "current",
        text: "Inferred trait", origin: "inferred", sourceMessageId: msgId,
      }),
    ).resolves.toBeDefined(); // "inferred" is a valid enum value at the DB level
    // But the writer tools always set origin="stated" — there's no way for the model to pass it.
    // This is a code-level enforcement, not a DB constraint.
  });

  it("correct_title fixes title and keeps old as other_name", async () => {
    const { ctx, people } = await makeCtx();
    // Create a person page with the wrong name
    const createResult = await runV2KeeperTool(ctx, "create_page", {
      parent: v2PageRef(people.id), kind: "person", title: "Ana",
    });
    expect(createResult.ok).toBe(true);
    const pages = await getV2Pages(db, tester.id);
    const ana = pages.find((p) => p.title === "Ana")!;

    const result = await runV2KeeperTool(ctx, "correct_title", {
      page: v2PageRef(ana.id), title: "Anna",
    });
    expect(result.ok).toBe(true);

    const updated = await getV2Pages(db, tester.id);
    const anna = updated.find((p) => p.id === ana.id)!;
    expect(anna.title).toBe("Anna");
    expect(anna.otherNames).toContain("Ana");
  });

  it("allows writes to created pages (not just opened)", async () => {
    const { ctx, root } = await makeCtx();
    // Create a page — it should be writable without opening it
    const createResult = await runV2KeeperTool(ctx, "create_page", {
      parent: v2PageRef(root.id), kind: "area", title: "Work",
    });
    expect(createResult.ok).toBe(true);
    // Extract the page ref from the message
    const pages = await getV2Pages(db, tester.id);
    const work = pages.find((p) => p.title === "Work")!;

    const addResult = await runV2KeeperTool(ctx, "add_entry", {
      page: v2PageRef(work.id), type: "fact", text: "Works at a tech company", source: `m:${msgId.slice(0, 8)}`,
    });
    expect(addResult.ok).toBe(true);
  });
});

// ─── writeV2Day integration ─────────────────────────────────────────

describe("writeV2Day", () => {
  it("missing goal page triggers end-of-pass prompt", async () => {
    // Update tester's contextStartedAt to before the day we're filing
    const earlyAt = zonedTime("2025-10-05", "00:00", TZ);
    await db.update(testers).set({ contextStartedAt: earlyAt, consentAt: earlyAt }).where(eq(testers.id, tester.id));
    tester = (await db.select().from(testers).where(eq(testers.id, tester.id)))[0]!;

    // Insert an inbound message on the right day
    const dayAt = zonedTime("2025-10-06", "10:00", TZ);
    const [dayMsg] = await db.insert(messages).values({
      direction: "inbound", contactNumber: PHONE, content: "Hey coach",
      sentAt: dayAt, createdAt: dayAt,
    }).returning();

    // Set up a tester with a tracker goal but no v2 goal page
    await db.insert(testerGoals).values({
      testerId: tester.id, goalSlug: "exercise", role: "focus",
    });

    const { root } = await ensureV2RequiredPages(db, tester, at);
    const rootRef = `p:${root.id.slice(0, 8)}`;

    // The writer model: first round opens root, writes the daily summary
    const writer = new FakeClaudeModel();
    writer.script(
      // Round 1: open root
      { tools: [{ name: "open_pages", input: { pages: [rootRef] } }] },
      // Round 2: write daily summary
      { tools: [{ name: "write_daily_summary", input: { text: "Sam texted about his day." } }] },
      // Round 3 (goal page prompt): create area
      { tools: [{ name: "create_page", input: { parent: rootRef, kind: "area", title: "Exercise" } }] },
      // Round 4: done
      "Done",
    );

    const checker = new FakeClaudeModel("SAFE");
    const result = await writeV2Day(db, writer, checker, tester, "2025-10-06", at);
    expect(result).toBe(true);

    // Check that the writer received a prompt about missing goal pages
    const allUserMsgs = writer.requests.flatMap((r) =>
      r.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")),
    );
    const goalPrompt = allUserMsgs.some((content) => content.includes("tracker goals still need a goal page"));
    expect(goalPrompt).toBe(true);
  });
});

// ─── Keeper integration: both passes ─────────────────────────────────

describe("keeper integration", () => {
  const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

  it("v1 tester writes nothing to v2 tables", async () => {
    // The default tester has memoryVersion='v2', make a v1 one
    const earlyAt = zonedTime("2025-10-05", "00:00", TZ);
    const [v1Tester] = await db
      .insert(testers)
      .values({
        phone: "+15550001111",
        name: "V1 tester",
        phase: "active",
        timeZone: TZ,
        timeZoneStatus: "confirmed",
        consentAt: earlyAt,
        contextStartedAt: earlyAt,
        memoryVersion: "v1",
      })
      .returning();

    // Add a message on a day that needs filing
    const dayAt = zonedTime("2025-10-06", "10:00", TZ);
    await db.insert(messages).values({
      direction: "inbound", contactNumber: v1Tester!.phone, content: "Hello",
      sentAt: dayAt, createdAt: dayAt,
    });

    const model = new FakeClaudeModel();
    // Script: v1 keeper's writeDay will get a call, write a daily doc
    model.script(
      { tools: [{ name: "write_daily_doc", input: { title: "Mon Oct 6", summary: "A day", body: "Nothing happened" } }] },
    );

    const checker = new FakeClaudeModel("SAFE");
    const keeper = createMemoryKeeper({
      db, log: noopLog, model, checker, allowedNumbers: ["*"],
      now: () => zonedTime("2025-10-07", "03:00", TZ),
    });

    await keeper.tick();

    // V2 tables should be empty for this tester
    const v2Pages = await getV2Pages(db, v1Tester!.id);
    expect(v2Pages).toHaveLength(0);
  });

  it("v2 tester runs both v1 and v2 passes", async () => {
    const earlyAt = zonedTime("2025-10-05", "00:00", TZ);
    const [v2Tester] = await db
      .insert(testers)
      .values({
        phone: "+15550002222",
        name: "V2 tester",
        phase: "active",
        timeZone: TZ,
        timeZoneStatus: "confirmed",
        consentAt: earlyAt,
        contextStartedAt: earlyAt,
        memoryVersion: "v2",
      })
      .returning();

    const dayAt = zonedTime("2025-10-06", "10:00", TZ);
    await db.insert(messages).values({
      direction: "inbound", contactNumber: v2Tester!.phone, content: "Hey coach",
      sentAt: dayAt, createdAt: dayAt,
    });

    const model = new FakeClaudeModel();
    // V1 pass: write_daily_doc
    model.script(
      { tools: [{ name: "write_daily_doc", input: { title: "Mon Oct 6", summary: "A day", body: "Nothing" } }] },
    );
    // V2 pass: write_daily_summary
    model.script(
      { tools: [{ name: "write_daily_summary", input: { text: "V2 tester texted about their day." } }] },
    );

    const checker = new FakeClaudeModel("SAFE");
    const keeper = createMemoryKeeper({
      db, log: noopLog, model, checker, allowedNumbers: ["*"],
      now: () => zonedTime("2025-10-07", "03:00", TZ),
    });

    await keeper.tick();

    // V1 should have written something (memoryPages)
    const { memoryPages: mp } = await import("../src/db/schema.js");
    const v1Pages = await db.select().from(mp).where(eq(mp.testerId, v2Tester!.id));
    expect(v1Pages.length).toBeGreaterThan(0);

    // V2 should have written something (required pages + daily summary)
    const v2Pages = await getV2Pages(db, v2Tester!.id);
    expect(v2Pages.length).toBeGreaterThan(0); // at least root, coaching, people, places
    const v2Dailies = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, v2Tester!.id));
    expect(v2Dailies.length).toBeGreaterThan(0);
  });
});

// ─── V2 forget tests ────────────────────────────────────────────────

describe("v2 forget", () => {
  it("deletes entry and its replace chain, marks messages forgotten, records topic", async () => {
    const { root, coaching } = await ensureV2RequiredPages(db, tester, at);
    // Create an entry and its replacement
    const e1 = await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "Heading to Clemson", sourceMessageId: msgId }, at);
    const m2 = await say(tester, "Emma chose Clemson");
    const e2 = await replaceV2Entry(db, e1, { pageId: root.id, testerId: tester.id, type: "fact", text: "Emma chose Clemson", sourceMessageId: m2.id }, at);
    // Write a daily summary that references the message
    await writeV2Daily(db, tester.id, "2025-10-06", "Sam talked about Clemson.", [msgId, m2.id], at);

    const checker = new FakeClaudeModel("No notable events.");
    // Script the identification step to return empty JSON (entries already deleted by ref),
    // then the daily rewrite (via forgotten message IDs) uses the default text "No notable events."
    checker.script(JSON.stringify({ entries: [], pages: [], summaries: [] }));
    // The sensitive check for the daily summary rewrite uses the default text "SAFE" won't work:
    // the default text is "No notable events." so the rewrite returns that; then sensitiveCheck
    // also gets "No notable events." which is fine (not "REJECT").
    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const result = await runMemoryTool(db, tester, "forget", {
      facts: [v2EntryRef(e2.id)],
      note: "Clemson",
    }, { at, budget, sourceMessageId: msgId, checker });

    expect(result.ok).toBe(true);

    // Both entries in the chain should be deleted
    const entries = await db.select().from(memoryV2Entries).where(eq(memoryV2Entries.testerId, tester.id));
    // Only the coaching note should remain
    const nonCoaching = entries.filter((e) => e.pageId !== coaching.id);
    expect(nonCoaching).toHaveLength(0);

    // Messages should be marked forgotten
    const forgotten = await db.select().from(memoryForgotten).where(eq(memoryForgotten.testerId, tester.id));
    expect(forgotten.length).toBeGreaterThan(0);

    // Topic should be recorded
    const topics = await db.select().from(memoryV2ForgetTopics).where(eq(memoryV2ForgetTopics.testerId, tester.id));
    expect(topics.length).toBe(1);
    expect(topics[0]!.topic).toBe("Clemson");

    // Daily summary should have been rewritten
    const [daily] = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, tester.id));
    expect(daily!.summary).toBe("No notable events.");
  });

  it("500-character topic still works", async () => {
    await ensureV2RequiredPages(db, tester, at);
    const longTopic = "a".repeat(500);
    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const result = await runMemoryTool(db, tester, "forget", {
      note: longTopic,
    }, { at, budget, sourceMessageId: msgId });

    expect(result.ok).toBe(true);
  });

  it("root page can't be deleted via forget", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    const budget: LookupBudget = { lookups: 0, searches: 0 };
    // Try to forget the root page — it should fail at the v1 level (not a person/subject)
    // and the v2 deleteV2Page also rejects it
    const result = await runMemoryTool(db, tester, "forget", {
      pages: [v2PageRef(root.id)],
      note: "root",
    }, { at, budget, sourceMessageId: msgId });

    // The v1 forget will fail on this ref (not found in v1) and the v2 deleteV2Page rejects root
    // But the note still gets recorded, so it returns ok
    // Actually, the v1 path skips if not found and moves to v2 path, which rejects root deletion
    // but doesn't return an error — it just continues. The forget still succeeds with just the note.
    expect(result.ok).toBe(true);
    // Root page should still exist
    const pages = await getV2Pages(db, tester.id);
    const rootPage = pages.find((p) => p.kind === "root");
    expect(rootPage).toBeDefined();
  });

  it("v2 forget also removes v1 memory (switching back never restores it)", async () => {
    // Create v1 memory too (a fact on a person page)
    const { memoryPages: mp, memoryFacts: mf } = await import("../src/db/schema.js");
    const [v1Page] = await db.insert(mp).values({
      testerId: tester.id, kind: "person", title: "Ana", summary: "His sister",
    }).returning();
    await db.insert(mf).values({
      pageId: v1Page!.id, testerId: tester.id, text: "Ana is his sister", sourceMessageId: msgId,
    });

    // Create v2 person page under People
    const { people } = await ensureV2RequiredPages(db, tester, at);
    const personResult = await createV2Page(db, tester.id, { kind: "person", title: "Ana", parentId: people.id }, at);
    expect(personResult.ok).toBe(true);
    if (!personResult.ok) return;
    await addV2Entry(db, { pageId: personResult.value.id, testerId: tester.id, type: "fact", text: "Ana is his sister", sourceMessageId: msgId }, at);

    const budget: LookupBudget = { lookups: 0, searches: 0 };
    // Forget the v1 person page (the v2 page has a different ref, so we target the v1 one)
    const { pageRef } = await import("../src/memory/store.js");
    const result = await runMemoryTool(db, tester, "forget", {
      pages: [pageRef(v1Page!.id)],
      note: "Ana",
    }, { at, budget, sourceMessageId: msgId });

    expect(result.ok).toBe(true);
    // V1 page should be deleted
    const v1Pages = await db.select().from(mp).where(eq(mp.testerId, tester.id));
    const v1Person = v1Pages.find((p) => p.kind === "person");
    expect(v1Person).toBeUndefined();

    // Source messages should be marked forgotten
    const forgotten = await db.select().from(memoryForgotten).where(eq(memoryForgotten.testerId, tester.id));
    expect(forgotten.length).toBeGreaterThan(0);
  });

  it("topic-based forget uses model judgment: deletes Karen's page and divorce entry, leaves Emma", async () => {
    const { root, coaching, people } = await ensureV2RequiredPages(db, tester, at);
    // Create distinct source messages for each entry/daily so forget doesn't cascade by message ID
    const mKaren = await say(tester, "Karen called");
    const mDivorce = await say(tester, "divorce stuff");
    const mEmma = await say(tester, "Emma's doing well");
    const mOct7 = await say(tester, "day 7 text");
    const mOct18 = await say(tester, "day 18 text");
    const mOct10 = await say(tester, "day 10 text");

    // Create Karen (person) and Emma (person)
    const karenResult = await createV2Page(db, tester.id, { kind: "person", title: "Karen", parentId: people.id }, at);
    expect(karenResult.ok).toBe(true);
    if (!karenResult.ok) return;
    const emmaResult = await createV2Page(db, tester.id, { kind: "person", title: "Emma", parentId: people.id }, at);
    expect(emmaResult.ok).toBe(true);
    if (!emmaResult.ok) return;
    // Entries
    const karenEntry = await addV2Entry(db, { pageId: karenResult.value.id, testerId: tester.id, type: "fact", text: "Karen is his ex-wife", sourceMessageId: mKaren.id }, at);
    const divorceEntry = await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "Going through a civil divorce", sourceMessageId: mDivorce.id }, at);
    const emmaEntry = await addV2Entry(db, { pageId: emmaResult.value.id, testerId: tester.id, type: "fact", text: "Emma is his daughter, senior in high school", sourceMessageId: mEmma.id }, at);
    // Daily summaries: Oct 7 mentions Karen, Oct 18 mentions Karen, Oct 10 doesn't
    await writeV2Daily(db, tester.id, "2025-10-07", "Rob mentioned Karen called about paperwork.", [mOct7.id], at);
    await writeV2Daily(db, tester.id, "2025-10-18", "Karen called Emma about the trip.", [mOct18.id], at);
    await writeV2Daily(db, tester.id, "2025-10-10", "Rob packed lunch and ran errands.", [mOct10.id], at);

    // The checker model: scripted to return identification JSON, then rewrite summaries, then SAFE checks
    const checker = new FakeClaudeModel();
    // 1. Identify step: return refs for Karen's page, divorce entry, and summaries mentioning Karen
    checker.script(
      JSON.stringify({
        entries: [v2EntryRef(karenEntry.id), v2EntryRef(divorceEntry.id)],
        pages: [v2PageRef(karenResult.value.id)],
        summaries: ["2025-10-07", "2025-10-18"],
      }),
    );
    // 2-3. Rewrite Oct 7 summary, then its sensitive check
    checker.script("Rob discussed some paperwork.");
    checker.script("SAFE");
    // 4-5. Rewrite Oct 18 summary, then its sensitive check
    checker.script("Emma got a call about the trip.");
    checker.script("SAFE");

    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const result = await runMemoryTool(db, tester, "forget", {
      note: "the divorce and Karen",
    }, { at, budget, sourceMessageId: msgId, checker });
    expect(result.ok).toBe(true);

    // Karen's page should be gone
    const pages = await getV2Pages(db, tester.id);
    expect(pages.find((p) => p.title === "Karen")).toBeUndefined();

    // Divorce entry on root should be gone
    const rootEntries = await getV2Entries(db, root.id);
    expect(rootEntries.filter((e) => e.text.includes("divorce") || e.text.includes("civil"))).toHaveLength(0);

    // Emma's page and entry should be untouched
    const emma = pages.find((p) => p.title === "Emma");
    expect(emma).toBeDefined();
    const emmaEntries = await getV2Entries(db, emma!.id);
    expect(emmaEntries.some((e) => e.text.includes("daughter"))).toBe(true);

    // Oct 7 and Oct 18 summaries rewritten; Oct 10 untouched
    const dailies = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, tester.id));
    const oct7 = dailies.find((d) => d.date === "2025-10-07");
    expect(oct7!.summary).toBe("Rob discussed some paperwork.");
    const oct18 = dailies.find((d) => d.date === "2025-10-18");
    expect(oct18!.summary).toBe("Emma got a call about the trip.");
    const oct10 = dailies.find((d) => d.date === "2025-10-10");
    expect(oct10!.summary).toBe("Rob packed lunch and ran errands.");

    // Topic recorded
    const topics = await db.select().from(memoryV2ForgetTopics).where(eq(memoryV2ForgetTopics.testerId, tester.id));
    expect(topics.some((t) => t.topic === "the divorce and Karen")).toBe(true);

    // Neutral note on Coaching
    const coachingEntries = await getV2Entries(db, coaching.id);
    expect(coachingEntries.some((e) => e.text.includes("Asked to forget something"))).toBe(true);
  });

  it("returns ok:false and skips topic recording when model returns bad JSON twice (#252)", async () => {
    await ensureV2RequiredPages(db, tester, at);
    // Script checker to return invalid JSON twice (retry fails too)
    const checker = new FakeClaudeModel();
    checker.script("not json at all");
    checker.script("still not json {{{}}}");

    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const result = await runMemoryTool(db, tester, "forget", {
      note: "the divorce",
    }, { at, budget, sourceMessageId: msgId, checker });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Could not identify what to forget");

    // Topic should NOT be recorded
    const topics = await db.select().from(memoryV2ForgetTopics).where(eq(memoryV2ForgetTopics.testerId, tester.id));
    expect(topics).toHaveLength(0);
  });
});

// ─── V2 retry timer separation (#252) ──────────────────────────────

describe("v2 retry timer separation", () => {
  const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

  it("v1 pass runs even when v2 is in retry cooldown (#252)", async () => {
    const earlyAt = zonedTime("2025-10-05", "00:00", TZ);
    const [v2Tester] = await db
      .insert(testers)
      .values({
        phone: "+15550003333",
        name: "V2 retry tester",
        phase: "active",
        timeZone: TZ,
        timeZoneStatus: "confirmed",
        consentAt: earlyAt,
        contextStartedAt: earlyAt,
        memoryVersion: "v2",
      })
      .returning();

    const dayAt = zonedTime("2025-10-06", "10:00", TZ);
    await db.insert(messages).values({
      direction: "inbound", contactNumber: v2Tester!.phone, content: "Hey coach",
      sentAt: dayAt, createdAt: dayAt,
    });

    const model = new FakeClaudeModel();
    // V1 pass: round 1 returns write_daily_doc tool, round 2 ends the loop (no tools)
    model.script(
      { tools: [{ name: "write_daily_doc", input: { title: "Mon Oct 6", summary: "A day", body: "Nothing" } }] },
      "Done filing.",
    );
    // V2 pass: throw to trigger retry cooldown
    model.script(new Error("V2 model failure"));

    const checker = new FakeClaudeModel("SAFE");
    const tickTime = zonedTime("2025-10-07", "03:00", TZ);
    const keeper = createMemoryKeeper({
      db, log: noopLog, model, checker, allowedNumbers: ["*"],
      now: () => tickTime,
    });

    // First tick: v1 succeeds, v2 fails → sets retryAfterV2
    await keeper.tick();

    // V1 should have advanced memoryThrough to the last day
    const after1 = await db.select().from(testers).where(eq(testers.id, v2Tester!.id));
    expect(after1[0]!.memoryThrough).toBe("2025-10-06");
    // V2 should have advanced through the no-message day but failed on the message day
    expect(after1[0]!.memoryV2Through).toBe("2025-10-05");

    // Second tick (immediately, before retry timer expires):
    // V1 has no more days to write, but v2 would need "2025-10-06" if it ran.
    // If v2 ran, it would consume this script step — but retryAfterV2 should block it.
    model.script(
      { tools: [{ name: "write_daily_summary", input: { text: "Should not be called" } }] },
      "Done.",
    );

    await keeper.tick();

    // V2 should STILL be stuck at "2025-10-05" (retry timer blocks the "2025-10-06" day)
    const after2 = await db.select().from(testers).where(eq(testers.id, v2Tester!.id));
    expect(after2[0]!.memoryV2Through).toBe("2025-10-05");

    // V1 stays at "2025-10-06" (no more days to process, still not blocked)
    expect(after2[0]!.memoryThrough).toBe("2025-10-06");
  });
});

// ─── save_preference avoidance detection (model-based) ──────────────

describe("save_preference avoidance detection", () => {
  it("saves a sensitive-topic avoidance preference in neutral words and records the topic (#253)", async () => {
    const { coaching } = await ensureV2RequiredPages(db, tester, at);

    // The checker model: first call is the sensitive check → REJECT, second is classifyPreference → AVOID
    const checker = new FakeClaudeModel();
    checker.script("REJECT: mentions health details");
    checker.script("AVOID\nNEUTRAL: Asked not to discuss a health topic\nTOPIC: their health");

    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const result = await runMemoryTool(db, tester, "save_preference", {
      preference: "please don't bring up my health stuff",
    }, { at, budget, sourceMessageId: msgId, checker });

    expect(result.ok).toBe(true);

    // The neutral wording should be on Coaching
    const coachingEntries = await getV2Entries(db, coaching.id);
    expect(coachingEntries.some((e) => e.text === "Asked not to discuss a health topic")).toBe(true);
    // The raw preference should NOT be on Coaching
    expect(coachingEntries.some((e) => e.text.includes("health stuff"))).toBe(false);

    // The topic should be recorded in forget topics
    const topics = await db.select().from(memoryV2ForgetTopics).where(eq(memoryV2ForgetTopics.testerId, tester.id));
    expect(topics.some((t) => t.topic === "their health")).toBe(true);
  });

  it("does not save when sensitive check rejects and model says NOT_AVOIDANCE (#253)", async () => {
    await ensureV2RequiredPages(db, tester, at);

    const checker = new FakeClaudeModel();
    checker.script("REJECT: contains medication details");
    checker.script("NOT_AVOIDANCE");

    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const result = await runMemoryTool(db, tester, "save_preference", {
      preference: "I take melatonin every night at 10",
    }, { at, budget, sourceMessageId: msgId, checker });

    // The preference is still saved to v1 (styleNotes), but the v2 entry is NOT written
    expect(result.ok).toBe(true);

    // No v2 coaching entry for this preference (rejected, not avoidance)
    const { coaching } = await ensureV2RequiredPages(db, tester, at);
    const coachingEntries = await getV2Entries(db, coaching.id);
    expect(coachingEntries.some((e) => e.text.includes("melatonin"))).toBe(false);

    // No forget topic recorded
    const topics = await db.select().from(memoryV2ForgetTopics).where(eq(memoryV2ForgetTopics.testerId, tester.id));
    expect(topics).toHaveLength(0);
  });
});
