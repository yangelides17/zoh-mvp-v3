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
  messages,
  type MemoryPage,
  type MemoryFact,
  type MemoryLink,
} from "../../src/db/schema.js";

/** A fact row extended with the source message's text for traceability. */
export type SnapshotFact = MemoryFact & { sourceText: string | null };

export interface MemorySnapshot {
  pages: MemoryPage[];
  facts: SnapshotFact[];
  links: MemoryLink[];
  forgotten: Array<{ id: string; testerId: string; messageId: string; createdAt: Date }>;
}

/** Query all memory rows for a tester at this moment. */
export async function takeSnapshot(db: Db, testerId: string): Promise<MemorySnapshot> {
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
