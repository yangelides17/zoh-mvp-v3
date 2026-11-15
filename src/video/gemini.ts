import { ApiError, FileState, GoogleGenAI, Type, type Part } from "@google/genai";

/**
 * #163: videos testers send, watched by Gemini (Claude reads images and text, not video). Gemini watches
 * picture and sound and writes an account focused on today's step; the coach judges from that account.
 * Behind an interface: tests and the eval use a fake.
 */
export interface WatchRequest {
  video: Uint8Array;
  contentType: string;
  /** Today's step, so the account focuses on it; missing before a plan. */
  step?: string;
  caption?: string;
  /** open_file: what they asked about it, answered from the video. */
  question?: string;
}

export interface Watched {
  /** What it shows and says, focused on the step, with rough times. */
  account: string;
  /** One line, for memory and the console. */
  summary: string;
  /** Longer than `MAX_WATCH_SECONDS`: only the start was watched. */
  clipped: boolean;
}

/** Why a video couldn't be watched: a key or credit problem (founders get an alert) or anything else. */
export class VideoWatchError extends Error {
  override name = "VideoWatchError";
  constructor(
    readonly reason: "key_or_credit" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface VideoWatcher {
  watch(req: WatchRequest): Promise<Watched>;
  check(): Promise<void>;
}

/** The first 20 minutes are watched (spec #163). */
export const MAX_WATCH_SECONDS = 20 * 60;
/** Gemini takes requests up to 20 MB inline; bigger videos go through its Files API. */
const INLINE_MAX_BYTES = 18 * 1024 * 1024;
const FILE_READY_TIMEOUT_MS = 180_000;

export const WATCH_INSTRUCTIONS = `You watch a video a person sent their coach, usually as proof of today's step. Write for the coach, who can't see it.
account: a factual account focused on the step, with rough times (0:40): what's shown, what's said, sung or played, and anything that shows how well it was done (form, count, result, a finished thing). Say plainly what you can't see or aren't sure of. Never invent. If a question is given, answer it from the video first.
summary: one plain line (at most 25 words) on what the video shows.`;

export function createGeminiWatcher(opts: { apiKey: string; model: string; client?: GoogleGenAI }): VideoWatcher {
  const ai = opts.client ?? new GoogleGenAI({ apiKey: opts.apiKey });
  return {
    async watch(req) {
      const seconds = videoSeconds(req.video);
      const clipped = seconds !== undefined && seconds > MAX_WATCH_SECONDS;
      const clip = { endOffset: `${MAX_WATCH_SECONDS}s` };
      let uploaded: string | undefined;
      try {
        let video: Part;
        if (req.video.byteLength <= INLINE_MAX_BYTES) {
          video = { inlineData: { mimeType: req.contentType, data: Buffer.from(req.video).toString("base64") }, videoMetadata: clip };
        } else {
          const file = await ai.files.upload({ file: new Blob([req.video], { type: req.contentType }), config: { mimeType: req.contentType } });
          uploaded = file.name;
          const ready = await waitUntilActive(ai, file.name!);
          video = { fileData: { fileUri: ready.uri!, mimeType: req.contentType }, videoMetadata: clip };
        }
        const asked = [
          req.step ? `Today's step: ${req.step}` : "No step set yet.",
          req.caption ? `Their words with it: ${req.caption}` : "No words with it.",
          req.question ? `The coach's question: ${req.question}` : "",
          clipped ? `Only the first ${MAX_WATCH_SECONDS / 60} minutes are included; say so if it matters.` : "",
        ].filter(Boolean);
        const response = await ai.models.generateContent({
          model: opts.model,
          contents: [{ role: "user", parts: [video, { text: asked.join("\n") }] }],
          config: {
            systemInstruction: WATCH_INSTRUCTIONS,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: { account: { type: Type.STRING }, summary: { type: Type.STRING } },
              required: ["account", "summary"],
            },
          },
        });
        const parsed = JSON.parse(response.text ?? "{}") as { account?: string; summary?: string };
        if (!parsed.account?.trim()) throw new VideoWatchError("failed", "Gemini returned no account");
        return { account: parsed.account.trim(), summary: (parsed.summary ?? "").trim().slice(0, 300), clipped };
      } catch (err) {
        throw asWatchError(err);
      } finally {
        if (uploaded) await ai.files.delete({ name: uploaded }).catch(() => undefined);
      }
    },
    async check() {
      try {
        await ai.models.get({ model: opts.model });
      } catch (err) {
        throw asWatchError(err);
      }
    },
  };
}

async function waitUntilActive(ai: GoogleGenAI, name: string) {
  const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
  for (;;) {
    const file = await ai.files.get({ name });
    if (file.state === FileState.ACTIVE) return file;
    if (file.state === FileState.FAILED) throw new VideoWatchError("failed", "Gemini couldn't process the video");
    if (Date.now() > deadline) throw new VideoWatchError("failed", "Gemini took too long to process the video");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** A bad key, no credit or a spending cap (401, 402, 403, 429 quota) is the founders' to fix; anything else just failed. */
function asWatchError(err: unknown): VideoWatchError {
  if (err instanceof VideoWatchError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof ApiError ? err.status : undefined;
  // A wrong or revoked key comes back as 400 INVALID_ARGUMENT, "API key not valid".
  const keyOrCredit =
    status === 401 || status === 402 || status === 403 || (status === 400 && /api key/i.test(message)) || (status === 429 && /quota|billing|credit|spend/i.test(message));
  return new VideoWatchError(keyOrCredit ? "key_or_credit" : "failed", message.slice(0, 300));
}

/**
 * A QuickTime or MP4 video's length in seconds, from its `mvhd` box (iPhone videos are both); undefined
 * for anything else. Only used to tell the coach a long video was clipped.
 */
export function videoSeconds(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 4; i + 32 <= bytes.length; i++) {
    // "mvhd"
    if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x76 || bytes[i + 2] !== 0x68 || bytes[i + 3] !== 0x64) continue;
    const version = bytes[i + 4];
    if (version === 1) {
      const timescale = view.getUint32(i + 24);
      const duration = Number(view.getBigUint64(i + 28));
      return timescale ? duration / timescale : undefined;
    }
    const timescale = view.getUint32(i + 16);
    const duration = view.getUint32(i + 20);
    return timescale ? duration / timescale : undefined;
  }
  return undefined;
}
