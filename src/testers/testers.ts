import { eq, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  DEFAULT_PUSHINESS,
  DEFAULT_QUIET_HOURS,
  consoleMessages,
  flags,
  jumps,
  maintenanceCheckins,
  memoryFacts,
  memoryForgotten,
  memoryPages,
  messages,
  nudges,
  pauses,
  planInputs,
  plans,
  stepDays,
  takeaways,
  suggestions,
  testerGoals,
  testers,
  type NewTester,
  type Tester,
} from "../db/schema.js";
import { guessTimeZone } from "./area-codes.js";

/** Fields the app or the coach may change on a tester. */
export type TesterPatch = Partial<
  Pick<
    NewTester,
    | "name"
    | "phase"
    | "goalSlug"
    | "timeZone"
    | "timeZoneStatus"
    | "clockOffsetMs"
    | "quietHoursStart"
    | "quietHoursEnd"
    | "pushiness"
    | "styleNotes"
    | "isTestUser"
    | "stoppedAt"
    | "autoTextsPausedAt"
    | "contextStartedAt"
    | "memoryThrough"
    | "memorySince"
  >
>;

/**
 * The tester for an allowed number, created on their first text (which is their consent).
 * `isTestUser` follows DEV_NUMBERS, so adding or removing a dev number takes effect on their next text.
 */
export async function getOrCreateTester(
  db: Db,
  phone: string,
  opts: { firstTextAt: Date; isTestUser: boolean },
): Promise<Tester> {
  const { timeZone, status } = guessTimeZone(phone);
  await db
    .insert(testers)
    .values({
      phone,
      timeZone,
      timeZoneStatus: status,
      isTestUser: opts.isTestUser,
      consentAt: opts.firstTextAt,
      contextStartedAt: opts.firstTextAt,
    })
    .onConflictDoNothing({ target: testers.phone });
  const tester = await getTesterByPhone(db, phone);
  if (!tester) throw new Error("getOrCreateTester found no row after insert");
  if (tester.isTestUser !== opts.isTestUser) return updateTester(db, tester.id, { isTestUser: opts.isTestUser });
  return tester;
}

export async function getTesterByPhone(db: Db, phone: string): Promise<Tester | undefined> {
  const rows = await db.select().from(testers).where(eq(testers.phone, phone)).limit(1);
  return rows[0];
}

export async function getTester(db: Db, id: string): Promise<Tester | undefined> {
  const rows = await db.select().from(testers).where(eq(testers.id, id)).limit(1);
  return rows[0];
}

export async function updateTester(db: Db, id: string, patch: TesterPatch): Promise<Tester> {
  const rows = await db
    .update(testers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(testers.id, id))
    .returning();
  const tester = rows[0];
  if (!tester) throw new Error("updateTester found no row");
  return tester;
}

/**
 * Dev-account "reset": back to a brand-new tester whose context starts at `at`.
 * Messages, flags, suggestions and the console thread stay in the database; plan inputs, plans, goals,
 * check-ins, step days, takeaways, nudges and memory are deleted. A jumped clock (#14) goes back to real time,
 * and what stays moves back with it, so nothing is left in the future.
 */
export async function resetTester(db: Db, tester: Tester, at: Date): Promise<Tester> {
  const moved = tester.clockOffsetMs;
  if (moved) await moveHistoryBack(db, tester, moved);
  const { timeZone, status } = guessTimeZone(tester.phone);
  await db.delete(memoryFacts).where(eq(memoryFacts.testerId, tester.id));
  await db.delete(memoryPages).where(eq(memoryPages.testerId, tester.id));
  await db.delete(memoryForgotten).where(eq(memoryForgotten.testerId, tester.id));
  await db.delete(planInputs).where(eq(planInputs.testerId, tester.id));
  await db.delete(testerGoals).where(eq(testerGoals.testerId, tester.id));
  await db.delete(maintenanceCheckins).where(eq(maintenanceCheckins.testerId, tester.id));
  await db.delete(stepDays).where(eq(stepDays.testerId, tester.id));
  await db.delete(takeaways).where(eq(takeaways.testerId, tester.id));
  await db.delete(nudges).where(eq(nudges.testerId, tester.id));
  await db.delete(pauses).where(eq(pauses.testerId, tester.id));
  await db.delete(plans).where(eq(plans.testerId, tester.id));
  return updateTester(db, tester.id, {
    name: null,
    phase: "onboarding",
    goalSlug: null,
    timeZone,
    timeZoneStatus: status,
    quietHoursStart: DEFAULT_QUIET_HOURS.start,
    quietHoursEnd: DEFAULT_QUIET_HOURS.end,
    pushiness: DEFAULT_PUSHINESS,
    styleNotes: "",
    stoppedAt: null,
    autoTextsPausedAt: null,
    contextStartedAt: new Date(at.getTime() - moved),
    memoryThrough: null,
    memorySince: null,
    clockOffsetMs: 0,
  });
}

/** Moves every kept timestamp of a jumped tester back by `ms`, their jumps' clock times included. */
async function moveHistoryBack(db: Db, tester: Tester, ms: number): Promise<void> {
  const back = (column: AnyColumn) => sql`${column} - interval '${sql.raw(String(Math.trunc(ms)))} milliseconds'`;
  await db
    .update(messages)
    .set({ sentAt: back(messages.sentAt), createdAt: back(messages.createdAt), updatedAt: back(messages.updatedAt), mediaDeletedAt: back(messages.mediaDeletedAt) })
    .where(eq(messages.contactNumber, tester.phone));
  await db.update(flags).set({ createdAt: back(flags.createdAt) }).where(eq(flags.testerId, tester.id));
  await db
    .update(suggestions)
    .set({
      decidedAt: back(suggestions.decidedAt),
      deliveredAt: back(suggestions.deliveredAt),
      outcomeAt: back(suggestions.outcomeAt),
      createdAt: back(suggestions.createdAt),
      updatedAt: back(suggestions.updatedAt),
    })
    .where(eq(suggestions.testerId, tester.id));
  await db
    .update(consoleMessages)
    .set({
      dueAt: back(consoleMessages.dueAt),
      expiresAt: back(consoleMessages.expiresAt),
      doneAt: back(consoleMessages.doneAt),
      seenAt: back(consoleMessages.seenAt),
      createdAt: back(consoleMessages.createdAt),
    })
    .where(eq(consoleMessages.testerId, tester.id));
  await db.update(jumps).set({ fromAt: back(jumps.fromAt), toAt: back(jumps.toAt) }).where(eq(jumps.testerId, tester.id));
}
