import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { plans, stepDays, testerGoals, type Plan, type StepDay, type TesterGoal } from "../db/schema.js";
import { hitRate, streakRuns, type HitRate, type StreakRun } from "../nudges/streak.js";

/**
 * A tester's goals (spec: GitHub issue "Step log and next step"). `testers.goal_slug` is the focus
 * goal; `tester_goals` keeps every goal with its role and settings. Only the focus has nudges and proof.
 */

/**
 * Makes `slug` the focus goal. The previous focus is dropped (replaced: its streak is frozen), or
 * removed when it never got past onboarding (`previous: "remove"`).
 */
export async function setFocusGoal(db: Db, testerId: string, slug: string, at: Date, previous: "dropped" | "remove"): Promise<void> {
  const [old] = await db
    .select()
    .from(testerGoals)
    .where(and(eq(testerGoals.testerId, testerId), eq(testerGoals.role, "focus")));
  if (old && old.goalSlug !== slug) {
    if (previous === "remove") await db.delete(testerGoals).where(eq(testerGoals.id, old.id));
    else await db.update(testerGoals).set({ role: "dropped", nudges: false, proof: false, roleSince: at, updatedAt: at }).where(eq(testerGoals.id, old.id));
  }
  const focus = { role: "focus" as const, nudges: true, proof: true, checkinsPerWeek: 0, roleSince: at, updatedAt: at };
  await db
    .insert(testerGoals)
    .values({ testerId, goalSlug: slug, ...focus })
    .onConflictDoUpdate({ target: [testerGoals.testerId, testerGoals.goalSlug], set: focus });
}

export async function loadTesterGoals(db: Db, testerId: string): Promise<TesterGoal[]> {
  return db.select().from(testerGoals).where(eq(testerGoals.testerId, testerId)).orderBy(asc(testerGoals.createdAt));
}

/** One goal's locked plan versions and its closed step days through `through`, oldest first. */
export async function loadGoalDays(
  db: Db,
  testerId: string,
  goalSlug: string,
  through: string,
): Promise<{ days: StepDay[]; plans: Plan[] }> {
  const goalPlans = await db
    .select()
    .from(plans)
    .where(and(eq(plans.testerId, testerId), eq(plans.goalSlug, goalSlug), eq(plans.status, "locked")))
    .orderBy(asc(plans.version));
  const rows = await db
    .select({ day: stepDays })
    .from(stepDays)
    .innerJoin(plans, eq(plans.id, stepDays.planId))
    .where(and(eq(stepDays.testerId, testerId), eq(plans.goalSlug, goalSlug), isNotNull(stepDays.status), lte(stepDays.date, through)))
    .orderBy(asc(stepDays.date));
  return { days: rows.map((r) => r.day), plans: goalPlans };
}

export interface GoalMetrics {
  goalSlug: string;
  /** The streak still going, if any. */
  current?: StreakRun;
  /** Earlier streaks, oldest first. */
  past: StreakRun[];
  hitRate: HitRate;
}

/** A focus (or dropped) goal's streaks and hit rate from its step days, through `through`. */
export async function goalMetrics(db: Db, testerId: string, goalSlug: string, through: string): Promise<GoalMetrics> {
  const { days, plans: goalPlans } = await loadGoalDays(db, testerId, goalSlug, through);
  return { goalSlug, ...streakRuns(days, goalPlans), hitRate: hitRate(days, goalPlans) };
}
