import type { FastifyBaseLogger } from "fastify";
import type { Turn, Replier } from "../claude/replier.js";
import type { Db } from "../db/client.js";
import { insertOutbound, mergeTimings, recentConversation, updateMessage } from "../db/messages.js";
import type { Message, Tester } from "../db/schema.js";
import { prepareImageForClaude, type ClaudeImage } from "../media/images.js";
import { extensionOf, mediaKind, type MediaFetcher, type MediaStore } from "../media/storage.js";
import type { SendblueClient } from "../sendblue/client.js";
import type { Transcriber } from "../transcription/speaches.js";
import { safeError } from "../errors.js";
import { isOptOutText, isResetText, OPT_OUT_CONFIRMATION, optOut } from "../testers/commands.js";
import { getOrCreateTester, resetTester, updateTester } from "../testers/testers.js";

export type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error" | "debug">;

export const FALLBACK_REPLY = "Got it";

export interface PipelineDeps {
  db: Db;
  log: Logger;
  allowedNumbers: string[];
  /** Dev accounts: test users who can text "reset". */
  devNumbers: string[];
  historyLimit: number;
  typingIndicator: boolean;
  sendblue?: SendblueClient;
  replier?: Replier;
  media?: MediaStore;
  transcriber?: Transcriber;
  fetchMedia: MediaFetcher;
  now?: () => Date;
}

/**
 * Handles one stored inbound message: tester lookup and commands ("stop", "reset"),
 * typing indicator, media copy and transcription, a reply from Claude (or the fallback), then the send.
 */
export async function processInbound(deps: PipelineDeps, inbound: Message): Promise<void> {
  const now = deps.now ?? (() => new Date());
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

  // 0. Who's texting, and the commands that never depend on the model.
  const commands = await runCommands(deps, inbound);
  if (commands.handled) return;
  const tester = commands.tester;

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

  // 2. Media: keep a private copy; transcribe voice notes.
  let transcript: string | undefined;
  let image: ClaudeImage | undefined;
  if (inbound.mediaUrl) {
    const result = await handleMedia(deps, inbound, timings).catch((err: unknown) => {
      errors.push(`media: ${errorMessage(err)}`);
      log.error({ ...ctx, err: safeError(err) }, "Media handling failed");
      return undefined;
    });
    transcript = result?.transcript;
    image = result?.image;
  }

  // 3. Reply text from Claude, or the fallback.
  let replyText = FALLBACK_REPLY;
  if (deps.replier) {
    const claudeStart = now();
    try {
      const history = await recentConversation(db, inbound.contactNumber, deps.historyLimit, tester.contextStartedAt);
      const turns = toTurns(history, inbound.id, { transcript, image });
      replyText = await deps.replier.reply(turns);
      timings.claude_ms = now().getTime() - claudeStart.getTime();
    } catch (err) {
      timings.claude_ms = now().getTime() - claudeStart.getTime();
      errors.push(`claude: ${errorMessage(err)}`);
      log.error({ ...ctx, err: safeError(err) }, "Claude reply failed; sending fallback");
    }
  } else {
    errors.push("claude: ANTHROPIC_API_KEY not configured");
  }

  // 4. Send and record the reply.
  await typing;
  try {
    const sent = await sendblue.sendMessage({ number: inbound.contactNumber, content: replyText });
    const sentAt = now();
    timings.reply_sent_at = sentAt.toISOString();
    if (inbound.sentAt) timings.received_to_reply_sent_ms = sentAt.getTime() - inbound.sentAt.getTime();
    timings.processing_ms = sentAt.getTime() - started.getTime();
    await insertOutbound(db, {
      contactNumber: inbound.contactNumber,
      lineNumber: inbound.lineNumber,
      content: replyText,
      sendblueHandle: sent.messageHandle ?? null,
      status: sent.status ?? null,
      inReplyTo: inbound.id,
      sentAt,
      raw: sent.raw as object,
    });
  } catch (err) {
    errors.push(`send: ${errorMessage(err)}`);
    log.error({ ...ctx, err: safeError(err) }, "Sending the reply failed");
    await insertOutbound(db, {
      contactNumber: inbound.contactNumber,
      lineNumber: inbound.lineNumber,
      content: replyText,
      status: "SEND_FAILED",
      error: errorMessage(err),
      inReplyTo: inbound.id,
    });
    if (deps.typingIndicator) await sendblue.sendTypingIndicator(inbound.contactNumber, "stop");
  }

  await mergeTimings(db, inbound.id, timings);
  await updateMessage(db, inbound.id, {
    status: errors.length ? "REPLIED_WITH_ERRORS" : "REPLIED",
    error: errors.length ? errors.join("; ") : null,
  });
  log.info({ ...ctx, timings, errors }, "Inbound message handled");
}

/**
 * Gets or creates the tester, then handles opt-outs (stop and reply with the confirmation, no Claude)
 * and dev-account "reset" (fresh start, then the normal reply). Any other text from a stopped tester un-stops them.
 */
async function runCommands(
  deps: PipelineDeps,
  inbound: Message,
): Promise<{ handled: true } | { handled: false; tester: Tester }> {
  const { db, log } = deps;
  const ctx = { messageId: inbound.id, contact: maskNumber(inbound.contactNumber) };
  const at = inbound.createdAt;
  let tester = await getOrCreateTester(db, inbound.contactNumber, {
    firstTextAt: at,
    isTestUser: deps.devNumbers.includes(inbound.contactNumber),
  });

  if (isOptOutText(inbound.content)) {
    await optOut(db, tester, at);
    log.info(ctx, "Tester opted out");
    await sendCommandReply(deps, inbound, OPT_OUT_CONFIRMATION);
    return { handled: true };
  }

  if (tester.isTestUser && isResetText(inbound.content)) {
    tester = await resetTester(db, tester, at);
    log.info(ctx, "Dev account reset; starting fresh");
  } else if (tester.stoppedAt) {
    tester = await updateTester(db, tester.id, { stoppedAt: null });
    log.info(ctx, "Opted-out tester texted again; un-stopped");
  }
  return { handled: false, tester };
}

/** Sends a fixed reply (no typing bubble, no Claude) and records it. */
async function sendCommandReply(deps: PipelineDeps, inbound: Message, content: string): Promise<void> {
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
      sentAt: (deps.now ?? (() => new Date()))(),
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

/** Flattens stored messages into turns for Claude. Only the newest photo is sent as an image. */
export function toTurns(
  history: Message[],
  currentId: string,
  current: { transcript?: string; image?: ClaudeImage },
): Turn[] {
  return history.map((m) => {
    const role = m.direction === "inbound" ? "user" : "assistant";
    const isCurrent = m.id === currentId;
    const transcript = isCurrent ? (current.transcript ?? m.transcript) : m.transcript;
    const parts: string[] = [];
    if (m.mediaUrl) {
      const kind = mediaKind(m.mediaContentType ?? undefined, m.mediaUrl);
      if (kind === "audio") parts.push(transcript ? `[Voice note transcript]: ${transcript}` : "[Sent a voice note]");
      else if (isCurrent && current.image) parts.push("[Sent a photo]");
      else if (kind === "image") parts.push(isCurrent ? "[Sent a photo that couldn't be opened]" : "[Sent a photo earlier]");
      else parts.push(`[Sent a ${kind} attachment]`);
    }
    if (m.content?.trim()) parts.push(m.content.trim());
    const turn: Turn = { role, text: parts.join("\n") };
    if (isCurrent && current.image) turn.image = { mediaType: current.image.mediaType, data: current.image.data };
    return turn;
  });
}

export function maskNumber(n: string): string {
  return n.length > 4 ? `${"*".repeat(Math.max(0, n.length - 4))}${n.slice(-4)}` : n;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
