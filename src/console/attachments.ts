import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ClaudeModel } from "../claude/replier.js";
import type { Db } from "../db/client.js";
import { consoleMessages, type ConsoleMessage } from "../db/schema.js";
import { readDocument } from "../media/documents.js";
import { prepareImageForClaude } from "../media/images.js";
import { mediaKind, type MediaStore } from "../media/storage.js";
import type { VideoWatcher } from "../video/gemini.js";

/**
 * #168: a file the founders attach in the console chat. It's stored in the private bucket on their line and read
 * once, before the console coach answers, so the coach (and the card it drafts) knows what's in it. It reaches a
 * tester only as a word-for-word text (send_text with file), uploaded to Sendblue at Do it.
 */

/** How the coaches name an attached file: its line's ref. */
export const fileRef = (line: Pick<ConsoleMessage, "id">) => line.id.slice(0, 8);

/** A file name's extension, lowercased ("" without one). */
export const extOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
/** What kind of file it is, from its type or name. */
export const kindOf = (contentType: string, name: string) => mediaKind(contentType, `https://file.local/${encodeURIComponent(name)}`);

/** Most of a document the console coach reads. */
const DOCUMENT_CHARS = 8_000;

const VIDEO_QUESTION =
  "The coaching team will send this video to the person they coach. What does it show and teach, step by step, and how long is it? Note what a one-line intro must get right (its length, level, and what to do).";

const IMAGE_INSTRUCTIONS =
  "Describe this image for a coach who will send it to the person they coach: what it shows and any readable text, in at most three plain sentences. Never guess or add anything that isn't visible. No preamble.";

export interface AttachmentReaders {
  media?: MediaStore;
  model: ClaudeModel;
  watcher?: VideoWatcher;
}

/** Stores a founder's file in the bucket; the key goes on their chat line. */
export async function storeAttachment(media: MediaStore, testerId: string, file: { bytes: Uint8Array; contentType: string; name: string }): Promise<string> {
  const ext = extOf(file.name);
  const key = `console/${testerId}/${randomUUID()}${ext ? `.${ext}` : ""}`;
  await media.put(key, file.bytes, file.contentType);
  return key;
}

/**
 * Reads a founder's file once and saves what's in it on the line (a video watched, a document read, an image looked
 * at). A file that can't be read is saved as such, so the coach says so instead of guessing. Never throws.
 */
export async function readAttachment(db: Db, readers: AttachmentReaders, line: ConsoleMessage): Promise<ConsoleMessage> {
  if (!line.mediaKey || line.mediaAccount) return line;
  const { account, partial } = await describe(readers, line).catch((err: unknown) => ({
    account: `Couldn't read it (${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}).`,
    partial: false,
  }));
  const [row] = await db.update(consoleMessages).set({ mediaAccount: account, mediaPartial: partial }).where(eq(consoleMessages.id, line.id)).returning();
  return row ?? line;
}

async function describe(readers: AttachmentReaders, line: ConsoleMessage): Promise<{ account: string; partial: boolean }> {
  const object = readers.media ? await readers.media.get(line.mediaKey!) : undefined;
  if (!object) return { account: "Couldn't read it (the file isn't in storage).", partial: false };
  const contentType = line.mediaContentType ?? object.contentType;
  const name = line.mediaName ?? line.mediaKey!;
  const kind = kindOf(contentType, name);
  if (kind === "video") {
    if (!readers.watcher) return { account: "Couldn't watch it (video watching isn't set up).", partial: false };
    const watched = await readers.watcher.watch({ video: object.bytes, contentType, question: VIDEO_QUESTION });
    return { account: watched.account, partial: watched.clipped };
  }
  if (kind === "image") {
    const image = await prepareImageForClaude(object.bytes);
    if (!image) return { account: "Couldn't read it (an image format I can't open).", partial: false };
    const response = await readers.model.create({
      system: [{ type: "text", text: IMAGE_INSTRUCTIONS }],
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }, { type: "text", text: "Describe it." }] }],
      tools: [],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return { account: text || "Couldn't read it (no description came back).", partial: false };
  }
  const doc = await readDocument(object.bytes, extOf(name), contentType);
  if (doc.kind === "unsupported") return { account: `Couldn't read it (${doc.reason}).`, partial: false };
  const clipped = doc.clipped || doc.text.length > DOCUMENT_CHARS;
  return { account: `${doc.pages ? `${doc.pages} pages. ` : ""}${doc.text.slice(0, DOCUMENT_CHARS)}`, partial: clipped };
}
