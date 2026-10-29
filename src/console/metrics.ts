import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { localDate } from "../coach/state.js";
import { BACK_OFF_FLAG } from "../coach/tools.js";
import type { Db } from "../db/client.js";
import { consoleMessages, flags, messages, pauses, plans, stepDays, testerGoals, testers, type Message, type Pause, type Tester } from "../db/schema.js";
import { messageTime } from "../memory/store.js";
import { addDays, daysBetween, weekdayOf } from "../nudges/schedule.js";
import type { HitRate, StreakRun } from "../nudges/streak.js";
import { pausedOn } from "../testers/pauses.js";
import { goalTitles, goalViews } from "./data.js";

/**
 * The beta numbers (spec: GitHub issue "Metrics"): worked out on each load from what's stored, read
 * only. Days are the tester's local days; paused days (#12) are left out of retention and active days.
 */

/** This many silent local days in a row (paused days skipped) end a retention run. */
export const SILENT_DAYS = 3;
/** A text this long after their previous one starts a new touch point. */
export const TOUCH_GAP_MS = 30 * 60_000;

export interface RetentionRun {
  from: string;
  to: string;
  /** Days in the run, paused days left out. */
  days: number;
}

export interface Retention {
  /** Every run, oldest first; the last is still going when `current` is set. */
  runs: RetentionRun[];
  current?: RetentionRun;
  /** Days retained across every run. */
  total: number;
  /** Times they came back after a silence. */
  comebacks: number;
}

/**
 * Retention from the day of their first text through today (rule 1). A run ends at their last text
 * before SILENT_DAYS silent days; texting again starts a new run. Today counts toward the run while it
 * lasts but never toward the silence, since the day isn't over.
 */
export function retention(textDays: Set<string>, start: string, today: string, paused: (date: string) => boolean): Retention {
  const runs: RetentionRun[] = [];
  let from = start;
  let last = start;
  let days = 0;
  let silent = 0;
  let comebacks = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (textDays.has(d)) {
      if (silent >= SILENT_DAYS) {
        runs.push({ from, to: last, days });
        comebacks++;
        from = d;
        days = 0;
        silent = 0;
      }
      days += silent + 1;
      silent = 0;
      last = d;
    } else if (!paused(d) && d < today) {
      silent++;
    }
  }
  const ongoing = silent < SILENT_DAYS;
  // Silent days after their last text count once the run carries on through today.
  const current = ongoing ? { from, to: today, days: days + silent + (textDays.has(today) || paused(today) ? 0 : 1) } : undefined;
  if (current) runs.push(current);
  else runs.push({ from, to: last, days });
  return { runs, current, total: runs.reduce((n, r) => n + r.days, 0), comebacks };
}

export interface Engagement {
  /** Local days with a text from them. */
  activeDays: number;
  /** Days since their start, paused days left out unless they texted. */
  ofDays: number;
  touchPoints: number;
  messages: number;
}

/** Active days (rule 2) and touch points (rule 3) from their inbound texts, oldest first. */
export function engagement(texts: Date[], timeZone: string, start: string, today: string, paused: (date: string) => boolean): Engagement {
  const textDays = new Set(texts.map((at) => localDate(at, timeZone)));
  let ofDays = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) if (textDays.has(d) || !paused(d)) ofDays++;
  let touchPoints = 0;
  let previous: Date | undefined;
  for (const at of texts) {
    if (!previous || at.getTime() - previous.getTime() >= TOUCH_GAP_MS || localDate(at, timeZone) !== localDate(previous, timeZone)) touchPoints++;
    previous = at;
  }
  return { activeDays: textDays.size, ofDays, touchPoints, messages: texts.length };
}

/** Monday of the week `date` falls in. */
export function weekStart(date: string): string {
  const back = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }[weekdayOf(date)];
  return addDays(date, -back);
}

export interface Progression {
  deepened?: Date;
  upgraded?: Date;
  /** A goal on top of the first that's still live (a switch replaces one, so it isn't this). */
  addedGoal?: Date;
}

export interface TesterMetrics {
  tester: Tester;
  /** Their local day of their first text; undefined until they've texted. */
  start?: string;
  retention?: Retention;
  engagement?: Engagement;
  focusTitle?: string;
  streak?: StreakRun;
  hitRate?: HitRate;
  /** Verified steps (rule 4): this week, and the average a week since their plan started. */
  verified?: { thisWeek: number; total: number; perWeek: number };
  progression: Progression;
  backOff: { pauses: number; flags: number };
  stops: number;
}

export interface Rollup {
  testers: number;
  retainedDays?: number;
  activeShare?: number;
  touchPointsPerDay?: number;
  messagesPerDay?: number;
  verifiedPerWeek?: number;
  hitRate?: number;
  streak?: number;
  progressed: number;
  backOff: number;
  stops: number;
}

/**
 * Today for a tester. One place so the test clock (#14) can move it per tester.
 */
function testerNow(_tester: Tester, now: Date): Date {
  return now;
}

/** One tester's numbers, since their context started (a dev "reset" starts fresh). */
export async function testerMetrics(db: Db, tester: Tester, now: Date, titles?: Awaited<ReturnType<typeof goalTitles>>): Promise<TesterMetrics> {
  const at = testerNow(tester, now);
  const today = localDate(at, tester.timeZone);
  const since = tester.contextStartedAt;
  const inbound: Message[] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), eq(messages.direction, "inbound"), gte(messages.createdAt, since)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const texts = inbound.map(messageTime).filter((t) => t.getTime() <= at.getTime()).sort((a, b) => a.getTime() - b.getTime());
  // A dev "reset" deletes plans, goals, step days and pauses, but keeps messages, flags and alerts.
  const pauseRows: Pause[] = await db.select().from(pauses).where(eq(pauses.testerId, tester.id));
  const paused = (date: string) => pausedOn(pauseRows, date, tester);

  const views = await goalViews(db, tester, at, titles ?? (await goalTitles(db)));
  const focus = views.find((v) => v.goal.role === "focus");

  const out: TesterMetrics = {
    tester,
    focusTitle: focus?.title,
    streak: focus?.current,
    hitRate: focus?.hitRate,
    progression: await progression(db, tester),
    backOff: {
      pauses: pauseRows.length,
      flags: (await db.select().from(flags).where(and(eq(flags.testerId, tester.id), eq(flags.kind, BACK_OFF_FLAG), gte(flags.createdAt, since)))).length,
    },
    stops: (
      await db
        .select()
        .from(consoleMessages)
        .where(and(eq(consoleMessages.testerId, tester.id), eq(consoleMessages.kind, "alert"), eq(consoleMessages.topic, "stop"), gte(consoleMessages.createdAt, since)))
    ).length,
  };
  if (texts.length) {
    const start = localDate(texts[0]!, tester.timeZone);
    out.start = start;
    out.retention = retention(new Set(texts.map((t) => localDate(t, tester.timeZone))), start, today, paused);
    out.engagement = engagement(texts, tester.timeZone, start, today, paused);
  }
  out.verified = await verified(db, tester, today);
  return out;
}

async function verified(db: Db, tester: Tester, today: string): Promise<TesterMetrics["verified"]> {
  const locked = await db.select().from(plans).where(and(eq(plans.testerId, tester.id), eq(plans.status, "locked")));
  const starts = locked.map((p) => p.startDate).filter((d): d is string => Boolean(d) && d! <= today).sort();
  if (!starts.length) return undefined;
  const days = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), inArray(stepDays.status, ["done", "done_reduced"]), inArray(stepDays.proofVerdict, ["clear", "plausible"])));
  const proven = days.filter((d) => d.date >= starts[0]! && d.date <= today);
  const monday = weekStart(today);
  const weeks = Math.max(1, (daysBetween(starts[0]!, today) + 1) / 7);
  return { thisWeek: proven.filter((d) => d.date >= monday).length, total: proven.length, perWeek: proven.length / weeks };
}

async function progression(db: Db, tester: Tester): Promise<Progression> {
  const locked = await db
    .select()
    .from(plans)
    .where(and(eq(plans.testerId, tester.id), eq(plans.status, "locked")))
    .orderBy(asc(plans.version));
  const first = (kind: "deepen" | "upgrade") => {
    const p = locked.find((v) => v.changeKind === kind);
    return p ? (p.lockedAt ?? p.createdAt) : undefined;
  };
  const goals = await db.select().from(testerGoals).where(eq(testerGoals.testerId, tester.id)).orderBy(asc(testerGoals.createdAt));
  const live = goals.filter((g) => g.role !== "dropped");
  const added = live.length > 1 ? live.at(-1)!.createdAt : undefined;
  return { deepened: first("deepen"), upgraded: first("upgrade"), addedGoal: added };
}

const average = (values: number[]): number | undefined => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);

/** Averages across testers, each skipping testers with nothing to count yet. */
export function rollup(rows: TesterMetrics[]): Rollup {
  const engaged = rows.filter((r) => r.engagement && r.engagement.activeDays > 0);
  return {
    testers: rows.length,
    retainedDays: average(rows.flatMap((r) => (r.retention ? [r.retention.total] : []))),
    activeShare: average(engaged.flatMap((r) => (r.engagement!.ofDays ? [r.engagement!.activeDays / r.engagement!.ofDays] : []))),
    touchPointsPerDay: average(engaged.map((r) => r.engagement!.touchPoints / r.engagement!.activeDays)),
    messagesPerDay: average(engaged.map((r) => r.engagement!.messages / r.engagement!.activeDays)),
    verifiedPerWeek: average(rows.flatMap((r) => (r.verified ? [r.verified.perWeek] : []))),
    hitRate: average(rows.flatMap((r) => (r.hitRate?.closed ? [r.hitRate.done / r.hitRate.closed] : []))),
    streak: average(rows.flatMap((r) => (r.focusTitle ? [r.streak?.length ?? 0] : []))),
    progressed: rows.filter((r) => r.progression.deepened || r.progression.upgraded || r.progression.addedGoal).length,
    backOff: rows.reduce((n, r) => n + r.backOff.pauses + r.backOff.flags, 0),
    stops: rows.reduce((n, r) => n + r.stops, 0),
  };
}

/** The Metrics page: real testers only unless `includeTest`, longest-running first. */
export async function metricsPage(db: Db, now: Date, opts: { includeTest: boolean }): Promise<{ rows: TesterMetrics[]; rollup: Rollup }> {
  const titles = await goalTitles(db);
  const all = await db.select().from(testers).where(opts.includeTest ? undefined : eq(testers.isTestUser, false));
  const rows: TesterMetrics[] = [];
  for (const tester of all) rows.push(await testerMetrics(db, tester, now, titles));
  rows.sort((a, b) => (a.start ?? "9999").localeCompare(b.start ?? "9999") || (a.tester.name ?? "").localeCompare(b.tester.name ?? ""));
  return { rows, rollup: rollup(rows) };
}
