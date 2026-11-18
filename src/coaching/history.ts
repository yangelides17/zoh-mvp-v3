import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { coachingChanges, type CoachingChange, COACHING_ACTIONS, COACHING_AREAS } from "../db/schema.js";

/** #158: one change to how a tester is coached; `by` is a founder's name, "tester" or "ZOH". */
export interface CoachingChangeInput {
  testerId: string;
  area: (typeof COACHING_AREAS)[number];
  action: (typeof COACHING_ACTIONS)[number];
  from?: string | null;
  to?: string | null;
  by: string;
  at: Date;
}

export async function logCoachingChange(db: Db, change: CoachingChangeInput): Promise<void> {
  await db.insert(coachingChanges).values({ ...change, from: change.from ?? null, to: change.to ?? null });
}

/** Newest first. */
export async function coachingHistory(db: Db, testerId: string, limit = 50): Promise<CoachingChange[]> {
  return db
    .select()
    .from(coachingChanges)
    .where(eq(coachingChanges.testerId, testerId))
    .orderBy(desc(coachingChanges.at), desc(coachingChanges.id))
    .limit(limit);
}
