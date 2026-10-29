import type { Tester } from "../db/schema.js";

/**
 * Test mode (#14): each tester's own clock. Everyone's is real time, except a dev account that has
 * texted "jump": theirs runs ahead by `clockOffsetMs` until "reset". Everything time-based about a
 * tester (replies, nudges, closing days, memory, summaries, their console page) reads this.
 */
export function testerNow(tester: Pick<Tester, "clockOffsetMs">, real: Date): Date {
  return tester.clockOffsetMs ? new Date(real.getTime() + tester.clockOffsetMs) : real;
}

/**
 * The time to store on a row the database would otherwise stamp: `at` for a jumped tester, so it
 * sits on their clock; undefined (the database's own time, as always) for everyone else.
 */
export function onTesterClock(tester: Pick<Tester, "clockOffsetMs">, at: Date): Date | undefined {
  return tester.clockOffsetMs ? at : undefined;
}

/** How far ahead a jumped clock is: "20 min", "1h20", "2d 3h". */
export function aheadBy(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h${String(minutes % 60).padStart(2, "0")}` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

/** Testers whose jump is running, and when it will finish. The minute ticks skip them; their texts wait. */
const running = new Map<string, Promise<void>>();

export function isJumping(testerId: string): boolean {
  return running.has(testerId);
}

/** Waits for a running jump (if any) to finish. */
export async function jumpSettled(testerId: string): Promise<void> {
  await running.get(testerId)?.catch(() => undefined);
}

/** Marks the tester as jumping while `work` runs; a jump already running goes first. */
export function whileJumping(testerId: string, work: () => Promise<void>): Promise<void> {
  const done = jumpSettled(testerId).then(work);
  const tracked = done.finally(() => {
    if (running.get(testerId) === tracked) running.delete(testerId);
  });
  running.set(testerId, tracked);
  return tracked;
}
