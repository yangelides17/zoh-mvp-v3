import type { CheckinAnswer, Plan, StepDay } from "../db/schema.js";
import { addDays, isStepDay } from "./schedule.js";

/**
 * How their step days went (spec: GitHub issues "Nudge scheduler", rules 5 and 6, and "Step log and
 * next step", rules 3, 4 and 8). Pure: the caller passes one goal's closed step days and its plans.
 */

export type DayRecord = Pick<StepDay, "date" | "status" | "planId">;
/** Version and change kind are optional: without them, no version is an upgrade. */
export type PlanTerms = Pick<Plan, "id" | "endsOn"> & Partial<Pick<Plan, "version" | "changeKind">>;

export interface DaySummary {
  /** Step days in a row that count, ending with the newest closed one. */
  streak: number;
  /** The newest day the streak counts, if it's still running: says whether today is already in it. */
  streakThrough?: string;
  /** Missed step days in a row, ending with the newest closed one. */
  missesInARow: number;
  /** Reduced days in a row, ending with the newest closed one. */
  reducedInARow: number;
}

/**
 * `days`: step days with a status, newest first; an open day (no status yet) is left out by the caller.
 * The streak is the run that's still going (see `streakRuns`).
 */
export function summarizeDays(days: DayRecord[], plans: PlanTerms[]): DaySummary {
  const closed = days.filter((d) => d.status !== null);
  const { current } = streakRuns(closed, plans);
  return {
    streak: current?.length ?? 0,
    streakThrough: current?.to,
    missesInARow: inARow(closed, "missed"),
    reducedInARow: inARow(closed, "done_reduced"),
  };
}

export interface StreakRun {
  length: number;
  /** First and last day counted. */
  from: string;
  to: string;
  /** Why it ended; unset for the run that's still going. */
  endedBy?: "miss" | "reduced" | "upgrade" | "stopped";
}

/**
 * One goal's streaks: the run still going (if any) and past runs, oldest first. A miss ends a run.
 * A reduced day keeps it alive once; a second reduced day in a row doesn't count and ends it, unless
 * the plan changed between them (they lowered it) or it ran on a temporary lighter plan (one with an
 * end date). An upgrade version starts a new run; deepen and other changes don't.
 * `days`: closed step days in any order.
 */
export function streakRuns(days: DayRecord[], plans: PlanTerms[]): { current?: StreakRun; past: StreakRun[] } {
  const closed = days.filter((d) => d.status !== null).sort((a, b) => a.date.localeCompare(b.date));
  const temporary = new Set(plans.filter((p) => p.endsOn).map((p) => p.id));
  const epochOf = upgradeEpochs(plans);
  const past: StreakRun[] = [];
  let run: StreakRun | undefined;
  let runEpoch = 0;
  const end = (endedBy: NonNullable<StreakRun["endedBy"]>) => {
    if (run) past.push({ ...run, endedBy });
    run = undefined;
  };
  for (const [i, day] of closed.entries()) {
    const epoch = (day.planId ? epochOf.get(day.planId) : undefined) ?? runEpoch;
    if (run && epoch > runEpoch) end("upgrade");
    runEpoch = epoch;
    if (day.status === "missed") {
      end("miss");
      continue;
    }
    if (day.status === "done_reduced") {
      const before = closed[i - 1];
      const secondInARow = before?.status === "done_reduced";
      const planHolds = before?.planId === day.planId && !(day.planId && temporary.has(day.planId));
      if (secondInARow && planHolds) {
        end("reduced");
        continue;
      }
    }
    run = run ? { ...run, length: run.length + 1, to: day.date } : { length: 1, from: day.date, to: day.date };
  }
  // An upgrade with no days on it yet still ends the run before it.
  if (run && Math.max(0, ...epochOf.values()) > runEpoch) end("upgrade");
  return { current: run, past };
}

/** Each plan's latest upgrade at or before it (its version number), 0 before any upgrade. */
function upgradeEpochs(plans: PlanTerms[]): Map<string, number> {
  const sorted = plans.filter((p) => p.version != null).sort((a, b) => a.version! - b.version!);
  const epochs = new Map<string, number>();
  let epoch = 0;
  for (const p of sorted) {
    if (p.changeKind === "upgrade") epoch = p.version!;
    epochs.set(p.id, epoch);
  }
  return epochs;
}

export interface HitRate {
  /** Step days done, full or reduced. */
  done: number;
  /** Step days closed (done or missed). */
  closed: number;
}

/**
 * Hit rate since the goal started, across every version (upgrades included): step days done out of
 * step days closed. A day off the plan it ran on (a rest day) counts as neither.
 */
export function hitRate(days: DayRecord[], plans: Pick<Plan, "id" | "days" | "startDate">[]): HitRate {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const counted = days.filter((d) => {
    if (d.status === null) return false;
    const plan = d.planId ? byId.get(d.planId) : undefined;
    return !plan || isStepDay(plan, d.date);
  });
  return { done: counted.filter((d) => d.status !== "missed").length, closed: counted.length };
}

export interface CheckinRecord {
  date: string;
  answer: CheckinAnswer | null;
}

/**
 * A maintenance goal's streak (spec rule 4): it carries the streak it had as focus and is assumed to
 * go on over its last plan's step days until they say they stopped; then it ends at the last check-in
 * where they said they'd kept up ("mostly" counts). No answer changes nothing. A "kept up" after a stop
 * starts a new run from the stop. Days count through yesterday.
 */
export function maintenanceStreak(opts: {
  /** Its streak when it became maintenance (and its last day). */
  carried?: StreakRun;
  /** The local day it became maintenance. */
  since: string;
  plan: Pick<Plan, "days" | "startDate">;
  checkins: CheckinRecord[];
  today: string;
}): { current?: StreakRun; past: StreakRun[] } {
  const stepDaysIn = (after: string, through: string): string[] => {
    const out: string[] = [];
    for (let d = addDays(after, 1); d <= through; d = addDays(d, 1)) if (isStepDay(opts.plan, d)) out.push(d);
    return out;
  };
  const extend = (run: StreakRun | undefined, after: string, through: string): StreakRun | undefined => {
    const added = stepDaysIn(after, through);
    if (added.length === 0) return run;
    return run ? { ...run, length: run.length + added.length, to: added.at(-1)! } : { length: added.length, from: added[0]!, to: added.at(-1)! };
  };
  const past: StreakRun[] = [];
  let run = opts.carried;
  // Days after `from` are assumed kept up; `stopped` until they say they've kept up again.
  let from = opts.since;
  let stopped = false;
  const answered = opts.checkins.filter((c) => c.answer !== null).sort((a, b) => a.date.localeCompare(b.date));
  for (const c of answered) {
    if (c.answer === "stopped") {
      if (stopped) continue;
      if (run) past.push({ ...run, endedBy: "stopped" });
      run = undefined;
      stopped = true;
      from = c.date;
    } else if (stopped) {
      stopped = false;
      run = extend(undefined, from, c.date);
      from = c.date;
    } else {
      run = extend(run, from, c.date);
      from = c.date;
    }
  }
  if (!stopped) run = extend(run, from, addDays(opts.today, -1));
  return { current: run, past };
}

function inARow(days: DayRecord[], status: DayRecord["status"]): number {
  const firstOther = days.findIndex((d) => d.status !== status);
  return firstOther === -1 ? days.length : firstOther;
}
