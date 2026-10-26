import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Bare-bones schema: one table logging every text in and out.
 * Testers, goals, plans, steps and the coach's memory get designed later.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    /** The person's number (E.164). */
    contactNumber: text("contact_number").notNull(),
    /** Our Sendblue line (E.164). */
    lineNumber: text("line_number"),
    content: text("content"),
    /** Sendblue's CDN link; it expires after 30 days. */
    mediaUrl: text("media_url"),
    /** Our private copy in the bucket. */
    mediaKey: text("media_key"),
    mediaContentType: text("media_content_type"),
    /** Voice-note transcript from Speaches. */
    transcript: text("transcript"),
    /** Sendblue's message handle: dedupes webhook retries and links status updates. */
    sendblueHandle: text("sendblue_handle").unique(),
    service: text("service"),
    status: text("status"),
    error: text("error"),
    inReplyTo: uuid("in_reply_to").references((): AnyPgColumn => messages.id),
    /** When Sendblue says the message was sent/received. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Per-stage timestamps and durations for latency tracking. */
    timings: jsonb("timings").$type<Record<string, string | number>>().notNull().default({}),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_contact_created_idx").on(t.contactNumber, t.createdAt),
    check("messages_direction_check", sql`${t.direction} in ('inbound', 'outbound')`),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
