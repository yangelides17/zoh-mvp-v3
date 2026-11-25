import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { raiseAlert } from "./alerts.js";
import { consoleMessages, type AnswerStatus, type ConsoleMessage, type RequestDelivery, type Tester } from "../db/schema.js";

/**
 * What the founders send through the console chat (spec: GitHub issue "Founder console", 4 and
 * "Shared": Founders → coach). A note is context the texting coach reads and never quotes; a
 * request is something to reach the tester, in ZOH's words or (exact) word for word. Requests go
 * pending → done (the coach carried it), sent (the exact text went out) or cancelled.
 */

/** Notes the texting coach reads: the newest this many, from the last `NOTE_DAYS` days. */
export const NOTES_SHOWN = 10;
export const NOTE_DAYS = 30;
/** #155: an alert for a founder text or request that couldn't go out (dropped, or the send failed). */
export const NOT_SENT_TOPIC = "not_sent";
/** The console coach's name on its lines in the thread. */
export const COACH_AUTHOR = "zoh";
/** The app's own lines in the thread ("Done", "Queued word for word"): updates, not the coach's answers. */
export const APP_AUTHOR = "app";

/**
 * The founders' latest line, while ZOH hasn't answered it yet. Only ZOH's own lines answer: the app's
 * ("Queued word for word", "Done") can land in between and must not swallow a question.
 */
export function awaitingAnswer(thread: ConsoleMessage[]): ConsoleMessage | undefined {
  const lastFounder = thread.findLast((m) => m.kind === "founder");
  const lastAnswer = thread.findLast((m) => m.kind === "coach" && m.author === COACH_AUTHOR);
  return lastFounder && !(lastAnswer && lastAnswer.createdAt >= lastFounder.createdAt) ? lastFounder : undefined;
}

/** How the coaches name a request: the first 8 characters of its id. */
export const requestRef = (id: string) => id.slice(0, 8);

export const findRequest = (list: ConsoleMessage[], ref: string): ConsoleMessage | undefined => {
  const wanted = ref.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return wanted.length >= 8 ? list.find((m) => m.id.startsWith(wanted)) : undefined;
};

/** One line in a tester's console thread. */
export async function addThreadLine(
  db: Db,
  line: { testerId: string; kind: "founder" | "coach" | "note"; author: string; body: string; at: Date; attachment?: { key: string; contentType: string; name: string } },
): Promise<ConsoleMessage> {
  const file = line.attachment ? { mediaKey: line.attachment.key, mediaContentType: line.attachment.contentType, mediaName: line.attachment.name } : {};
  const [row] = await db
    .insert(consoleMessages)
    .values({ testerId: line.testerId, kind: line.kind, author: line.author, body: line.body, createdAt: line.at, ...file })
    .returning();
  return row!;
}

export async function addRequest(
  db: Db,
  opts: {
    testerId: string;
    author: string;
    body: string;
    exact: boolean;
    sendNow: boolean;
    dueAt?: Date;
    delivery?: RequestDelivery;
    expiresAt?: Date;
    at: Date;
    status?: "pending" | "cancelled";
    /** #169: a question whose answer comes back to the founders (an alert unless `alertOnAnswer` is false). */
    question?: boolean;
    alertOnAnswer?: boolean;
    /** #168: a founder's file sent with it (word for word only), already on Sendblue's media host. */
    media?: { key: string; contentType: string; name: string; account: string; partial: boolean; sendblueUrl: string };
  },
): Promise<ConsoleMessage> {
  const [row] = await db
    .insert(consoleMessages)
    .values({
      testerId: opts.testerId,
      question: opts.question ?? false,
      alertOnAnswer: opts.alertOnAnswer ?? true,
      ...(opts.media
        ? {
            mediaKey: opts.media.key,
            mediaContentType: opts.media.contentType,
            mediaName: opts.media.name,
            mediaAccount: opts.media.account,
            mediaPartial: opts.media.partial,
            sendblueMediaUrl: opts.media.sendblueUrl,
          }
        : {}),
      kind: "request",
      author: opts.author,
      body: opts.body,
      requestStatus: opts.status ?? "pending",
      exact: opts.exact,
      sendNow: opts.sendNow,
      dueAt: opts.dueAt,
      delivery: opts.delivery ?? "natural",
      expiresAt: opts.expiresAt,
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
 * #155: claims a pending request for the text going out now, so a cancel can't race it (Cancel only
 * takes pending ones). False when it's no longer pending (cancelled, or another tick has it).
 */
export async function claimRequest(db: Db, requestId: string, at: Date): Promise<boolean> {
  const rows = await db
    .update(consoleMessages)
    .set({ requestStatus: "sending", claimedAt: at })
    .where(and(eq(consoleMessages.id, requestId), eq(consoleMessages.requestStatus, "pending")))
    .returning({ id: consoleMessages.id });
  return rows.length > 0;
}

/** The request a text being written now carries: pending or claimed for it, this tester's only. */
export async function claimedRequest(db: Db, testerId: string, requestId: string): Promise<ConsoleMessage[]> {
  return db
    .select()
    .from(consoleMessages)
    .where(
      and(
        eq(consoleMessages.id, requestId),
        eq(consoleMessages.testerId, testerId),
        eq(consoleMessages.kind, "request"),
        inArray(consoleMessages.requestStatus, ["pending", "sending"]),
      ),
    );
}

/** Hands a claimed request back when its text didn't go out after all (skipped, held, a retry). */
export async function releaseRequest(db: Db, requestId: string): Promise<void> {
  await db
    .update(consoleMessages)
    .set({ requestStatus: "pending" })
    .where(and(eq(consoleMessages.id, requestId), eq(consoleMessages.requestStatus, "sending")));
}

/**
 * Closes a pending or claimed request (done when the coach carried it, sent for an exact text) and
 * says so in the thread. Only the first close counts; undefined if it was already closed.
 */
export async function closeRequest(
  db: Db,
  opts: { request: ConsoleMessage; status: "done" | "sent"; at: Date; messageId?: string; line: string },
): Promise<ConsoleMessage | undefined> {
  const [row] = await db
    .update(consoleMessages)
    .set({ requestStatus: opts.status, doneAt: opts.at, messageId: opts.messageId })
    .where(and(eq(consoleMessages.id, opts.request.id), inArray(consoleMessages.requestStatus, ["pending", "sending"])))
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

/** What a reply may carry: a natural request, or a manual nudge that's due (they're mid-conversation, so it goes in the reply). */
export const REPLY_CARRIES: readonly RequestDelivery[] = ["natural", "own_text"];
/** What the morning text may carry. */
export const MORNING_CARRIES: readonly RequestDelivery[] = ["natural", "morning"];

/** Pending requests for the coach to carry in its own words, due by `now` and not expired, oldest first. */
export async function pendingRequests(db: Db, testerId: string, now: Date, deliveries: readonly RequestDelivery[]): Promise<ConsoleMessage[]> {
  return db
    .select()
    .from(consoleMessages)
    .where(
      and(
        eq(consoleMessages.testerId, testerId),
        eq(consoleMessages.kind, "request"),
        eq(consoleMessages.requestStatus, "pending"),
        eq(consoleMessages.exact, false),
        inArray(consoleMessages.delivery, [...deliveries]),
        or(isNull(consoleMessages.dueAt), lte(consoleMessages.dueAt, now)),
        or(isNull(consoleMessages.expiresAt), gt(consoleMessages.expiresAt, now)),
      ),
    )
    .orderBy(asc(consoleMessages.createdAt));
}

/**
 * Drops pending requests whose too-late-after time has passed (never sent late) and says so in
 * the thread, with what stood in the way. Returns how many it dropped.
 */
export async function expireRequests(db: Db, tester: Tester, now: Date, blockedBy: string): Promise<number> {
  const rows = await db
    .update(consoleMessages)
    .set({ requestStatus: "cancelled", doneAt: now })
    .where(
      and(
        eq(consoleMessages.testerId, tester.id),
        eq(consoleMessages.kind, "request"),
        eq(consoleMessages.requestStatus, "pending"),
        lte(consoleMessages.expiresAt, now),
      ),
    )
    .returning();
  for (const r of rows) {
    const short = r.body.length > 100 ? `${r.body.slice(0, 97)}...` : r.body;
    await addThreadLine(db, { testerId: tester.id, kind: "coach", author: APP_AUTHOR, body: `Didn't go out in time (${blockedBy}), so I dropped it: ${short}`, at: now });
    // #155: what couldn't go out is worth a founder's look.
    await raiseAlert(db, { testerId: tester.id, topic: NOT_SENT_TOPIC, key: `not_sent:${r.id}`, body: `Didn't go out (${blockedBy}): ${short}`, at: now });
  }
  return rows.length;
}

/** #188: a send takes well under a minute; a request claimed longer ago than this was left by a crash. */
export const STUCK_SENDING_MS = 15 * 60_000;

/**
 * #188: cancels requests left "sending" by a crash or an error before the send finished, and says so
 * in the thread with a not-sent alert. Never retried: the text may already have reached the tester.
 */
export async function cancelStuckRequests(db: Db, tester: Tester, now: Date): Promise<number> {
  const rows = await db
    .update(consoleMessages)
    .set({ requestStatus: "cancelled", doneAt: now })
    .where(
      and(
        eq(consoleMessages.testerId, tester.id),
        eq(consoleMessages.kind, "request"),
        eq(consoleMessages.requestStatus, "sending"),
        // Claimed before claimedAt was recorded: no send runs across a deploy, so it's stuck too.
        or(isNull(consoleMessages.claimedAt), lte(consoleMessages.claimedAt, new Date(now.getTime() - STUCK_SENDING_MS))),
      ),
    )
    .returning();
  for (const r of rows) {
    const short = r.body.length > 100 ? `${r.body.slice(0, 97)}...` : r.body;
    await addThreadLine(db, { testerId: tester.id, kind: "coach", author: APP_AUTHOR, body: `May not have gone out (the app stopped while sending it): check their messages and resend if needed: ${short}`, at: now });
    await raiseAlert(db, { testerId: tester.id, topic: NOT_SENT_TOPIC, key: `not_sent:${r.id}`, body: `May not have gone out: check their thread and resend if needed: ${short}`, at: now });
  }
  return rows.length;
}

/**
 * Requests the reply being written has claimed (#169): by this draft (a reply's rounds share one `now`) or by
 * an earlier draft of the same reply that was dropped (`ids`). Still shown, so the text that carries one doesn't
 * drop it once it's off the pending list. They close only once the reply is sent.
 */
export async function requestsClaimed(db: Db, testerId: string, opts: { at: Date[]; ids?: readonly string[] }): Promise<ConsoleMessage[]> {
  const ids = opts.ids ?? [];
  if (!opts.at.length && !ids.length) return [];
  return db
    .select()
    .from(consoleMessages)
    .where(
      and(
        eq(consoleMessages.testerId, testerId),
        eq(consoleMessages.kind, "request"),
        eq(consoleMessages.requestStatus, "sending"),
        or(...(opts.at.length ? [inArray(consoleMessages.claimedAt, opts.at)] : []), ...(ids.length ? [inArray(consoleMessages.id, [...ids])] : [])),
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
        or(isNull(consoleMessages.expiresAt), gt(consoleMessages.expiresAt, now)),
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
    // #158: a note made lasting (moved into guidance) is done, and read only as guidance from then on.
    .where(and(eq(consoleMessages.testerId, tester.id), eq(consoleMessages.kind, "note"), isNull(consoleMessages.doneAt), gte(consoleMessages.createdAt, since)))
    .orderBy(desc(consoleMessages.createdAt))
    .limit(NOTES_SHOWN);
  return rows.reverse();
}

/** #169: how long ZOH listens for the answer to a team question it asked (a dodge included). */
export const LISTEN_DAYS = 7;
/** #169: no answer this long after ZOH asked: the founders hear so (once). */
export const NO_ANSWER_MS = 24 * 3_600_000;
/** #169: the alert with their answer, and the one for no answer or talking past it (each once per question). */
export const ANSWER_ALERT = "question_answer";
export const UNANSWERED_ALERT = "question_unanswered";

/**
 * #169: team questions ZOH asked and is still listening for: asked (sent) in the last `LISTEN_DAYS` days, since
 * their context started, not answered yet (a dodge still listens). None once they've stopped. Oldest first.
 */
export async function listeningQuestions(db: Db, tester: Pick<Tester, "id" | "contextStartedAt" | "stoppedAt">, now: Date): Promise<ConsoleMessage[]> {
  if (tester.stoppedAt) return [];
  const since = new Date(Math.max(tester.contextStartedAt.getTime(), now.getTime() - LISTEN_DAYS * 86_400_000));
  return db
    .select()
    .from(consoleMessages)
    .where(
      and(
        eq(consoleMessages.testerId, tester.id),
        eq(consoleMessages.kind, "request"),
        eq(consoleMessages.question, true),
        eq(consoleMessages.requestStatus, "done"),
        gte(consoleMessages.doneAt, since),
        or(isNull(consoleMessages.answerStatus), ne(consoleMessages.answerStatus, "answered")),
      ),
    )
    .orderBy(asc(consoleMessages.doneAt));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * #169: records what came of a question ZOH asked: their answer (close to their words), or that they talked past
 * it. Saved either way, with a line in the thread; the founders get an alert unless they switched it off. An
 * answer after a dodge or a no-answer alert still counts. False when it was already answered.
 */
export async function recordAnswer(
  db: Db,
  opts: { question: ConsoleMessage; status: AnswerStatus; answer?: string; name: string | null; at: Date },
): Promise<boolean> {
  const q = opts.question;
  // The answer, its thread line and its alert land together: a failed alert can't leave the answer saved with no
  // alert (a retry would find it already answered and raise nothing).
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(consoleMessages)
      .set({ answerStatus: opts.status, answer: opts.answer ?? null, answeredAt: opts.at })
      .where(and(eq(consoleMessages.id, q.id), or(isNull(consoleMessages.answerStatus), ne(consoleMessages.answerStatus, "answered"))))
      .returning();
    if (!row) return false;
    const who = opts.name ?? "They";
    const asked = clip(q.body, 120);
    const body = opts.status === "answered" ? `${who} answered "${asked}": ${opts.answer}` : `${who} talked past "${asked}" (ZOH won't ask again)`;
    await addThreadLine(tx, { testerId: q.testerId, kind: "coach", author: APP_AUTHOR, body, at: opts.at });
    if (q.alertOnAnswer) {
      const topic = opts.status === "answered" ? ANSWER_ALERT : UNANSWERED_ALERT;
      await raiseAlert(tx, { testerId: q.testerId, topic, key: `${topic}:${q.id}`, body, at: opts.at });
    }
    return true;
  });
}

/** #169: one alert per question still unanswered `NO_ANSWER_MS` after ZOH asked it (none once they've stopped). */
export async function alertUnanswered(db: Db, tester: Tester, now: Date): Promise<void> {
  for (const q of await listeningQuestions(db, tester, now)) {
    if (!q.alertOnAnswer || q.answerStatus || !q.doneAt || now.getTime() - q.doneAt.getTime() < NO_ANSWER_MS) continue;
    await raiseAlert(db, {
      testerId: tester.id,
      topic: UNANSWERED_ALERT,
      key: `${UNANSWERED_ALERT}:${q.id}`,
      body: `No answer yet from ${tester.name ?? "them"} (asked ${founderTime(q.doneAt)}): "${clip(q.body, 120)}"`,
      at: now,
    });
  }
}
