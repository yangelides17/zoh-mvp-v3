import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { coachingGuidance, type CoachingGuidance } from "../db/schema.js";

// #158: reading the team's guidance, kept apart from the changes (coaching.ts) so the coach's state can load it
// without reaching memory or the console.

/** Guidance stays short and few, so it shapes the coach without crowding everything else it reads. */
export const GUIDANCE_MAX_LINES = 10;
export const GUIDANCE_MAX_CHARS = 200;

/** The short ref the coach and console chat use for a guidance line. */
export const guidanceRef = (id: string) => `g:${id.slice(0, 8)}`;

export async function listGuidance(db: Db, testerId: string): Promise<CoachingGuidance[]> {
  return db.select().from(coachingGuidance).where(eq(coachingGuidance.testerId, testerId)).orderBy(asc(coachingGuidance.createdAt), asc(coachingGuidance.id));
}

/** A line by its id or its ref ("g:1a2b3c4d"), only among this tester's. */
export async function findGuidance(db: Db, testerId: string, idOrRef: string): Promise<CoachingGuidance | undefined> {
  const prefix = idOrRef.replace(/^g:/, "").trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(prefix)) return undefined;
  const rows = (await listGuidance(db, testerId)).filter((g) => g.id.startsWith(prefix));
  return rows.length === 1 ? rows[0] : undefined;
}
