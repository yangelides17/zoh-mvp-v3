import { HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Private object storage for photos and audio (Railway Storage Bucket, S3-compatible). */
export interface MediaStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  check(): Promise<void>;
}

export interface S3MediaStoreOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function createS3MediaStore(opts: S3MediaStoreOptions): MediaStore {
  const s3 = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    forcePathStyle: opts.forcePathStyle,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  return {
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async check() {
      await s3.send(new HeadBucketCommand({ Bucket: opts.bucket }));
    },
  };
}

export type MediaKind = "image" | "audio" | "video" | "other";

const AUDIO_EXT = new Set(["caf", "m4a", "mp3", "wav", "aac", "amr", "ogg", "oga", "opus", "flac", "webm"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "heic", "heif", "webp"]);
const VIDEO_EXT = new Set(["mov", "mp4", "m4v"]);

export function extensionOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  } catch {
    return "";
  }
}

export function mediaKind(contentType: string | undefined, url: string): MediaKind {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  const ext = extensionOf(url);
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  return "other";
}

/** Formats Claude can read directly from a URL. */
export function isClaudeReadableImage(contentType: string | undefined, url: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(ct)) return true;
  return ["jpg", "jpeg", "png", "gif", "webp"].includes(extensionOf(url));
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  contentType: string;
}

export type MediaFetcher = (url: string) => Promise<DownloadedMedia>;

export const fetchMedia: MediaFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Media download failed (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
};
