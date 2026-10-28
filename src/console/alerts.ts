import type { Db } from "../db/client.js";
import { consoleMessages, flags, type Flag } from "../db/schema.js";

/**
 * Alerts for the founder console (spec: GitHub issue "Founder console"). Each event has a key, so it
 * fires once however often its trigger runs. Stored only for now: nothing shows them yet.
 */
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

/** Saves a flag for the founders and raises its alert. */
export async function saveFlag(db: Db, testerId: string, kind: string, detail: string): Promise<Flag> {
  const [flag] = await db.insert(flags).values({ testerId, kind, detail }).returning();
  await raiseAlert(db, { testerId, topic: kind, key: `flag:${flag!.id}`, body: detail, at: flag!.createdAt });
  return flag!;
}
