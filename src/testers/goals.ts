import { and, asc, desc, eq, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  maintenanceCheckins,
  plans,
  stepDays,
  testerGoals,
  type MaintenanceCheckin,
  type Plan,
  type StepDay,
  type Tester,
  type TesterGoal,
} from "../db/schema.js";
import { serviceDate } from "../nudges/schedule.js";
import { hitRate, maintenanceStreak, streakRuns, type HitRate, type StreakRun } from "../nudges/streak.js";

/**
 * A tester's goals (spec: GitHub issue "Step log and next step"). `testers.goal_slug` is the focus
 * goal; `tester_goals` keeps every goal with its role and settings. Only the focus has nudges and proof.
 */

/** Goals a tester can have at once (focus plus maintenance) when `GOAL_CAP` isn't set. */
export const DEFAULT_GOAL_CAP = 3;
/** Check-ins a week for a goal that becomes maintenance (spec rule 7). */
export const MAINTENANCE_CHECKINS_PER_WEEK = 2;

/**
 * Makes `slug` the focus goal. The previous focus is dropped (replaced: its streak is frozen),
 * kept as maintenance (an approved new focus: light check-ins, no nudges or proof), or removed
 * when it never got past onboarding (`previous: "remove"`).
 */
export async function setFocusGoal(
  db: Db,
  testerId: string,
  slug: string,
  at: Date,
  previous: "dropped" | "maintenance" | "remove",
): Promise<void> {
  const [old] = await db
    .select()
    .from(testerGoals)
    .where(and(eq(testerGoals.testerId, testerId), eq(testerGoals.role, "focus")));
  if (old && old.goalSlug !== slug) {
    if (previous === "remove") await db.delete(testerGoals).where(eq(testerGoals.id, old.id));
    else {
      const checkinsPerWeek = previous === "maintenance" ? MAINTENANCE_CHECKINS_PER_WEEK : 0;
      await db
        .update(testerGoals)
        .set({ role: previous, nudges: false, proof: false, checkinsPerWeek, roleSince: at, updatedAt: at })
        .where(eq(testerGoals.id, old.id));
    }
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

/** A tester's maintenance check-ins (one goal's, or every goal's), oldest first. */
export async function loadCheckins(db: Db, testerId: string, goalSlug?: string): Promise<MaintenanceCheckin[]> {
  return db
    .select()
    .from(maintenanceCheckins)
    .where(and(eq(maintenanceCheckins.testerId, testerId), goalSlug ? eq(maintenanceCheckins.goalSlug, goalSlug) : undefined))
    .orderBy(asc(maintenanceCheckins.date), asc(maintenanceCheckins.createdAt));
}

/** One live goal's streak, as "what's my streak?" answers it. */
export interface GoalStreak {
  goalSlug: string;
  role: "focus" | "maintenance";
  /** The run still going, if any. */
  current?: StreakRun;
  /** Maintenance: check-ins answered kept up ("mostly" included), out of those answered, and the last such day. */
  keptUp?: number;
  answered?: number;
  lastConfirmed?: string;
}

/**
 * Every live goal's streak through `today`: the focus from its step days; a maintenance goal from the
 * streak it carried as focus, assumed to go on over its last plan until they say they stopped (rule 4).
 */
export async function goalStreaks(db: Db, tester: Tester, goals: TesterGoal[], today: string): Promise<GoalStreak[]> {
  const out: GoalStreak[] = [];
  for (const g of goals) {
    if (g.role === "focus") {
      const { days, plans: goalPlans } = await loadGoalDays(db, tester.id, g.goalSlug, today);
      out.push({ goalSlug: g.goalSlug, role: "focus", current: streakRuns(days, goalPlans).current });
    } else if (g.role === "maintenance") {
      const since = serviceDate(g.roleSince, tester);
      const { days, plans: goalPlans } = await loadGoalDays(db, tester.id, g.goalSlug, since);
      const [plan] = await db
        .select()
        .from(plans)
        .where(and(eq(plans.testerId, tester.id), eq(plans.goalSlug, g.goalSlug), eq(plans.status, "locked")))
        .orderBy(desc(plans.version))
        .limit(1);
      const checkins = (await loadCheckins(db, tester.id, g.goalSlug)).filter((c) => c.date >= since);
      const answered = checkins.filter((c) => c.answer !== null);
      const kept = answered.filter((c) => c.answer !== "stopped");
      const carried = streakRuns(days, goalPlans).current;
      out.push({
        goalSlug: g.goalSlug,
        role: "maintenance",
        current: plan ? maintenanceStreak({ carried, since, plan, checkins, today }).current : carried,
        keptUp: kept.length,
        answered: answered.length,
        lastConfirmed: kept.at(-1)?.date,
      });
    }
  }
  return out;
}
