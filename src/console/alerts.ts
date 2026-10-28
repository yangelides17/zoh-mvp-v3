import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { consoleMessages, flags, plans, type ConsoleMessage, type Flag } from "../db/schema.js";

/**
 * Alerts for the founder console (spec: GitHub issue "Founder console"). Each event has a key, so it
 * fires once however often its trigger runs. The console shows them; a founder marks each one seen.
 */

export const PLAN_REVIEW_TOPIC = "plan_review";
export interface AlertInput {
  testerId: string;
  /** What kind of event: a flag kind, plan_review, milestone… */
  topic: string;
  /** One per event, e.g. `flag:<id>` or `plan_review:<plan id>`. */
  key: string;
  body: string;
  planId?: string;
  suggestionId?: string;
  at?: Date;
}

/** Stores the alert unless its event already raised one; true when it's new. */
export async function raiseAlert(db: Db, alert: AlertInput): Promise<boolean> {
  const rows = await db
    .insert(consoleMessages)
    .values({
      testerId: alert.testerId,
      kind: "alert",
      topic: alert.topic,
      eventKey: alert.key,
      body: alert.body,
      planId: alert.planId,
      suggestionId: alert.suggestionId,
      createdAt: alert.at,
    })
    .onConflictDoNothing({ target: consoleMessages.eventKey })
    .returning({ id: consoleMessages.id });
  return rows.length > 0;
}

/**
 * Marks an alert seen (the first founder to see it is kept). Seeing a plan-to-review alert is the
 * review: it clears that plan version's needs-review flag.
 */
export async function markAlertSeen(db: Db, opts: { testerId: string; alertId: string; by: string; at: Date }): Promise<ConsoleMessage | undefined> {
  const [alert] = await db
    .select()
    .from(consoleMessages)
    .where(and(eq(consoleMessages.id, opts.alertId), eq(consoleMessages.testerId, opts.testerId), eq(consoleMessages.kind, "alert")));
  if (!alert) return undefined;
  if (!alert.seenAt) {
    await db
      .update(consoleMessages)
      .set({ seenAt: opts.at, seenBy: opts.by })
      .where(and(eq(consoleMessages.id, alert.id), isNull(consoleMessages.seenAt)));
  }
  if (alert.topic === PLAN_REVIEW_TOPIC && alert.planId) {
    await db.update(plans).set({ needsReview: false, updatedAt: opts.at }).where(eq(plans.id, alert.planId));
  }
  return alert;
}

/** Saves a flag for the founders and raises its alert. */
export async function saveFlag(db: Db, testerId: string, kind: string, detail: string): Promise<Flag> {
  const [flag] = await db.insert(flags).values({ testerId, kind, detail }).returning();
  await raiseAlert(db, { testerId, topic: kind, key: `flag:${flag!.id}`, body: detail, at: flag!.createdAt });
  return flag!;
}
