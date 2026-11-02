import { and, desc, eq, inArray } from "drizzle-orm";
import { currentPlan, localDate, planSentSince } from "../coach/state.js";
import type { Db } from "../db/client.js";
import { plans, stepDays, type Tester } from "../db/schema.js";
import { addDays, isStepDay, type DayStep, type QuietClock } from "./schedule.js";

/** Days around today whose steps are loaded: yesterday (its night can run past midnight) through a week ahead (forecasts). */
const DAYS_BEFORE = 1;
const DAYS_AFTER = 7;

/**
 * #48: the tester with each nearby local day's step attached, so their quiet hours fit around it
 * (`quietOn`). After lock, a step day's step is that day's time (moved for the day, or the plan's that
 * applies then, a temporary one included) and length; before lock, the plan's once it's been shown to
 * them. Chosen quiet hours never stretch, so they need nothing loaded.
 */
export async function withDaySteps<T extends Tester>(db: Db, tester: T, now: Date): Promise<T & QuietClock> {
  if (tester.quietHoursChosen || !tester.goalSlug) return tester;
  const today = localDate(now, tester.timeZone);
  const dates = Array.from({ length: DAYS_BEFORE + DAYS_AFTER + 1 }, (_, i) => addDays(today, i - DAYS_BEFORE));
  const steps: Record<string, DayStep | undefined> = {};
  if (tester.phase === "active") {
    const goalPlans = await db
      .select()
      .from(plans)
      .where(and(eq(plans.testerId, tester.id), eq(plans.goalSlug, tester.goalSlug), eq(plans.status, "locked")))
      .orderBy(desc(plans.version));
    if (goalPlans.length === 0) return tester;
    const rows = await db
      .select({ date: stepDays.date, movedTime: stepDays.movedTime, stepMinutes: stepDays.stepMinutes })
      .from(stepDays)
      .where(and(eq(stepDays.testerId, tester.id), inArray(stepDays.date, dates)));
    for (const date of dates) {
      const plan = currentPlan(goalPlans, tester.goalSlug, date);
      const row = rows.find((r) => r.date === date);
      if (!plan || !isStepDay(plan, date, row)) continue;
      steps[date] = { time: row?.movedTime ?? plan.stepTime, minutes: row?.stepMinutes ?? plan.minutes };
    }
  } else if (tester.phase === "planning") {
    // Spec edge case: before lock, the move happens once the plan is shown, so texts at that time get through too.
    const [draft] = await db
      .select()
      .from(plans)
      .where(and(eq(plans.testerId, tester.id), eq(plans.goalSlug, tester.goalSlug), eq(plans.status, "draft")))
      .orderBy(desc(plans.updatedAt))
      .limit(1);
    if (!draft || !(await planSentSince(db, tester, draft.id))) return tester;
    for (const date of dates) steps[date] = { time: draft.stepTime, minutes: draft.minutes };
  }
  return { ...tester, steps };
}
