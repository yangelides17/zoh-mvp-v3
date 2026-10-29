import { and, desc, eq, gte, isNull, max, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pauses, type Pause, type PauseEndReason, type Tester } from "../db/schema.js";
import { raiseAlert } from "../console/alerts.js";
import { dayBounds, zonedTime } from "../nudges/schedule.js";

/**
 * A break the tester asked for (spec: GitHub issue "Commands and safety", rules 1 to 5). ZOH starts
 * no texts while one is open, replies as usual, and step days that end inside it never count as missed.
 * Separate from the automatic pause after a long silence (`testers.autoTextsPausedAt`).
 */

type TesterClock = Pick<Tester, "timeZone" | "quietHoursStart" | "quietHoursEnd">;

export async function activePause(db: Db, testerId: string): Promise<Pause | undefined> {
  const [row] = await db
    .select()
    .from(pauses)
    .where(and(eq(pauses.testerId, testerId), isNull(pauses.endedAt)))
    .limit(1);
  return row;
}

/** Opens a pause and raises one alert; an open one is returned as is (`created: false`, no second alert). */
export async function startPause(
  db: Db,
  tester: Pick<Tester, "id">,
  opts: { at: Date; until?: string; reason?: string },
): Promise<{ pause: Pause; created: boolean }> {
  const open = await activePause(db, tester.id);
  if (open) return { pause: open, created: false };
  const [pause] = await db
    .insert(pauses)
    .values({ testerId: tester.id, startedAt: opts.at, until: opts.until ?? null, reason: opts.reason ?? null })
    .returning();
  const until = opts.until ? ` until ${opts.until}` : "";
  await raiseAlert(db, {
    testerId: tester.id,
    topic: "pause",
    key: `pause:${pause!.id}`,
    body: `Paused ZOH's texts${until}: ${opts.reason ?? "no reason given"}`,
    at: opts.at,
  });
  return { pause: pause!, created: true };
}

/**
 * Closes the open pause, if any. Coming back (they said so, or their end date came) raises one alert;
 * a stop or a dev reset closes it quietly (the stop has its own alert).
 */
export async function endPause(db: Db, testerId: string, opts: { at: Date; by: PauseEndReason }): Promise<Pause | undefined> {
  const [ended] = await db
    .update(pauses)
    .set({ endedAt: opts.at, endedBy: opts.by })
    .where(and(eq(pauses.testerId, testerId), isNull(pauses.endedAt)))
    .returning();
  if (ended && (opts.by === "tester" || opts.by === "end_date")) {
    await raiseAlert(db, {
      testerId,
      topic: "resume",
      key: `resume:${ended.id}`,
      body: opts.by === "end_date" ? `Back from their pause (end date ${ended.until})` : "Back from their pause: they said they're back",
      at: opts.at,
    });
  }
  return ended;
}

/** When their latest pause ended: their silence counts from then, not from their last text before the break. */
export async function lastPauseEnd(db: Db, testerId: string): Promise<Date | undefined> {
  const [row] = await db.select({ at: max(pauses.endedAt) }).from(pauses).where(eq(pauses.testerId, testerId));
  return row?.at ? new Date(row.at) : undefined;
}

/** Their end date has come: the pause lifts once that day's quiet hours are over. */
export function pauseEnds(pause: Pause, now: Date, t: TesterClock): boolean {
  return pause.until !== null && now.getTime() >= zonedTime(pause.until, t.quietHoursEnd, t.timeZone).getTime();
}

/** Pauses open now or ended at or after `since`: enough to judge the days the scheduler closes. */
export async function pausesSince(db: Db, testerId: string, since: Date): Promise<Pause[]> {
  return db
    .select()
    .from(pauses)
    .where(and(eq(pauses.testerId, testerId), or(isNull(pauses.endedAt), gte(pauses.endedAt, since))))
    .orderBy(desc(pauses.startedAt));
}

/** A step day is paused when its end (quiet hours starting) fell inside a pause: it's never a miss. */
export function pausedOn(list: Pause[], date: string, t: TesterClock): boolean {
  const end = dayBounds(date, t).end;
  return list.some((p) => p.startedAt.getTime() <= end && (p.endedAt === null || p.endedAt.getTime() > end));
}
