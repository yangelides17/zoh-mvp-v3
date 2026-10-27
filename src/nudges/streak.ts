import type { Plan, StepDay } from "../db/schema.js";

/**
 * How their recent step days went (spec: GitHub issue "Nudge scheduler", rules 5 and 6). Pure:
 * the caller passes their closed step days, newest first, and the plans those days ran on.
 */

export type DayRecord = Pick<StepDay, "date" | "status" | "planId">;
export type PlanTerms = Pick<Plan, "id" | "endsOn">;

export interface DaySummary {
  /** Step days in a row that count, ending with the newest closed one. */
  streak: number;
  /** Missed step days in a row, ending with the newest closed one. */
  missesInARow: number;
  /** Reduced days in a row, ending with the newest closed one. */
  reducedInARow: number;
}

/**
 * `days`: step days with a status, newest first; an open day (no status yet) is left out by the caller.
 * A reduced day keeps the streak alive once. A second reduced day in a row doesn't count, and ends
 * the streak, unless the plan changed between them (they lowered it) or it ran on a temporary
 * lighter plan (one with an end date).
 */
export function summarizeDays(days: DayRecord[], plans: PlanTerms[]): DaySummary {
  const closed = days.filter((d) => d.status !== null);
  const temporary = new Set(plans.filter((p) => p.endsOn).map((p) => p.id));
  let streak = 0;
  for (const [i, day] of closed.entries()) {
    if (day.status === "missed") break;
    if (day.status === "done_reduced") {
      const before = closed[i + 1];
      const secondInARow = before?.status === "done_reduced";
      const planHolds = before?.planId === day.planId && !(day.planId && temporary.has(day.planId));
      if (secondInARow && planHolds) break;
    }
    streak += 1;
  }
  return {
    streak,
    missesInARow: inARow(closed, "missed"),
    reducedInARow: inARow(closed, "done_reduced"),
  };
}

function inARow(days: DayRecord[], status: DayRecord["status"]): number {
  const firstOther = days.findIndex((d) => d.status !== status);
  return firstOther === -1 ? days.length : firstOther;
}
