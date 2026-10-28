import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaFetcher } from "../src/media/storage.js";
import type { Transcriber } from "../src/transcription/speaches.js";

/** Photos a case can send: small JPEGs with their metadata (location, camera) stripped. */
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const HOST = "https://eval.media";

/**
 * A case line that sends media instead of (or with) text:
 *   "[photo dark-selfie.jpg: a dark, flash-lit selfie, shirt off] phone's down"
 *   "[voice: I made my bed and did the dishes]"
 * The bracket is for the grader (what the photo shows, what the voice note says); ZOH gets the real
 * photo or the transcript through the normal pipeline, and the text after it as the caption.
 */
export const MEDIA_LINE = /^\[(photo) ([\w.-]+\.jpe?g): ([^\]]+)\]\s*(.*)$|^\[(voice): ([^\]]+)\]\s*(.*)$/i;

export interface MediaText {
  /** What the tester typed alongside it (may be empty). */
  caption: string;
  mediaUrl: string;
}

/** Splits a media line into the caption and the URL the eval's fetcher serves; undefined for plain text. */
export function parseMediaLine(line: string): MediaText | undefined {
  const m = MEDIA_LINE.exec(line.trim());
  if (!m) return undefined;
  if (m[1]) return { caption: m[4]!.trim(), mediaUrl: `${HOST}/photo/${basename(m[2]!)}` };
  return { caption: m[7]!.trim(), mediaUrl: `${HOST}/voice/${Buffer.from(m[6]!.trim()).toString("base64url")}.caf` };
}

/** Serves fixture photos, and voice notes whose "audio" is their transcript (for `evalTranscriber`). */
export const evalMediaFetcher: MediaFetcher = async (url) => {
  const photo = url.match(/^https:\/\/eval\.media\/photo\/([\w.-]+)$/);
  if (photo) return { bytes: new Uint8Array(await readFile(join(FIXTURES_DIR, photo[1]!))), contentType: "image/jpeg" };
  const voice = url.match(/^https:\/\/eval\.media\/voice\/([\w-]+)\.caf$/);
  if (voice) return { bytes: new Uint8Array(Buffer.from(voice[1]!, "base64url")), contentType: "audio/x-caf" };
  throw new Error(`The eval has no media at ${url}`);
};

/** Stands in for Speaches: the eval's voice notes carry their transcript as the audio bytes. */
export const evalTranscriber: Transcriber = {
  async transcribe(audio) {
    return Buffer.from(audio).toString("utf8");
  },
  async check() {},
};
