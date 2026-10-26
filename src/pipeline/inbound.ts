import type { FastifyBaseLogger } from "fastify";
import type { Turn, Replier } from "../claude/replier.js";
import type { Db } from "../db/client.js";
import { insertOutbound, mergeTimings, recentConversation, updateMessage } from "../db/messages.js";
import type { Message } from "../db/schema.js";
import {
  extensionOf,
  isClaudeReadableImage,
  mediaKind,
  type MediaFetcher,
  type MediaStore,
} from "../media/storage.js";
import type { SendblueClient } from "../sendblue/client.js";
import type { Transcriber } from "../transcription/speaches.js";
import { safeError } from "../errors.js";

export type Logger = Pick<FastifyBaseLogger, "info" | "warn" | "error" | "debug">;

export const FALLBACK_REPLY = "Got it";

export interface PipelineDeps {
  db: Db;
  log: Logger;
  allowedNumbers: string[];
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
 * Handles one stored inbound message: typing indicator, media copy and
 * transcription, a reply from Claude (or the fallback), then the send.
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
  let imageUrlForClaude: string | undefined;
  if (inbound.mediaUrl) {
    const result = await handleMedia(deps, inbound, timings).catch((err: unknown) => {
      errors.push(`media: ${errorMessage(err)}`);
      log.error({ ...ctx, err: safeError(err) }, "Media handling failed");
      return undefined;
    });
    transcript = result?.transcript;
    imageUrlForClaude = result?.imageUrlForClaude;
  }

  // 3. Reply text from Claude, or the fallback.
  let replyText = FALLBACK_REPLY;
  if (deps.replier) {
    const claudeStart = now();
    try {
      const history = await recentConversation(db, inbound.contactNumber, deps.historyLimit);
      const turns = toTurns(history, inbound.id, { transcript, imageUrl: imageUrlForClaude });
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

async function handleMedia(
  deps: PipelineDeps,
  inbound: Message,
  timings: Record<string, string | number>,
): Promise<{ transcript?: string; imageUrlForClaude?: string }> {
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
  if (kind === "image" && isClaudeReadableImage(downloaded.contentType, url)) {
    return { imageUrlForClaude: url };
  }
  return {};
}

/** Flattens stored messages into turns for Claude. Only the newest photo is sent as an image. */
export function toTurns(
  history: Message[],
  currentId: string,
  current: { transcript?: string; imageUrl?: string },
): Turn[] {
  return history.map((m) => {
    const role = m.direction === "inbound" ? "user" : "assistant";
    const isCurrent = m.id === currentId;
    const transcript = isCurrent ? (current.transcript ?? m.transcript) : m.transcript;
    const parts: string[] = [];
    if (m.mediaUrl) {
      const kind = mediaKind(m.mediaContentType ?? undefined, m.mediaUrl);
      if (kind === "audio") parts.push(transcript ? `[Voice note transcript]: ${transcript}` : "[Sent a voice note]");
      else if (kind === "image") parts.push(isCurrent && current.imageUrl ? "[Sent a photo]" : "[Sent a photo earlier]");
      else parts.push(`[Sent a ${kind} attachment]`);
    }
    if (m.content?.trim()) parts.push(m.content.trim());
    const turn: Turn = { role, text: parts.join("\n") };
    if (isCurrent && current.imageUrl) turn.imageUrl = current.imageUrl;
    return turn;
  });
}

export function maskNumber(n: string): string {
  return n.length > 4 ? `${"*".repeat(Math.max(0, n.length - 4))}${n.slice(-4)}` : n;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
