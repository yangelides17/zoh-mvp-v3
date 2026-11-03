import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { DraftDroppedError, NoReplyTextError, type DroppedDraft, type Turn, type Replier } from "../claude/replier.js";
import { ReplyLines, type PendingText, type PreparedMedia, type ReplyLine } from "./conversation.js";
import { COACH_HISTORY_CAP } from "../coach/coach.js";
import type { Db } from "../db/client.js";
import { insertOutbound, mergeTimings, updateMessage } from "../db/messages.js";
import { coachHistory } from "../memory/context.js";
import { messages, type Message, type Tester } from "../db/schema.js";
import { prepareImageForClaude, type ClaudeImage } from "../media/images.js";
import type { MediaDescriber } from "../memory/describe.js";
import { extensionOf, mediaKind, type MediaFetcher, type MediaStore } from "../media/storage.js";
import type { SendblueClient } from "../sendblue/client.js";
import type { Transcriber } from "../transcription/speaches.js";
import { safeError } from "../errors.js";
import { alertFailure, alertTextedAfterStop } from "../console/alerts.js";
import { devCommandOffReply, isJumpText, isOptOutText, isResetText, OPT_OUT_CONFIRMATION, optOut } from "../testers/commands.js";
import { jumpSettled, onTesterClock, testerNow } from "../testers/clock.js";
import { getOrCreateTester, getTester, resetTester, updateTester } from "../testers/testers.js";
import { envReply, ownsNumber, type AppEnv, type BuildInfo, type Routing } from "../testers/env.js";

export type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error" | "debug">;

/** Sent when Claude has nothing to say even after a retry, or isn't configured. */
export const FALLBACK_REPLY = "Got it";

/** Sent when the reply still fails after every retry (Claude down, timeouts, an app error). */
export const SYSTEM_DOWN_REPLY =
  "We're very sorry, the system is down at the moment and our team is on it. Please give us some time to fix it and come back later.";

/** Waits before each retry of a failed reply; its length is the number of retries. */
export const RETRY_DELAYS_MS = [2_000, 5_000];

export interface PipelineDeps {
  db: Db;
  log: Logger;
  allowedNumbers: string[];
  /** Dev accounts: test users who can text "reset". */
  devNumbers: string[];
  /** Whether dev accounts' "reset" and "jump" work here (DEV_COMMANDS); on when missing (tests, the eval). */
  devCommands?: boolean;
  /** Staging and production (#82): which app this is; production when missing. */
  appEnv?: AppEnv;
  /** The release and commit this app runs, for "env". */
  build?: BuildInfo;
  typingIndicator: boolean;
  sendblue?: SendblueClient;
  /** The coach (src/coach); missing when ANTHROPIC_API_KEY isn't set. */
  replier?: Replier;
  media?: MediaStore;
  transcriber?: Transcriber;
  fetchMedia: MediaFetcher;
  /** Describes photos as they arrive, for coach memory; missing when Claude isn't configured. */
  describer?: MediaDescriber;
  now?: () => Date;
  /** Defaults to RETRY_DELAYS_MS; tests pass zeros. */
  retryDelaysMs?: number[];
  /** #16: every tester's reply line (one draft at a time, typing holds); the app makes one. */
  lines?: ReplyLines;
}

/** Lines for pipelines built without one (direct callers in tests): one per pipeline object. */
const defaultLines = new WeakMap<object, ReplyLines>();

/** The pipeline's reply lines (#16). */
export function linesOf(deps: PipelineDeps): ReplyLines {
  if (deps.lines) return deps.lines;
  let lines = defaultLines.get(deps);
  if (!lines) {
    lines = new ReplyLines();
    defaultLines.set(deps, lines);
  }
  return lines;
}

/**
 * Handles one stored inbound message: tester lookup and commands ("stop", "reset"),
 * typing indicator, media copy and transcription, a reply from the coach (or the fallback), then the send.
 */
export async function processInbound(deps: PipelineDeps, stored: Message): Promise<void> {
  const now = deps.now ?? (() => new Date());
  let inbound = stored;
  const { db, log } = deps;
  const ctx = { messageId: inbound.id, contact: maskNumber(inbound.contactNumber) };
  const started = now();
  const timings: Record<string, string | number> = { processing_started_at: started.toISOString() };
  const errors: string[] = [];

  if (!deps.allowedNumbers.includes(inbound.contactNumber)) {
    log.info(ctx, "Sender is not on ALLOWED_NUMBERS; stored without replying");
    await updateMessage(db, inbound.id, { status: "RECEIVED_NOT_ALLOWED" });
    return;
  }
  // #82: the webhook already drops the other app's texts; a switch that landed since then wins.
  if (!(await ownsNumber(db, routingOf(deps), inbound.contactNumber))) {
    log.info({ messageId: inbound.id }, "Number moved to the other app before the reply; not answering");
    await updateMessage(db, inbound.id, { status: "RECEIVED_OTHER_APP" });
    return;
  }

  // 0. Who's texting, and the commands that never depend on the model.
  const commands = await runCommands(deps, inbound);
  if (commands.handled) return;
  const tester = commands.tester;
  inbound = commands.inbound;

  if (!deps.sendblue) {
    log.warn(ctx, "Sendblue keys are not configured; cannot reply");
    return;
  }
  const sendblue = deps.sendblue;

  // 1. Typing bubble right away; don't wait on it.
  let typing: Promise<void> = Promise.resolve();
  if (deps.typingIndicator) {
    typing = sendblue.sendTypingIndicator(inbound.contactNumber, "start").then((ok) => {
      timings.typing_sent_at = now().toISOString();
      timings.typing_ok = ok ? 1 : 0;
    });
  }

  // 2. Media: keep a private copy; transcribe voice notes. Started now, so a draft waits for it rather than starting without it.
  const prepared: Promise<PreparedMedia | undefined> = inbound.mediaUrl
    ? handleMedia(deps, inbound, timings).catch((err: unknown) => {
        errors.push(`media: ${errorMessage(err)}`);
        log.error({ ...ctx, err: safeError(err) }, "Media handling failed");
        return undefined;
      })
    : Promise.resolve(undefined);

  // 3. #16: one reply at a time per tester. A draft already running for them is interrupted and answers this text too.
  const line = linesOf(deps).line(inbound.contactNumber);
  line.pending.push({ inbound, prepared, timings, errors, typing });
  if (line.running) {
    log.info(ctx, "They texted again before the reply went out; one reply will answer both");
    line.interrupt();
    return;
  }
  line.running = true;
  try {
    await answerLine(deps, line, tester, sendblue);
  } catch (err) {
    line.running = false;
    throw err;
  }
}

/** The tester's own clock for stamping and the coach: real time, unless a dev account has jumped ahead (#14). */
function clockFor(deps: PipelineDeps, tester: Tester): () => Date {
  const now = deps.now ?? (() => new Date());
  return () => testerNow(tester, now());
}

/**
 * #16: writes and sends replies for a tester until no text is waiting. Each round takes every
 * text that has arrived, drafts one reply to all of them, holds it while they're typing, then
 * sends. A text that lands before the send drops the draft (what it did is handed on) and the
 * next round answers everything together. "stop" and "reset" drop it with nothing sent.
 */
async function answerLine(deps: PipelineDeps, line: ReplyLine, first: Tester, sendblue: SendblueClient): Promise<void> {
  const { db, log } = deps;
  const lines = linesOf(deps);
  let batch: PendingText[] = [];
  let dropped: DroppedDraft = { actions: [] };
  let draftsDropped = 0;
  for (;;) {
    if (line.cancelled) {
      for (const p of [...batch, ...line.cancelledPending.splice(0)]) {
        await mergeTimings(db, p.inbound.id, { ...p.timings, reply_dropped: "stop_or_reset" });
        await updateMessage(db, p.inbound.id, { status: "REPLY_DROPPED", error: null });
      }
      batch = [];
      dropped = { actions: [] };
      draftsDropped = 0;
      line.cancelled = false;
    }
    batch.push(...line.pending.splice(0));
    if (batch.length === 0) {
      // Synchronously, so a text arriving next starts its own round rather than waiting on this one.
      line.running = false;
      return;
    }
    const signal = line.startDraft();
    const latest = batch.at(-1)!;
    const ctx = { messageId: latest.inbound.id, contact: maskNumber(latest.inbound.contactNumber) };
    const media = await Promise.all(batch.map((p) => p.prepared));
    if (line.interrupted) continue;
    // Fresh each round: a dropped draft may already have saved answers or moved them on.
    const tester = (await getTester(db, first.id)) ?? first;
    const outcome = await draftReply(deps, line, tester, batch, media, dropped, signal);
    if (outcome.kind === "dropped") {
      dropped = { actions: [...dropped.actions, ...outcome.draft.actions], ...((outcome.draft.text ?? dropped.text) ? { text: outcome.draft.text ?? dropped.text } : {}) };
      draftsDropped++;
      log.info({ ...ctx, actions: outcome.draft.actions.length }, "Draft dropped: they texted again before it was sent");
      continue;
    }
    await waitBeforeSend(lines, line, latest, log, ctx);
    if (line.cancelled) continue;
    if (line.interrupted || line.pending.length) {
      // #132: what it saved stays saved; the redraft is told it and the unsent words, so it doesn't redo them.
      dropped = { actions: [...dropped.actions, ...outcome.actions], text: outcome.text };
      draftsDropped++;
      log.info({ ...ctx, actions: outcome.actions.length }, "Draft dropped before sending: they texted again");
      continue;
    }
    if (draftsDropped) latest.timings.drafts_dropped = draftsDropped;
    if (batch.length > 1) latest.timings.texts_answered = batch.length;
    await sendReply(deps, tester, sendblue, batch, media, outcome.text);
    batch = [];
    dropped = { actions: [] };
    draftsDropped = 0;
  }
}

/** A finished draft carries the actions it took (#132), handed on if it's dropped before sending. */
type DraftOutcome = { kind: "text"; text: string; actions: string[] } | { kind: "dropped"; draft: DroppedDraft };

/**
 * The reply text from the coach, or the fallback, with retries. Before the plan locks it reads the
 * whole conversation; after, two days plus memory. Interrupted (#16), it returns what the draft did instead.
 */
async function draftReply(
  deps: PipelineDeps,
  line: ReplyLine,
  tester: Tester,
  batch: PendingText[],
  media: (PreparedMedia | undefined)[],
  dropped: DroppedDraft,
  signal: AbortSignal,
): Promise<DraftOutcome> {
  const { db, log } = deps;
  const now = deps.now ?? (() => new Date());
  const clock = clockFor(deps, tester);
  const latest = batch.at(-1)!;
  const { timings, errors } = latest;
  const ctx = { messageId: latest.inbound.id, contact: maskNumber(latest.inbound.contactNumber) };
  if (!deps.replier) {
    errors.push("claude: ANTHROPIC_API_KEY not configured");
    return { kind: "text", text: FALLBACK_REPLY, actions: [] };
  }
  const replier = deps.replier;
  const interrupted = () => line.interrupted || line.cancelled;
  const current = new Map(batch.map((p, i) => [p.inbound.id, media[i] ?? {}]));
  const handedOn = dropped.actions.length || dropped.text ? dropped : undefined;
  const claudeStart = now();
  /** Actions finished by this draft's attempts, so far. */
  const actions: string[] = [];
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  let replyText = FALLBACK_REPLY;
  let emptyRetried = false;
  let failures = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      // Reloaded each attempt: a failed attempt may already have saved answers or moved the tester on.
      const fresh = (attempt > 1 && (await getTester(db, tester.id))) || tester;
      const history = await coachHistory(db, fresh, clock(), COACH_HISTORY_CAP);
      const turns = toTurns(history, current);
      replyText = await replier.reply({
        tester: fresh,
        turns,
        now: clock(),
        messageId: latest.inbound.id,
        interrupted,
        signal,
        onAction: (a) => actions.push(a),
        ...(handedOn ? { dropped: handedOn } : {}),
        onUsage: (u) => {
          timings.claude_input_tokens = Number(timings.claude_input_tokens ?? 0) + u.input;
          timings.claude_cache_read_tokens = Number(timings.claude_cache_read_tokens ?? 0) + u.cacheRead;
          timings.claude_cache_write_tokens = Number(timings.claude_cache_write_tokens ?? 0) + u.cacheWrite;
          timings.claude_output_tokens = Number(timings.claude_output_tokens ?? 0) + u.output;
        },
      });
      break;
    } catch (err) {
      if (err instanceof DraftDroppedError) return { kind: "dropped", draft: err.draft };
      // Failed while they texted again: the next round tries with everything.
      if (interrupted()) return { kind: "dropped", draft: { actions: [] } };
      errors.push(`claude (attempt ${attempt}): ${errorMessage(err)}`);
      if (err instanceof NoReplyTextError) {
        // Nothing to say: once more, then treat it as a text that needed no real answer.
        if (!emptyRetried) {
          emptyRetried = true;
          log.warn({ ...ctx, err: safeError(err) }, "Claude returned no text; retrying");
          continue;
        }
        replyText = FALLBACK_REPLY;
        log.warn({ ...ctx, err: safeError(err) }, "Claude returned no text again; sending fallback");
        break;
      }
      const delay = delays[failures++];
      if (delay === undefined) {
        replyText = SYSTEM_DOWN_REPLY;
        log.error({ ...ctx, err: safeError(err) }, "Claude reply failed after retries; sending the system-down reply");
        await alertFailure(db, tester.id, `The coach failed after retries; they got the system-down reply (${errorMessage(err).slice(0, 120)})`, now());
        break;
      }
      log.error({ ...ctx, err: safeError(err) }, "Claude reply failed; retrying");
      // A typing signal also wakes the line: keep waiting out the delay unless they actually texted (or stopped).
      const retryAt = Date.now() + delay;
      while (!interrupted() && Date.now() < retryAt) await line.wait(retryAt - Date.now());
      if (interrupted()) return { kind: "dropped", draft: { actions: [] } };
    }
  }
  timings.claude_ms = now().getTime() - claudeStart.getTime();
  return { kind: "text", text: replyText, actions };
}

/**
 * #132: before a ready reply goes out it waits a short grace for a late typing signal or another
 * text. Typing turns it into #16's hold; a hold that ends because they stopped typing gets one more
 * grace (a "stopped" often lands just before their text); a hold at the cap sends at once. A text or
 * "stop" ends the wait and the caller drops the draft. Bounded: each extra grace follows a new hold,
 * and each hold needs a fresh typing signal and is capped.
 */
async function waitBeforeSend(
  lines: ReplyLines,
  line: ReplyLine,
  latest: PendingText,
  log: Logger,
  ctx: Record<string, unknown>,
): Promise<void> {
  const phone = latest.inbound.contactNumber;
  const timings = latest.timings;
  let graceDue = true;
  for (;;) {
    if (line.cancelled || line.interrupted || line.pending.length) return;
    if (graceDue) {
      graceDue = false;
      const grace = await graceBeforeSend(lines, line, phone);
      if (grace) {
        timings.grace_ms = Number(timings.grace_ms ?? 0) + grace.ms;
        timings.graces = Number(timings.graces ?? 0) + 1;
        timings.grace_ended = grace.ended;
        // Temporary, for the live checks of the grace (#118 removes it); the timings stay.
        log.info(
          { ...ctx, graceMs: grace.ms, startedAt: new Date(grace.start).toISOString(), endedAt: new Date(grace.start + grace.ms).toISOString(), ended: grace.ended },
          "Reply grace",
        );
        if (grace.ended !== "typing") continue;
      }
    }
    const hold = await holdForTyping(lines, line, phone);
    if (!hold) return;
    timings.hold_ms = Number(timings.hold_ms ?? 0) + hold.ms;
    timings.holds = Number(timings.holds ?? 0) + 1;
    timings.hold_ended = hold.ended;
    // Temporary, for the live checks of Sendblue's typing signals (#118 removes it).
    log.info({ ...ctx, heldMs: hold.ms, ended: hold.ended }, "Reply held while they typed");
    if (hold.ended === "cap") return;
    if (hold.ended === "stopped") graceDue = true;
  }
}

/**
 * #132: waits `graceMs` unless they text, start typing or say "stop" first. Off (0), or already
 * typing (straight to the hold): no grace.
 */
async function graceBeforeSend(
  lines: ReplyLines,
  line: ReplyLine,
  phone: string,
): Promise<{ start: number; ms: number; ended: "sent" | "text" | "typing" | "cancelled" } | undefined> {
  if (lines.graceMs <= 0 || lines.isTyping(phone)) return undefined;
  const start = lines.nowMs();
  const waited = () => lines.nowMs() - start;
  for (;;) {
    if (line.cancelled) return { start, ms: waited(), ended: "cancelled" };
    if (line.interrupted || line.pending.length) return { start, ms: waited(), ended: "text" };
    if (lines.isTyping(phone)) return { start, ms: waited(), ended: "typing" };
    const left = lines.graceMs - waited();
    if (left <= 0) return { start, ms: waited(), ended: "sent" };
    await line.wait(left);
  }
}

/**
 * #16: while they're typing, a ready reply waits for their text (a redraft), for them to stop
 * (send), or `holdMs` (send anyway). No fresh typing signal: no wait.
 */
async function holdForTyping(
  lines: ReplyLines,
  line: ReplyLine,
  phone: string,
): Promise<{ ms: number; ended: "text" | "stopped" | "cap" | "cancelled" } | undefined> {
  if (lines.holdMs <= 0 || !lines.isTyping(phone)) return undefined;
  const start = lines.nowMs();
  const held = () => lines.nowMs() - start;
  for (;;) {
    if (line.cancelled) return { ms: held(), ended: "cancelled" };
    if (line.interrupted || line.pending.length) return { ms: held(), ended: "text" };
    if (!lines.isTyping(phone)) return { ms: held(), ended: "stopped" };
    const left = lines.holdMs - held();
    if (left <= 0) return { ms: held(), ended: "cap" };
    await line.wait(left);
  }
}

/** Sends one reply for every text in the batch, records it against the latest, then files their media. */
async function sendReply(
  deps: PipelineDeps,
  tester: Tester,
  sendblue: SendblueClient,
  batch: PendingText[],
  media: (PreparedMedia | undefined)[],
  replyText: string,
): Promise<void> {
  const { db, log } = deps;
  const now = deps.now ?? (() => new Date());
  const clock = clockFor(deps, tester);
  const latest = batch.at(-1)!;
  const { inbound, timings, errors } = latest;
  const ctx = { messageId: inbound.id, contact: maskNumber(inbound.contactNumber) };

  // 4. Send and record the reply.
  await Promise.all(batch.map((p) => p.typing));
  try {
    const sent = await sendblue.sendMessage({ number: inbound.contactNumber, content: replyText });
    const realSentAt = now();
    const sentAt = testerNow(tester, realSentAt);
    timings.reply_sent_at = realSentAt.toISOString();
    if (inbound.sentAt) timings.received_to_reply_sent_ms = sentAt.getTime() - inbound.sentAt.getTime();
    const started = Date.parse(String(timings.processing_started_at));
    if (Number.isFinite(started)) timings.processing_ms = realSentAt.getTime() - started;
    await insertOutbound(db, {
      contactNumber: inbound.contactNumber,
      lineNumber: inbound.lineNumber,
      content: replyText,
      sendblueHandle: sent.messageHandle ?? null,
      status: sent.status ?? null,
      inReplyTo: inbound.id,
      sentAt,
      createdAt: onTesterClock(tester, sentAt),
      raw: sent.raw as object,
    });
  } catch (err) {
    errors.push(`send: ${errorMessage(err)}`);
    log.error({ ...ctx, err: safeError(err) }, "Sending the reply failed");
    await alertFailure(db, tester.id, `A reply didn't send (${errorMessage(err).slice(0, 120)})`, now());
    await insertOutbound(db, {
      contactNumber: inbound.contactNumber,
      lineNumber: inbound.lineNumber,
      content: replyText,
      status: "SEND_FAILED",
      error: errorMessage(err),
      inReplyTo: inbound.id,
      createdAt: onTesterClock(tester, clock()),
    });
    if (deps.typingIndicator) await sendblue.sendTypingIndicator(inbound.contactNumber, "stop");
  }

  // 5. Media into memory right away, after the reply so it never adds to the wait.
  for (const [i, p] of batch.entries()) {
    if (p.inbound.mediaUrl) await describeMedia(deps, p.inbound, media[i]?.image, p.timings);
  }

  for (const p of batch) {
    // Earlier texts in a burst point at the text whose reply answered them.
    if (p !== latest) p.timings.answered_with = inbound.id;
    await mergeTimings(db, p.inbound.id, p.timings);
    await updateMessage(db, p.inbound.id, {
      status: p.errors.length ? "REPLIED_WITH_ERRORS" : "REPLIED",
      error: p.errors.length ? p.errors.join("; ") : null,
    });
  }
  log.info({ ...ctx, timings, errors, texts: batch.length }, "Inbound message handled");
}

/**
 * Saves a one-line description of a photo (from Claude) or a video (its caption) so memory can
 * search it at once. Voice notes already have their transcript. Failures are logged, never sent.
 */
async function describeMedia(
  deps: PipelineDeps,
  inbound: Message,
  image: ClaudeImage | undefined,
  timings: Record<string, string | number>,
): Promise<void> {
  const kind = mediaKind(inbound.mediaContentType ?? undefined, inbound.mediaUrl ?? "");
  const caption = inbound.content?.trim();
  try {
    let description: string | undefined;
    if (image && deps.describer) {
      const t0 = Date.now();
      description = await deps.describer.describe(image, caption);
      timings.describe_ms = Date.now() - t0;
    } else if (kind === "video") {
      description = caption ? `A video: ${caption}` : "A video (not watchable here)";
    }
    if (description) await updateMessage(deps.db, inbound.id, { description });
  } catch (err) {
    deps.log.error({ messageId: inbound.id, contact: maskNumber(inbound.contactNumber), err: safeError(err) }, "Describing media failed");
  }
}

/**
 * Gets or creates the tester, then handles opt-outs (stop and reply with the confirmation, no Claude)
 * and dev-account "reset" (fresh start, then the normal reply). Any other text from a stopped tester un-stops them,
 * and any text lifts a pause on ZOH's own texts.
 */
async function runCommands(
  deps: PipelineDeps,
  stored: Message,
): Promise<{ handled: true } | { handled: false; tester: Tester; inbound: Message }> {
  const { db, log } = deps;
  const ctx = { messageId: stored.id, contact: maskNumber(stored.contactNumber) };
  let tester = await getOrCreateTester(db, stored.contactNumber, {
    firstTextAt: stored.createdAt,
    isTestUser: deps.devNumbers.includes(stored.contactNumber),
  });
  // A text that arrives mid-jump waits for it, then lands on the moved clock (#14).
  let inbound = stored;
  if (tester.isTestUser) {
    await jumpSettled(tester.id);
    tester = (await getTester(db, tester.id)) ?? tester;
    inbound = await stampOnTesterClock(db, tester, stored, (deps.now ?? (() => new Date()))());
  }
  const at = inbound.createdAt;

  // Texting again lifts the pause ZOH put on its own texts after a silence.
  if (tester.autoTextsPausedAt) {
    tester = await updateTester(db, tester.id, { autoTextsPausedAt: null });
    log.info(ctx, "Tester texted again; ZOH's own texts resume");
  }

  if (isOptOutText(inbound.content)) {
    // #16: a reply still being written for earlier texts never goes out.
    linesOf(deps).cancel(inbound.contactNumber);
    await optOut(db, tester, at);
    log.info(ctx, "Tester opted out");
    // Sendblue blocks this too until they text again (issue "Sendblue's own STOP opt-out"): no failure alert.
    await sendCommandReply(deps, inbound, OPT_OUT_CONFIRMATION, tester);
    return { handled: true };
  }

  // "reset" and "jump" switched off here (DEV_COMMANDS, off on production by default): say so, change nothing.
  const offCommand = tester.isTestUser && deps.devCommands === false ? devCommandIn(inbound.content) : undefined;
  if (offCommand) {
    log.info({ ...ctx, command: offCommand }, "Dev command is off in this app; not run");
    await sendCommandReply(deps, inbound, devCommandOffReply(offCommand, deps.appEnv ?? "production"), tester);
    return { handled: true };
  }

  if (tester.isTestUser && isResetText(inbound.content)) {
    linesOf(deps).cancel(inbound.contactNumber);
    const moved = tester.clockOffsetMs;
    tester = await resetTester(db, tester, at);
    // Back on real time: this text moved back with the rest of their history.
    if (moved) inbound = (await db.select().from(messages).where(eq(messages.id, inbound.id)))[0] ?? inbound;
    log.info(ctx, "Dev account reset; starting fresh");
  } else if (tester.stoppedAt) {
    // #109: a text gets a reply, never a restart: ZOH starts nothing until they say yes (restart_coaching).
    log.info(ctx, "Opted-out tester texted again; replying, still stopped");
    await alertTextedAfterStop(db, tester.id, tester.stoppedAt, at);
    // They texted us themselves: take them off Sendblue's opt-out list so the reply gets through.
    if (deps.sendblue) {
      try {
        await deps.sendblue.optIn(inbound.contactNumber);
      } catch (err) {
        log.error({ ...ctx, err: safeError(err) }, "Sendblue opt-in failed; replying anyway");
        await alertFailure(db, tester.id, `Couldn't take them off Sendblue's opt-out list (${errorMessage(err).slice(0, 120)})`, at);
      }
    }
  }
  return { handled: false, tester, inbound };
}

/**
 * Test mode (#14): a text from a dev account whose clock has jumped is stamped on that clock, so it
 * sits after everything the jump sent. Everyone else's texts keep the times they were stored with.
 */
async function stampOnTesterClock(db: Db, tester: Tester, inbound: Message, real: Date): Promise<Message> {
  if (!tester.clockOffsetMs) return inbound;
  const at = testerNow(tester, real);
  const [row] = await db.update(messages).set({ createdAt: at, sentAt: at }).where(eq(messages.id, inbound.id)).returning();
  return row ?? inbound;
}

/** "reset" or "jump" when the text is one of those dev commands. */
function devCommandIn(text: string | null): "reset" | "jump" | undefined {
  if (isResetText(text)) return "reset";
  if (isJumpText(text)) return "jump";
  return undefined;
}

/** Who owns which number (#82), from the pipeline's settings. */
export function routingOf(deps: Pick<PipelineDeps, "appEnv" | "devNumbers">): Routing {
  return { appEnv: deps.appEnv ?? "production", devNumbers: deps.devNumbers };
}

/** "env" from a dev number, stored in this app (#82): answers with which app this is and its version. */
export async function processEnvReply(deps: PipelineDeps, stored: Message): Promise<void> {
  const tester = await getOrCreateTester(deps.db, stored.contactNumber, { firstTextAt: stored.createdAt, isTestUser: true });
  await sendCommandReply(deps, stored, envReply(deps.appEnv ?? "production", deps.build), tester);
}

/** Sends a fixed reply (no typing bubble, no Claude) and records it. */
async function sendCommandReply(deps: PipelineDeps, inbound: Message, content: string, tester: Tester): Promise<void> {
  const { db, log } = deps;
  const ctx = { messageId: inbound.id, contact: maskNumber(inbound.contactNumber) };
  if (!deps.sendblue) {
    log.warn(ctx, "Sendblue keys are not configured; cannot reply");
    return;
  }
  try {
    const sent = await deps.sendblue.sendMessage({ number: inbound.contactNumber, content });
    await insertOutbound(db, {
      contactNumber: inbound.contactNumber,
      lineNumber: inbound.lineNumber,
      content,
      sendblueHandle: sent.messageHandle ?? null,
      status: sent.status ?? null,
      inReplyTo: inbound.id,
      sentAt: testerNow(tester, (deps.now ?? (() => new Date()))()),
      createdAt: onTesterClock(tester, testerNow(tester, (deps.now ?? (() => new Date()))())),
      raw: sent.raw as object,
    });
    await updateMessage(db, inbound.id, { status: "REPLIED", error: null });
  } catch (err) {
    log.error({ ...ctx, err: safeError(err) }, "Sending the command reply failed");
    await insertOutbound(db, {
      contactNumber: inbound.contactNumber,
      lineNumber: inbound.lineNumber,
      content,
      status: "SEND_FAILED",
      error: errorMessage(err),
      inReplyTo: inbound.id,
      createdAt: onTesterClock(tester, testerNow(tester, (deps.now ?? (() => new Date()))())),
    });
    await updateMessage(db, inbound.id, { status: "REPLIED_WITH_ERRORS", error: `send: ${errorMessage(err)}` });
  }
}

async function handleMedia(
  deps: PipelineDeps,
  inbound: Message,
  timings: Record<string, string | number>,
): Promise<{ transcript?: string; image?: ClaudeImage }> {
  const url = inbound.mediaUrl!;
  const downloaded = await deps.fetchMedia(url);
  const kind = mediaKind(downloaded.contentType, url);
  const ext = extensionOf(url) || "bin";
  const key = `media/${inbound.contactNumber.replace(/\D/g, "")}/${inbound.id}.${ext}`;
  timings.media_kind = kind;
  timings.media_bytes = downloaded.bytes.byteLength;

  if (deps.media) {
    await deps.media.put(key, downloaded.bytes, downloaded.contentType);
    await updateMessage(deps.db, inbound.id, { mediaKey: key, mediaContentType: downloaded.contentType });
    timings.media_stored_at = new Date().toISOString();
  } else {
    await updateMessage(deps.db, inbound.id, { mediaContentType: downloaded.contentType });
  }

  if (kind === "audio" && deps.transcriber) {
    const t0 = Date.now();
    const transcript = await deps.transcriber.transcribe(downloaded.bytes, `voice-note.${ext}`, downloaded.contentType);
    timings.transcription_ms = Date.now() - t0;
    await updateMessage(deps.db, inbound.id, { transcript });
    return { transcript };
  }
  if (kind === "audio" || kind === "video") return {};

  // Anything else may be a photo, whatever the CDN labels it: check the bytes.
  const t0 = Date.now();
  const image = await prepareImageForClaude(downloaded.bytes);
  if (!image) return {};
  timings.image_format = image.format;
  timings.image_prep_ms = Date.now() - t0;
  if (kind !== "image") await updateMessage(deps.db, inbound.id, { mediaContentType: `image/${image.format}` });
  return { image };
}

/**
 * Flattens stored messages into turns for Claude. Photos in the texts being answered (`current`,
 * by message id: since #16 a burst can hold several) are sent as images; older ones as their description.
 */
export function toTurns(history: Message[], current: ReadonlyMap<string, PreparedMedia>): Turn[] {
  return history.map((m) => {
    const role = m.direction === "inbound" ? "user" : "assistant";
    const now = current.get(m.id);
    const isCurrent = now !== undefined;
    const transcript = now?.transcript ?? m.transcript;
    const parts: string[] = [];
    if (m.mediaUrl) {
      const kind = mediaKind(m.mediaContentType ?? undefined, m.mediaUrl);
      if (kind === "audio") parts.push(transcript ? `[Voice note transcript]: ${transcript}` : "[Sent a voice note]");
      else if (now?.image) parts.push("[Sent a photo]");
      else if (kind === "image" && !isCurrent) parts.push(m.description ? `[Sent a photo earlier: ${m.description}]` : "[Sent a photo earlier]");
      else if (kind === "image") parts.push("[Sent a photo that couldn't be opened]");
      else parts.push(`[Sent a ${kind} attachment]`);
    }
    if (m.content?.trim()) parts.push(m.content.trim());
    const turn: Turn = { role, text: parts.join("\n") };
    if (now?.image) turn.image = { mediaType: now.image.mediaType, data: now.image.data };
    return turn;
  });
}

export function maskNumber(n: string): string {
  return n.length > 4 ? `${"*".repeat(Math.max(0, n.length - 4))}${n.slice(-4)}` : n;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
