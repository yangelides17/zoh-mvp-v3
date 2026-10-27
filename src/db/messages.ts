import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { messages, type Message, type NewMessage } from "./schema.js";

/** Inserts an inbound message; returns null if this Sendblue handle was already stored (a retry). */
export async function insertInboundOnce(db: Db, row: Omit<NewMessage, "direction">): Promise<Message | null> {
  const inserted = await db
    .insert(messages)
    .values({ ...row, direction: "inbound" })
    .onConflictDoNothing({ target: messages.sendblueHandle })
    .returning();
  return inserted[0] ?? null;
}

export async function insertOutbound(db: Db, row: Omit<NewMessage, "direction">): Promise<Message> {
  const inserted = await db
    .insert(messages)
    .values({ ...row, direction: "outbound" })
    .returning();
  const message = inserted[0];
  if (!message) throw new Error("insertOutbound returned no row");
  return message;
}

export async function updateMessage(
  db: Db,
  id: string,
  patch: Partial<Pick<NewMessage, "mediaKey" | "mediaContentType" | "transcript" | "status" | "error">>,
): Promise<void> {
  await db
    .update(messages)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(messages.id, id));
}

/** Shallow-merges keys into the message's timings JSON. */
export async function mergeTimings(db: Db, id: string, timings: Record<string, string | number>): Promise<void> {
  await db
    .update(messages)
    .set({
      timings: sql`${messages.timings} || ${JSON.stringify(timings)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(messages.id, id));
}

/** Applies a Sendblue status update to one of our outbound messages. Returns rows updated. */
export async function updateStatusByHandle(
  db: Db,
  handle: string,
  status: string,
  error: string | null,
): Promise<number> {
  const updated = await db
    .update(messages)
    .set({ status, ...(error ? { error } : {}), updatedAt: new Date() })
    .where(eq(messages.sendblueHandle, handle))
    .returning({ id: messages.id });
  return updated.length;
}

/** The latest messages with one contact, oldest first; none from before `since` (the tester's context start). */
export async function recentConversation(
  db: Db,
  contactNumber: string,
  limit: number,
  since?: Date,
): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(eq(messages.contactNumber, contactNumber), since ? gte(messages.createdAt, since) : undefined),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

export async function getMessage(db: Db, id: string): Promise<Message | undefined> {
  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  return rows[0];
}
