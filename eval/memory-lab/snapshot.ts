/**
 * Memory snapshot: captures the state of a tester's memory after each night (#147).
 * Used by the replay runner to record and compare memory across nights and runs.
 */

import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import {
  memoryPages,
  memoryFacts,
  memoryLinks,
  memoryForgotten,
  memoryV2Pages,
  memoryV2Entries,
  memoryV2Links,
  memoryV2Daily,
  messages,
  type MemoryPage,
  type MemoryFact,
  type MemoryLink,
  type MemoryV2Page,
  type MemoryV2Entry,
  type MemoryV2Link,
  type MemoryV2Daily,
} from "../../src/db/schema.js";

/** A fact row extended with the source message's text for traceability. */
export type SnapshotFact = MemoryFact & { sourceText: string | null };

export interface MemorySnapshot {
  pages: MemoryPage[];
  facts: SnapshotFact[];
  links: MemoryLink[];
  forgotten: Array<{ id: string; testerId: string; messageId: string; createdAt: Date }>;
}

/** Query all memory rows for a tester at this moment. v2=true snapshots v2 tables instead. */
export async function takeSnapshot(db: Db, testerId: string, v2 = false): Promise<MemorySnapshot> {
  if (v2) return takeV2Snapshot(db, testerId);
  const pages = await db.select().from(memoryPages).where(eq(memoryPages.testerId, testerId));
  const rawFacts = await db.select().from(memoryFacts).where(eq(memoryFacts.testerId, testerId));
  const links = await db.select().from(memoryLinks).where(eq(memoryLinks.testerId, testerId));
  const forgotten = await db.select().from(memoryForgotten).where(eq(memoryForgotten.testerId, testerId));

  // Look up sourceText for facts that have a sourceMessageId
  const sourceIds = rawFacts.map((f) => f.sourceMessageId).filter((id): id is string => id !== null);
  const sourceMap = new Map<string, string>();
  if (sourceIds.length > 0) {
    const sourceRows = await db.select({ id: messages.id, content: messages.content }).from(messages).where(inArray(messages.id, sourceIds));
    for (const row of sourceRows) {
      if (row.content) sourceMap.set(row.id, row.content);
    }
  }

  const facts: SnapshotFact[] = rawFacts.map((f) => ({
    ...f,
    sourceText: f.sourceMessageId ? (sourceMap.get(f.sourceMessageId) ?? null) : null,
  }));

  return { pages, facts, links, forgotten };
}

/** Remove source message IDs, source text and forgotten message IDs so the grader sees only structure. */
export function stripForGrader(snapshot: MemorySnapshot): MemorySnapshot {
  return {
    pages: snapshot.pages.map((p) => ({ ...p })),
    facts: snapshot.facts.map((f) => ({ ...f, sourceMessageId: null, sourceText: null })),
    links: snapshot.links.map((l) => ({ ...l })),
    forgotten: snapshot.forgotten.map((f) => ({ ...f, messageId: "" })),
  };
}

/** Write a snapshot's JSON and rendered text to files in the run directory. */
export function saveSnapshot(dir: string, day: number, snapshot: MemorySnapshot, rendered: string): void {
  const pad = String(day).padStart(2, "0");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `night-${pad}.json`), JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(path.join(dir, `night-${pad}.txt`), rendered);
}

/**
 * #250: snapshot v2 memory tables. Reuses the same MemorySnapshot shape by mapping v2 types
 * into the existing structure so the grader can read them unchanged.
 */
async function takeV2Snapshot(db: Db, testerId: string): Promise<MemorySnapshot> {
  const v2Pages = await db.select().from(memoryV2Pages).where(eq(memoryV2Pages.testerId, testerId));
  const v2Entries = await db.select().from(memoryV2Entries).where(eq(memoryV2Entries.testerId, testerId));
  const v2Links = await db.select().from(memoryV2Links);
  const v2Dailies = await db.select().from(memoryV2Daily).where(eq(memoryV2Daily.testerId, testerId));
  const forgotten = await db.select().from(memoryForgotten).where(eq(memoryForgotten.testerId, testerId));

  // Look up source texts for entries
  const sourceIds = v2Entries.map((e) => e.sourceMessageId).filter((id): id is string => id !== null);
  const sourceMap = new Map<string, string>();
  if (sourceIds.length > 0) {
    const sourceRows = await db.select({ id: messages.id, content: messages.content }).from(messages).where(inArray(messages.id, sourceIds));
    for (const row of sourceRows) {
      if (row.content) sourceMap.set(row.id, row.content);
    }
  }

  // Map v2 pages into MemoryPage shape for the grader
  const pages: MemoryPage[] = v2Pages.map((p) => ({
    id: p.id,
    testerId: p.testerId,
    kind: p.kind as MemoryPage["kind"], // kinds overlap enough for grading
    title: p.title,
    summary: p.about,
    body: "",
    goalSlug: p.goalSlug,
    status: p.status as MemoryPage["status"],
    date: null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  // Add daily summaries as "daily" pages
  for (const d of v2Dailies) {
    pages.push({
      id: d.id,
      testerId: d.testerId,
      kind: "daily",
      title: d.date,
      summary: d.summary,
      body: d.summary,
      goalSlug: null,
      status: "active",
      date: d.date,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    });
  }

  // Map v2 entries into MemoryFact shape
  const facts: SnapshotFact[] = v2Entries.map((e) => ({
    id: e.id,
    pageId: e.pageId,
    testerId: e.testerId,
    section: `${e.type}:${e.status}`,
    label: e.when ?? null,
    text: e.text + (e.detail ? ` (${e.detail})` : ""),
    sourceMessageId: e.sourceMessageId,
    day: e.learnedOn,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    sourceText: e.sourceMessageId ? (sourceMap.get(e.sourceMessageId) ?? null) : null,
  }));

  // Map v2 links
  const links: MemoryLink[] = v2Links.map((l) => ({
    id: l.id,
    testerId: v2Pages[0]?.testerId ?? testerId,
    fromPageId: l.fromPageId,
    toPageId: l.toPageId,
    kind: l.kind as MemoryLink["kind"],
    createdAt: l.createdAt,
  }));

  return { pages, facts, links, forgotten, memoryVersion: "v2" } as MemorySnapshot & { memoryVersion: string };
}
