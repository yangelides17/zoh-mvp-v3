import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { consoleMessages, type ConsoleMessage, type Tester } from "../db/schema.js";

/**
 * What the founders send through the console chat (spec: GitHub issue "Founder console", 4 and
 * "Shared": Founders → coach). A note is context the texting coach reads and never quotes; a
 * request is something to reach the tester, in ZOH's words or (exact) word for word. Requests go
 * pending → done (the coach carried it), sent (the exact text went out) or cancelled.
 */

/** Notes the texting coach reads: the newest this many, from the last `NOTE_DAYS` days. */
export const NOTES_SHOWN = 10;
export const NOTE_DAYS = 30;
/** The console coach's name on its lines in the thread. */
export const COACH_AUTHOR = "zoh";
/** The app's own lines in the thread ("Done", "Queued word for word"): updates, not the coach's answers. */
export const APP_AUTHOR = "app";

/** How the coaches name a request: the first 8 characters of its id. */
export const requestRef = (id: string) => id.slice(0, 8);

export const findRequest = (list: ConsoleMessage[], ref: string): ConsoleMessage | undefined => {
  const wanted = ref.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return wanted.length >= 8 ? list.find((m) => m.id.startsWith(wanted)) : undefined;
};

/** One line in a tester's console thread. */
export async function addThreadLine(
  db: Db,
  line: { testerId: string; kind: "founder" | "coach" | "note"; author: string; body: string; at: Date },
): Promise<ConsoleMessage> {
  const [row] = await db
    .insert(consoleMessages)
    .values({ testerId: line.testerId, kind: line.kind, author: line.author, body: line.body, createdAt: line.at })
    .returning();
  return row!;
}

export async function addRequest(
  db: Db,
  opts: { testerId: string; author: string; body: string; exact: boolean; sendNow: boolean; dueAt?: Date; at: Date; status?: "pending" | "cancelled" },
): Promise<ConsoleMessage> {
  const [row] = await db
    .insert(consoleMessages)
    .values({
      testerId: opts.testerId,
      kind: "request",
      author: opts.author,
      body: opts.body,
      requestStatus: opts.status ?? "pending",
      exact: opts.exact,
      sendNow: opts.sendNow,
      dueAt: opts.dueAt,
      doneAt: opts.status === "cancelled" ? opts.at : undefined,
      createdAt: opts.at,
    })
    .returning();
  return row!;
}

/** Cancels a pending request; undefined when it isn't this tester's or isn't pending any more. */
export async function cancelRequest(db: Db, opts: { testerId: string; requestId: string; at: Date }): Promise<ConsoleMessage | undefined> {
  const [row] = await db
    .update(consoleMessages)
    .set({ requestStatus: "cancelled", doneAt: opts.at })
    .where(
      and(
        eq(consoleMessages.id, opts.requestId),
        eq(consoleMessages.testerId, opts.testerId),
        eq(consoleMessages.kind, "request"),
        eq(consoleMessages.requestStatus, "pending"),
      ),
    )
    .returning();
  return row;
}

/**
 * Closes a pending request (done when the coach carried it, sent for an exact text) and says so in
 * the thread. Only the first close counts; undefined if it was already closed.
 */
export async function closeRequest(
  db: Db,
  opts: { request: ConsoleMessage; status: "done" | "sent"; at: Date; messageId?: string; line: string },
): Promise<ConsoleMessage | undefined> {
  const [row] = await db
    .update(consoleMessages)
    .set({ requestStatus: opts.status, doneAt: opts.at, messageId: opts.messageId })
    .where(and(eq(consoleMessages.id, opts.request.id), eq(consoleMessages.requestStatus, "pending")))
    .returning();
  if (row) await addThreadLine(db, { testerId: row.testerId, kind: "coach", author: APP_AUTHOR, body: opts.line, at: opts.at });
  return row;
}

/** Times in the thread show in the founders' zone (as the console's pages do). */
export function founderTime(at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
}

/** The thread's line when a request is carried: "Done (in a reply, Thu 9:02 AM): …". */
export function doneLine(body: string, how: string, at: Date): string {
  const short = body.length > 120 ? `${body.slice(0, 117)}...` : body;
  return `Done (${how}, ${founderTime(at)}): ${short}`;
}

/** Pending requests for the coach to carry in its own words, due by `now`, oldest first. */
export async function pendingRequests(db: Db, testerId: string, now: Date): Promise<ConsoleMessage[]> {
  return db
    .select()
    .from(consoleMessages)
    .where(
      and(
        eq(consoleMessages.testerId, testerId),
        eq(consoleMessages.kind, "request"),
        eq(consoleMessages.requestStatus, "pending"),
        eq(consoleMessages.exact, false),
        or(isNull(consoleMessages.dueAt), lte(consoleMessages.dueAt, now)),
      ),
    )
    .orderBy(asc(consoleMessages.createdAt));
}

/** Pending "send exactly this" texts due by `now`, oldest first: the nudge tick sends them. */
export async function pendingExact(db: Db, testerId: string, now: Date): Promise<ConsoleMessage[]> {
  return db
    .select()
    .from(consoleMessages)
    .where(
      and(
        eq(consoleMessages.testerId, testerId),
        eq(consoleMessages.kind, "request"),
        eq(consoleMessages.requestStatus, "pending"),
        eq(consoleMessages.exact, true),
        or(isNull(consoleMessages.dueAt), lte(consoleMessages.dueAt, now)),
      ),
    )
    .orderBy(asc(consoleMessages.createdAt));
}

/** Every request still pending, due or not (what the console coach can cancel), oldest first. */
export async function openRequests(db: Db, testerId: string): Promise<ConsoleMessage[]> {
  return db
    .select()
    .from(consoleMessages)
    .where(and(eq(consoleMessages.testerId, testerId), eq(consoleMessages.kind, "request"), eq(consoleMessages.requestStatus, "pending")))
    .orderBy(asc(consoleMessages.createdAt));
}

/** The founders' notes the texting coach reads (rule 3: remembered, never quoted), oldest first. */
export async function notesForCoach(db: Db, tester: Pick<Tester, "id" | "contextStartedAt">, now: Date): Promise<ConsoleMessage[]> {
  const since = new Date(Math.max(tester.contextStartedAt.getTime(), now.getTime() - NOTE_DAYS * 86_400_000));
  const rows = await db
    .select()
    .from(consoleMessages)
    .where(and(eq(consoleMessages.testerId, tester.id), eq(consoleMessages.kind, "note"), gte(consoleMessages.createdAt, since)))
    .orderBy(desc(consoleMessages.createdAt))
    .limit(NOTES_SHOWN);
  return rows.reverse();
}
