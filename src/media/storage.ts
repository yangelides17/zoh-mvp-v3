import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** Private object storage for photos and audio (Railway Storage Bucket, S3-compatible). */
export interface MediaStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Reads an object back (the founder console's proofs); undefined when it's gone. */
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
  /** Removes an object; a key that's already gone is fine. */
  delete(key: string): Promise<void>;
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
    async get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
        if (!res.Body) return undefined;
        return { bytes: await res.Body.transformToByteArray(), contentType: res.ContentType ?? "application/octet-stream" };
      } catch (err) {
        if (err instanceof NoSuchKey) return undefined;
        throw err;
      }
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }));
    },
    async check() {
      await s3.send(new HeadBucketCommand({ Bucket: opts.bucket }));
    },
  };
}

export type MediaKind = "image" | "audio" | "video" | "document" | "other";

const AUDIO_EXT = new Set(["caf", "m4a", "mp3", "wav", "aac", "amr", "ogg", "oga", "opus", "flac", "webm", "aiff", "aif", "3ga"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "heic", "heif", "webp"]);
const VIDEO_EXT = new Set(["mov", "mp4", "m4v", "avi", "mkv", "3gp"]);
/** #163: files the coach reads (src/media/documents.ts), plus the ones it says it can't open (iWork, old Office). */
const DOCUMENT_EXT = new Set([
  "pdf", "docx", "doc", "xlsx", "xls", "csv", "tsv", "pptx", "ppt", "pages", "numbers", "key",
  "txt", "md", "markdown", "rtf", "html", "htm", "json", "xml", "yaml", "yml",
  "js", "ts", "jsx", "tsx", "py", "java", "c", "h", "cpp", "cs", "go", "rb", "rs", "swift", "kt", "php", "sql", "sh", "css",
]);
/** Document types a CDN may label: PDFs, Office, iWork, text. */
const DOCUMENT_TYPE = /^(application\/(pdf|msword|rtf|json|xml|vnd\.openxmlformats|vnd\.ms-|vnd\.apple\.|x-iwork)|text\/)/;

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
  if (DOCUMENT_TYPE.test(ct)) return "document";
  const ext = extensionOf(url);
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  if (DOCUMENT_EXT.has(ext)) return "document";
  return "other";
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  contentType: string;
}

export type MediaFetcher = (url: string) => Promise<DownloadedMedia>;

/** #163: bigger than this isn't downloaded (a long video); the coach is told it was too big to open. */
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

export class MediaTooBigError extends Error {
  override name = "MediaTooBigError";
}

export const fetchMedia: MediaFetcher = async (url) => {
  // Two minutes: a video or document can be far bigger than a photo.
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Media download failed (HTTP ${res.status})`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES) throw new MediaTooBigError("Media is over the size cap");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new MediaTooBigError("Media is over the size cap");
  return { bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
};
