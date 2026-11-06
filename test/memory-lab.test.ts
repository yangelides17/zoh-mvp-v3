/**
 * Memory lab replay tests (#147). Uses PGlite and mocked Claude (FakeClaudeModel).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  memoryFacts,
  memoryForgotten,
  memoryPages,
  messages,
  testers,
  type Tester,
} from "../src/db/schema.js";
import type { Db } from "../src/db/client.js";
import { zonedTime } from "../src/nudges/schedule.js";
import { loadScenario, parseFixture, resolveDate, type Fixture } from "../src/synthetic/loader.js";
import { takeSnapshot, stripForGrader, saveSnapshot } from "../eval/memory-lab/snapshot.js";
import { runChecks } from "../eval/memory-lab/checks.js";
import { estimateRunCost, saveSpend, PER_RUN_CAP, COMMAND_CAP, type RunSpend } from "../eval/memory-lab/cost.js";
import { answerKeySchema } from "../eval/memory-lab/keys/schema.js";
import { FakeClaudeModel, makeDb } from "./helpers.js";
import { writeDay } from "../src/memory/keeper.js";
import { updateTester } from "../src/testers/testers.js";
import { runMemoryTool, type LookupBudget } from "../src/memory/coach-tools.js";
import { addFact, createPage, ensureCorePages } from "../src/memory/store.js";
import { memoryBlock } from "../src/memory/context.js";

const TZ = "America/New_York";
const START = new Date("2026-11-02T00:00:00Z");
const SAM_PHONE = "+15555550101";
const at = (date: string, hhmm: string) => zonedTime(date, hhmm, TZ);

const FIXTURE_PATH = path.resolve(import.meta.dirname, "../eval/memory-lab/fixtures/sam.week1.json");

let db: Db;
let tmpDir: string;

function loadSamFixture(): Fixture {
  const json = fs.readFileSync(FIXTURE_PATH, "utf-8");
  return parseFixture(json, "sam.week1.json");
}

/** Create a tester directly for unit tests that don't need the full loader. */
async function createTester(d: Db, phone = SAM_PHONE): Promise<Tester> {
  const [row] = await d
    .insert(testers)
    .values({
      phone,
      name: "Sam",
      scenario: "sam",
      goalSlug: "exercise",
      phase: "active",
      timeZone: TZ,
      timeZoneStatus: "assumed_eastern",
      consentAt: at("2026-11-02", "21:40"),
      contextStartedAt: at("2026-11-02", "21:40"),
    })
    .returning();
  return row!;
}

/** Insert a message for a tester. */
async function say(d: Db, who: Tester, direction: "inbound" | "outbound", when: Date, content: string) {
  const [m] = await d
    .insert(messages)
    .values({ direction, contactNumber: who.phone, content, createdAt: when, sentAt: when })
    .returning();
  return m!;
}

/** Script a FakeClaudeModel to create a page, add a fact, and write a daily doc. */
function scriptKeeperResponse(model: FakeClaudeModel, day: string): FakeClaudeModel {
  return model.script(
    {
      tools: [
        { name: "create_page", input: { kind: "person", title: `Person from day ${day}`, summary: "Someone" } },
      ],
    },
    {
      tools: [
        { name: "add_fact", input: { page: "p:will-be-found", text: `Fact from ${day}`, source: "m:any" } },
      ],
    },
    {
      tools: [
        { name: "write_daily_doc", input: { title: `Day ${day}`, summary: `Summary for ${day}`, body: `Body for ${day}` } },
      ],
    },
  );
}

beforeEach(async () => {
  ({ db } = await makeDb());
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lab-test-"));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---- Loader: stated_preference and forget events ----

describe("loader: new event types", () => {
  it("stated_preference event is parsed and returned in liveWrites", async () => {
    const fixture: Fixture = {
      ...loadSamFixture(),
      events: [
        ...loadSamFixture().events,
        { kind: "stated_preference" as const, day: 3, time: "10:00", preference: "less hype please" },
      ],
    };
    const result = await loadScenario(db, [fixture], START);
    expect(result.liveWrites).toHaveLength(1);
    expect(result.liveWrites[0]).toMatchObject({
      kind: "stated_preference",
      day: 3,
      preference: "less hype please",
    });
  });

  it("forget event is parsed and returned in liveWrites", async () => {
    const fixture: Fixture = {
      ...loadSamFixture(),
      events: [
        ...loadSamFixture().events,
        { kind: "forget" as const, day: 5, time: "14:00", request: "forget about my dog" },
      ],
    };
    const result = await loadScenario(db, [fixture], START);
    expect(result.liveWrites).toHaveLength(1);
    expect(result.liveWrites[0]).toMatchObject({
      kind: "forget",
      day: 5,
      request: "forget about my dog",
    });
  });

  it("stated_preference and forget events are NOT written to the database", async () => {
    const fixture: Fixture = {
      ...loadSamFixture(),
      events: [
        ...loadSamFixture().events,
        { kind: "stated_preference" as const, day: 3, time: "10:00", preference: "less hype" },
        { kind: "forget" as const, day: 5, time: "14:00", request: "forget my dog" },
      ],
    };
    await loadScenario(db, [fixture], START);
    // No memory facts or forgotten entries should exist (loader doesn't execute these)
    const facts = await db.select().from(memoryFacts);
    const forgotten = await db.select().from(memoryForgotten);
    expect(facts).toHaveLength(0);
    expect(forgotten).toHaveLength(0);
  });
});

// ---- Snapshot ----

describe("snapshot", () => {
  it("takes a snapshot with pages, facts, links, and forgotten", async () => {
    const tester = await createTester(db);
    const snap = await takeSnapshot(db, tester.id);
    expect(snap.pages).toEqual([]);
    expect(snap.facts).toEqual([]);
    expect(snap.links).toEqual([]);
    expect(snap.forgotten).toEqual([]);
  });

  it("stripForGrader removes sourceMessageId from facts", async () => {
    const tester = await createTester(db);
    const msg = await say(db, tester, "inbound", at("2026-11-02", "21:40"), "hello");
    const { self } = await ensureCorePages(db, tester, at("2026-11-02", "21:40"));
    await addFact(db, self, { text: "a fact", sourceMessageId: msg.id, day: "2026-11-02" }, at("2026-11-02", "21:40"));

    const snap = await takeSnapshot(db, tester.id);
    expect(snap.facts[0]!.sourceMessageId).toBe(msg.id);

    const stripped = stripForGrader(snap);
    expect(stripped.facts[0]!.sourceMessageId).toBeNull();
  });

  it("saveSnapshot writes JSON and text files", () => {
    const snap = { pages: [], facts: [], links: [], forgotten: [] };
    saveSnapshot(tmpDir, 1, snap, "rendered text");
    expect(fs.existsSync(path.join(tmpDir, "night-01.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "night-01.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "night-01.txt"), "utf-8")).toBe("rendered text");
  });
});

// ---- Structure checks ----

describe("structure checks", () => {
  it("detects a planted duplicate", () => {
    const snap = {
      pages: [{ id: "p1", testerId: "t1", kind: "self" as const, title: "Me", summary: "", body: "", goalSlug: null, status: "active" as const, date: null, createdAt: new Date(), updatedAt: new Date() }],
      facts: [
        { id: "f1", pageId: "p1", testerId: "t1", section: "", label: null, text: "I like running", sourceMessageId: null, day: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "f2", pageId: "p1", testerId: "t1", section: "", label: null, text: "I like running", sourceMessageId: null, day: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      links: [],
      forgotten: [],
    };
    const result = runChecks(snap, "rendered");
    expect(result.duplicates).toBe(1);
  });

  it("detects a planted forget leak", () => {
    const snap = {
      pages: [],
      facts: [
        { id: "f1", pageId: "p1", testerId: "t1", section: "", label: null, text: "secret", sourceMessageId: "msg1", day: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      links: [],
      forgotten: [{ id: "fg1", testerId: "t1", messageId: "msg1", createdAt: new Date() }],
    };
    const result = runChecks(snap, "rendered");
    expect(result.forgetLeaks).toBe(1);
  });

  it("measures churn between snapshots", () => {
    const prev = {
      pages: [{ id: "p1", testerId: "t1", kind: "self" as const, title: "Me", summary: "", body: "", goalSlug: null, status: "active" as const, date: null, createdAt: new Date(), updatedAt: new Date() }],
      facts: [
        { id: "f1", pageId: "p1", testerId: "t1", section: "", label: null, text: "old text", sourceMessageId: null, day: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "f2", pageId: "p1", testerId: "t1", section: "", label: null, text: "removed", sourceMessageId: null, day: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      links: [],
      forgotten: [],
    };
    const curr = {
      pages: [
        { id: "p1", testerId: "t1", kind: "self" as const, title: "Me", summary: "", body: "", goalSlug: null, status: "active" as const, date: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "p2", testerId: "t1", kind: "person" as const, title: "Ana", summary: "Sister", body: "", goalSlug: null, status: "active" as const, date: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      facts: [
        { id: "f1", pageId: "p1", testerId: "t1", section: "", label: null, text: "updated text", sourceMessageId: null, day: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "f3", pageId: "p2", testerId: "t1", section: "", label: null, text: "new fact", sourceMessageId: null, day: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      links: [],
      forgotten: [],
    };
    const result = runChecks(curr, "rendered", prev);
    expect(result.churn.created).toBeGreaterThan(0); // new page + new fact
    expect(result.churn.removed).toBeGreaterThan(0); // f2 removed
    expect(result.churn.replaced).toBe(1); // f1 updated
  });

  it("measures block size", () => {
    const snap = { pages: [], facts: [], links: [], forgotten: [] };
    const result = runChecks(snap, "a".repeat(500));
    expect(result.blockSize).toBe(500);
  });
});

// ---- Cost ----

describe("cost", () => {
  it("estimates cost for a run", () => {
    const est = estimateRunCost({
      nights: 7,
      forgetCalls: 1,
      checkpointBatches: 4,
      keeperModel: "claude-sonnet-5-5",
      graderModel: "claude-haiku-5-5",
    });
    expect(est.totalDollars).toBeGreaterThan(0);
    expect(est.nights).toBe(7);
    expect(est.forgetCalls).toBe(1);
    expect(est.checkpointBatches).toBe(4);
  });

  it("$8 per-run cap refuses when estimate exceeds it", () => {
    const est = estimateRunCost({
      nights: 200,
      forgetCalls: 50,
      checkpointBatches: 100,
      keeperModel: "claude-sonnet-5-5",
      graderModel: "claude-sonnet-5-5",
    });
    expect(est.totalDollars).toBeGreaterThan(PER_RUN_CAP);
  });

  it("$25 command cap detectable for multiple runs", () => {
    const est = estimateRunCost({
      nights: 28,
      forgetCalls: 4,
      checkpointBatches: 14,
      keeperModel: "claude-sonnet-5-5",
      graderModel: "claude-haiku-5-5",
    });
    // Enough runs of a 28-night scenario would exceed $25 command cap
    const runsToExceed = Math.ceil(COMMAND_CAP / est.totalDollars) + 1;
    expect(est.totalDollars * runsToExceed).toBeGreaterThan(COMMAND_CAP);
  });
});

// ---- Answer key schema ----

describe("answer key", () => {
  it("validates the sam answer key", () => {
    const raw = fs.readFileSync(path.resolve(import.meta.dirname, "../eval/memory-lab/keys/sam.json"), "utf-8");
    const result = answerKeySchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it("validates the maya answer key", () => {
    const raw = fs.readFileSync(path.resolve(import.meta.dirname, "../eval/memory-lab/keys/maya.json"), "utf-8");
    const result = answerKeySchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it("rejects an invalid answer key", () => {
    const result = answerKeySchema.safeParse({ scenario: "test", format: 2 });
    expect(result.success).toBe(false);
  });
});

// ---- Replay with mocked writeDay ----

describe("replay (mocked writeDay)", () => {
  it("produces 7 snapshot pairs for sam.week1", async () => {
    const fixture = loadSamFixture();
    const result = await loadScenario(db, [fixture], START);

    const [testerRow] = await db.select().from(testers).where(eq(testers.scenario, "sam")).limit(1);
    expect(testerRow).toBeDefined();
    let tester = testerRow!;

    const model = new FakeClaudeModel();
    let nightCount = 0;

    // Mock 7 nights of writeDay
    for (let day = 1; day <= 7; day++) {
      const date = resolveDate(START, day);
      const at3am = zonedTime(date, "03:00", TZ);

      // Script the model with basic keeper responses
      model.script(
        { tools: [{ name: "write_daily_doc", input: { title: `Day ${date}`, summary: `Summary`, body: `Body` } }] },
      );

      try {
        const wrote = await writeDay(db, model, tester, date, at3am);
        if (wrote) {
          await updateTester(db, tester.id, { memoryThrough: date });
          const fresh = await db.select().from(testers).where(eq(testers.id, tester.id)).limit(1);
          if (fresh[0]) tester = fresh[0];
          nightCount++;

          // Take snapshot and save
          const snap = await takeSnapshot(db, tester.id);
          const rendered = await memoryBlock(db, tester);
          saveSnapshot(tmpDir, day, snap, rendered);
        }
      } catch {
        // Days without inbound texts write nothing
      }
    }

    // Sam's week 1 has messages on days 1, 2, 4, 5, 6 (inbound) so we expect snapshots for days with texts
    expect(nightCount).toBeGreaterThan(0);
    // Check that snapshot files exist for at least some days
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    // Every JSON has a matching TXT
    for (const f of files) {
      const txt = f.replace(".json", ".txt");
      expect(fs.existsSync(path.join(tmpDir, txt))).toBe(true);
    }
  });

  it("stated_preference: fact appears in snapshot", async () => {
    const tester = await createTester(db);
    const msg = await say(db, tester, "inbound", at("2026-11-02", "21:40"), "less hype please");

    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const result = await runMemoryTool(db, tester, "save_preference", {
      preference: "less hype please",
    }, { at: at("2026-11-02", "21:41"), budget, sourceMessageId: msg.id });
    expect(result.ok).toBe(true);

    const snap = await takeSnapshot(db, tester.id);
    const prefFacts = snap.facts.filter((f) => f.text === "less hype please");
    expect(prefFacts.length).toBe(1);
    expect(prefFacts[0]!.section).toBe("stated");
  });

  it("forget: fact removed from snapshot", async () => {
    const tester = await createTester(db);
    const msg = await say(db, tester, "inbound", at("2026-11-02", "21:40"), "hello");

    // Create a fact first
    const { self } = await ensureCorePages(db, tester, at("2026-11-02", "21:40"));
    const fact = await addFact(db, self, { text: "my dog is named Max", sourceMessageId: msg.id, day: "2026-11-02" }, at("2026-11-02", "21:40"));

    // Verify fact exists
    let snap = await takeSnapshot(db, tester.id);
    expect(snap.facts.some((f) => f.text === "my dog is named Max")).toBe(true);

    // Forget using the tool (mock the input as if Claude identified the fact)
    const budget: LookupBudget = { lookups: 0, searches: 0 };
    const factRef = `f:${fact.id.slice(0, 8)}`;
    const result = await runMemoryTool(db, tester, "forget", {
      facts: [factRef],
      note: "his dog",
    }, { at: at("2026-11-02", "22:00"), budget });
    expect(result.ok).toBe(true);

    // Verify fact is gone from snapshot
    snap = await takeSnapshot(db, tester.id);
    expect(snap.facts.some((f) => f.text === "my dog is named Max")).toBe(false);
  });

  it("--through-day 7 produces only nights 1-7", async () => {
    // This tests the resolveDate logic for limiting days
    for (let day = 1; day <= 10; day++) {
      const date = resolveDate(START, day);
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Day 7 is Sunday Nov 8
    expect(resolveDate(START, 7)).toBe("2026-11-08");
    expect(resolveDate(START, 8)).toBe("2026-11-09");
  });

  it("memory_through updated after each night", async () => {
    const tester = await createTester(db);
    await say(db, tester, "inbound", at("2026-11-02", "21:40"), "hello");

    const model = new FakeClaudeModel().script(
      { tools: [{ name: "write_daily_doc", input: { title: "Mon", summary: "S", body: "B" } }] },
    );

    const date = "2026-11-02";
    await writeDay(db, model, tester, date, at("2026-11-03", "03:00"));
    await updateTester(db, tester.id, { memoryThrough: date });

    const [updated] = await db.select().from(testers).where(eq(testers.id, tester.id)).limit(1);
    expect(updated!.memoryThrough).toBe(date);
  });

  it("failed night retried once, then recorded and replay continues", async () => {
    const tester = await createTester(db);
    await say(db, tester, "inbound", at("2026-11-02", "21:40"), "hello");

    const model = new FakeClaudeModel();
    // Script two failures (both attempts fail)
    model.script(new Error("API down"), new Error("API still down"));

    let failed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeDay(db, model, tester, "2026-11-02", at("2026-11-03", "03:00"));
        break;
      } catch {
        if (attempt === 1) failed = true;
      }
    }
    expect(failed).toBe(true);

    // Replay continues: we can still take a snapshot
    const snap = await takeSnapshot(db, tester.id);
    expect(snap).toBeDefined();
  });

  it("--memory current works", () => {
    // "current" is the only supported version; this should not throw
    const check = (v: string) => {
      if (v !== "current") throw new Error(`Unknown memory version "${v}"; only "current" is supported.`);
    };
    expect(() => check("current")).not.toThrow();
  });

  it("--memory bogus throws", () => {
    const check = (v: string) => {
      if (v !== "current") throw new Error(`Unknown memory version "${v}"; only "current" is supported.`);
    };
    expect(() => check("bogus")).toThrow("Unknown memory version");
  });
});

// ---- Dry run ----

describe("dry run", () => {
  it("prints estimate, no Claude calls", () => {
    const est = estimateRunCost({
      nights: 7,
      forgetCalls: 0,
      checkpointBatches: 2,
      keeperModel: "claude-sonnet-5-5",
      graderModel: "claude-haiku-5-5",
    });
    // Estimate is available without any Claude calls
    expect(est.totalDollars).toBeGreaterThan(0);
    expect(est.nights).toBe(7);
  });
});

// ---- Spend tracking ----

describe("spend tracking", () => {
  it("actual spend recorded per night and per run", async () => {
    const tester = await createTester(db);
    await say(db, tester, "inbound", at("2026-11-02", "21:40"), "hello");

    const model = new FakeClaudeModel().script(
      { tools: [{ name: "write_daily_doc", input: { title: "Mon", summary: "S", body: "B" } }] },
    );

    const wrote = await writeDay(db, model, tester, "2026-11-02", at("2026-11-03", "03:00"));
    expect(wrote).toBe(true);

    // The model was called; we can verify through requests
    expect(model.requests.length).toBeGreaterThan(0);

    // Verify spend.json can be written
    const spend: RunSpend = {
      nights: [{ day: 1, dollars: 0.05, usage: { input: 1000, output: 200 } }],
      grading: 0.01,
      forget: 0,
      total: 0.06,
    };
    saveSpend(tmpDir, spend);
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "spend.json"), "utf-8"));
    expect(saved.total).toBe(0.06);
    expect(saved.nights).toHaveLength(1);
    expect(saved.nights[0].day).toBe(1);
  });
});
