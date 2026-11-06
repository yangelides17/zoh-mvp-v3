/**
 * Memory snapshot: captures the state of a tester's memory after each night (#147).
 * Used by the replay runner to record and compare memory across nights and runs.
 */

import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import {
  memoryPages,
  memoryFacts,
  memoryLinks,
  memoryForgotten,
  type MemoryPage,
  type MemoryFact,
  type MemoryLink,
} from "../../src/db/schema.js";

export interface MemorySnapshot {
  pages: MemoryPage[];
  facts: MemoryFact[];
  links: MemoryLink[];
  forgotten: Array<{ id: string; testerId: string; messageId: string; createdAt: Date }>;
}

/** Query all memory rows for a tester at this moment. */
export async function takeSnapshot(db: Db, testerId: string): Promise<MemorySnapshot> {
  const pages = await db.select().from(memoryPages).where(eq(memoryPages.testerId, testerId));
  const facts = await db.select().from(memoryFacts).where(eq(memoryFacts.testerId, testerId));
  const links = await db.select().from(memoryLinks).where(eq(memoryLinks.testerId, testerId));
  const forgotten = await db.select().from(memoryForgotten).where(eq(memoryForgotten.testerId, testerId));
  return { pages, facts, links, forgotten };
}

/** Remove source message IDs and message text from a snapshot so the grader sees only structure. */
export function stripForGrader(snapshot: MemorySnapshot): MemorySnapshot {
  return {
    pages: snapshot.pages.map((p) => ({ ...p })),
    facts: snapshot.facts.map((f) => ({ ...f, sourceMessageId: null })),
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
