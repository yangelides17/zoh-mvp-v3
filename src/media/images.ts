import sharp from "sharp";
// heic-convert ships no types; see src/types/heic-convert.d.ts.
import heicConvert from "heic-convert";

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "heic";

/** Identifies an image by its first bytes, since CDN content types and URLs aren't reliable. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  const ascii = (start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (b.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return undefined;
}

export interface ClaudeImage {
  mediaType: "image/jpeg";
  /** Base64-encoded JPEG. */
  data: string;
  format: ImageFormat;
  width?: number;
  height?: number;
}

/** Claude resizes anything larger than this on its side; sending smaller saves tokens and time. */
const MAX_EDGE = 1568;

/**
 * Turns any photo an iPhone can send (HEIC, JPEG, PNG, GIF, WebP) into a JPEG Claude can read,
 * downscaled to at most 1568px on the long edge. Returns undefined for non-images.
 */
export async function prepareImageForClaude(bytes: Uint8Array): Promise<ClaudeImage | undefined> {
  const format = sniffImageFormat(bytes);
  if (!format) return undefined;

  let input: Buffer = Buffer.from(bytes);
  if (format === "heic") {
    const converted = await heicConvert({ buffer: input, format: "JPEG", quality: 0.9 });
    input = converted instanceof ArrayBuffer ? Buffer.from(new Uint8Array(converted)) : Buffer.from(converted);
  }

  const { data, info } = await sharp(input, { animated: false })
    .rotate() // respect EXIF orientation
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });

  return { mediaType: "image/jpeg", data: data.toString("base64"), format, width: info.width, height: info.height };
}
