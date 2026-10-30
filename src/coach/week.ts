import { and, asc, count, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { nudges, stepDays, type StepDay, type Takeaway, type TakeawayEvidence, type Tester } from "../db/schema.js";
import { addDays, LOOKBACK_KIND, LOOKBACK_MIN_STEP_DAYS, weekdayOf } from "../nudges/schedule.js";

/**
 * The Sunday look-back (#78): what counts as progress this week, shared by the coach's state, the
 * console's progress tab and the founders' weekly summary, so all three agree on "understood".
 */

/** One lesson and every time they showed it, oldest first. */
export interface Learning {
  text: string;
  evidence: { kind: TakeawayEvidence; day: string }[];
}

export interface Learnings {
  /** Applied in a step or recalled later (in the window, when one is given): what counts as understood. */
  understood: Learning[];
  /** Only ever put in their own words: starting to click, not understood yet. */
  explained: Learning[];
}

const SHOWN: readonly TakeawayEvidence[] = ["applied", "recalled"];

/** The same lesson saved again (a recall, an application) groups with the first, whatever the case or punctuation. */
const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Groups takeaway rows into lessons. Understood: applied or recalled, on or after `since` when given
 * (explained once isn't enough). Explained: never applied or recalled. A lesson shown only before `since`
 * is in neither: it was earlier progress.
 */
export function learnings(rows: Pick<Takeaway, "text" | "day" | "evidence">[], since?: string): Learnings {
  const byKey = new Map<string, Learning>();
  const ordered = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  for (const row of ordered) {
    const k = key(row.text);
    const learning = byKey.get(k) ?? { text: row.text, evidence: [] };
    learning.evidence.push({ kind: row.evidence, day: row.day });
    byKey.set(k, learning);
  }
  const all = [...byKey.values()];
  return {
    understood: all.filter((l) => l.evidence.some((e) => SHOWN.includes(e.kind) && (!since || e.day >= since))),
    explained: all.filter((l) => l.evidence.every((e) => !SHOWN.includes(e.kind))),
  };
}

/** "applied Fri 2026-10-30, recalled Sat 2026-10-31": how they showed a lesson. */
export function evidenceText(l: Learning): string {
  const day = (d: string) => `${weekdayOf(d)[0]!.toUpperCase()}${weekdayOf(d).slice(1)} ${d}`;
  return l.evidence.map((e) => `${e.kind} ${day(e.day)}`).join(", ");
}

/** The Monday that starts the week holding `date`. */
export function weekStart(date: string): string {
  const back = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }[weekdayOf(date)];
  return addDays(date, -back);
}

export interface WeekLookback {
  /** Monday to the Sunday it's for. */
  from: string;
  to: string;
  /** This week's closed step days, oldest first. */
  days: StepDay[];
  learnings: Learnings;
  /** The recap already happened today (in conversation, or the 6 pm text is being or was written). */
  recapped: boolean;
  /** Recorded in the reply being written now: that text still has to give it. */
  recappedNow: boolean;
}

/** Closed step days through `date` (a reset deletes them, so these are since they started): the look-back needs a few first. */
export async function closedStepDays(db: Db, tester: Pick<Tester, "id">, date: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), isNotNull(stepDays.status), lte(stepDays.date, date)));
  return row?.n ?? 0;
}

/**
 * The week the Sunday look-back reads, on a Sunday with enough step days behind them; undefined on
 * any other day. `takeaways`: their recent lessons (the state already loads the last two weeks).
 */
export async function loadWeek(
  db: Db,
  tester: Pick<Tester, "id">,
  today: string,
  takeaways: Pick<Takeaway, "text" | "day" | "evidence">[],
  now: Date,
): Promise<WeekLookback | undefined> {
  if (weekdayOf(today) !== "sun") return undefined;
  if ((await closedStepDays(db, tester, today)) < LOOKBACK_MIN_STEP_DAYS) return undefined;
  const from = weekStart(today);
  const days = await db
    .select()
    .from(stepDays)
    .where(and(eq(stepDays.testerId, tester.id), isNotNull(stepDays.status), gte(stepDays.date, from), lte(stepDays.date, today)))
    .orderBy(asc(stepDays.date));
  const [recap] = await db
    .select({ status: nudges.status, createdAt: nudges.createdAt })
    .from(nudges)
    .where(and(eq(nudges.testerId, tester.id), eq(nudges.date, today), eq(nudges.kind, LOOKBACK_KIND)));
  // A reply's tool calls all run at its `now`: a recap recorded at exactly this instant is this reply's.
  const recappedNow = recap?.status === "skipped" && recap.createdAt.getTime() === now.getTime();
  return { from, to: today, days, learnings: learnings(takeaways, from), recapped: Boolean(recap), recappedNow };
}
