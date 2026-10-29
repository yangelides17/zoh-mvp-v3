import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  DEFAULT_PUSHINESS,
  DEFAULT_QUIET_HOURS,
  maintenanceCheckins,
  memoryFacts,
  memoryForgotten,
  memoryPages,
  nudges,
  pauses,
  planInputs,
  plans,
  stepDays,
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
 * check-ins, step days, nudges and memory are deleted.
 */
export async function resetTester(db: Db, tester: Tester, at: Date): Promise<Tester> {
  const { timeZone, status } = guessTimeZone(tester.phone);
  await db.delete(memoryFacts).where(eq(memoryFacts.testerId, tester.id));
  await db.delete(memoryPages).where(eq(memoryPages.testerId, tester.id));
  await db.delete(memoryForgotten).where(eq(memoryForgotten.testerId, tester.id));
  await db.delete(planInputs).where(eq(planInputs.testerId, tester.id));
  await db.delete(testerGoals).where(eq(testerGoals.testerId, tester.id));
  await db.delete(maintenanceCheckins).where(eq(maintenanceCheckins.testerId, tester.id));
  await db.delete(stepDays).where(eq(stepDays.testerId, tester.id));
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
    contextStartedAt: at,
    memoryThrough: null,
    memorySince: null,
  });
}
