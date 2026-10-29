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
