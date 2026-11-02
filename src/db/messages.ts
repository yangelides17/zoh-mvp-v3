import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { messages, type Message, type NewMessage } from "./schema.js";

/**
 * Inserts an inbound message; returns null if this Sendblue handle was already stored (a retry).
 * Stamped after everything already stored for this contact (#57), so a text never ties with the reply before it.
 */
export async function insertInboundOnce(db: Db, row: Omit<NewMessage, "direction">): Promise<Message | null> {
  const createdAt =
    row.createdAt ??
    sql<Date>`greatest(now(), (select max(${messages.createdAt}) + interval '1 microsecond' from ${messages} where ${messages.contactNumber} = ${row.contactNumber}))`;
  const inserted = await db
    .insert(messages)
    .values({ ...row, createdAt, direction: "inbound" })
    .onConflictDoNothing({ target: messages.sendblueHandle })
    .returning();
  return inserted[0] ?? null;
}

/**
 * Inserts one of our texts. A reply is never stamped before the text it answers (#57): inbound
 * times come from the database (microseconds), ours from the app's clock (milliseconds), so a
 * reply saved in the same millisecond would otherwise sort ahead of its text.
 */
export async function insertOutbound(db: Db, row: Omit<NewMessage, "direction">): Promise<Message> {
  const at = row.createdAt ?? new Date();
  const createdAt = row.inReplyTo
    ? sql<Date>`greatest(${at.toISOString()}::timestamptz, (select ${messages.createdAt} + interval '1 microsecond' from ${messages} where ${messages.id} = ${row.inReplyTo}))`
    : at;
  const inserted = await db
    .insert(messages)
    .values({ ...row, createdAt, direction: "outbound" })
    .returning();
  const message = inserted[0];
  if (!message) throw new Error("insertOutbound returned no row");
  return message;
}

export async function updateMessage(
  db: Db,
  id: string,
  patch: Partial<Pick<NewMessage, "mediaKey" | "mediaContentType" | "transcript" | "description" | "status" | "error">>,
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
