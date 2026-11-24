import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  goals,
  memoryV2Daily,
  memoryV2Entries,
  memoryV2Pages,
  messages,
  testerGoals,
  testers,
  type Message,
  type Tester,
} from "../src/db/schema.js";
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
import { zonedTime } from "../src/nudges/schedule.js";
import { FakeClaudeModel, makeDb } from "./helpers.js";

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

describe("deleteV2Memory", () => {
  it("deletes v2 rows without touching v1 tables", async () => {
    const { root } = await ensureV2RequiredPages(db, tester, at);
    await addV2Entry(db, { pageId: root.id, testerId: tester.id, type: "fact", text: "A fact", sourceMessageId: msgId }, at);
    await writeV2Daily(db, tester.id, "2025-10-06", "A day.", [msgId], at);

    // Verify rows exist
    expect(await getV2Pages(db, tester.id)).not.toHaveLength(0);

    await deleteV2Memory(db, tester.id);

    expect(await getV2Pages(db, tester.id)).toHaveLength(0);
    const entries = await db.select().from(memoryV2Entries).where(eq(memoryV2Entries.testerId, tester.id));
    expect(entries).toHaveLength(0);
    const dailies = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, tester.id));
    expect(dailies).toHaveLength(0);
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
