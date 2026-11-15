import JSZip from "jszip";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import * as XLSX from "xlsx";

/**
 * #163: reads a document a tester sends, so the coach can judge it as proof and give feedback.
 * PDFs go to Claude as they are (it reads layout, scans and charts) plus their text for memory;
 * Word, spreadsheets, slides and text files become plain text. Anything else says why it can't be read.
 */
export type ReadDocument =
  | { kind: "pdf"; pdf: string; text: string; pages: number; clipped: false }
  | { kind: "text"; text: string; pages?: number; clipped: boolean }
  | { kind: "unsupported"; reason: string };

/** Read in full up to this many pages; past it, the first this many (spec #163). */
export const MAX_DOCUMENT_PAGES = 100;
/** About 100 pages of plain text, for files without pages. */
export const MAX_DOCUMENT_CHARS = 300_000;

type Format = "pdf" | "docx" | "xlsx" | "pptx" | "text" | "rtf";

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "html", "htm", "json", "xml", "yaml", "yml",
  "js", "ts", "jsx", "tsx", "py", "java", "c", "h", "cpp", "cs", "go", "rb", "rs", "swift", "kt", "php", "sql", "sh", "css",
]);
const CANT_OPEN: Record<string, string> = {
  pages: "an Apple Pages file",
  numbers: "an Apple Numbers file",
  key: "an Apple Keynote file",
  doc: "an old-style Word file (.doc)",
  ppt: "an old-style PowerPoint file (.ppt)",
};

/** Which reader a file needs, from its bytes, extension and type (in that order of trust). */
function formatOf(bytes: Uint8Array, ext: string, contentType: string): Format | { cant: string } {
  const ct = contentType.toLowerCase();
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf"; // %PDF
  if (CANT_OPEN[ext]) return { cant: CANT_OPEN[ext] };
  if (ext === "pdf" || ct === "application/pdf") return "pdf";
  if (ext === "docx" || ct.includes("wordprocessingml")) return "docx";
  if (ext === "xlsx" || ext === "xls" || ct.includes("spreadsheetml") || ct === "application/vnd.ms-excel") return "xlsx";
  if (ext === "pptx" || ct.includes("presentationml")) return "pptx";
  if (ext === "rtf" || ct.includes("rtf")) return "rtf";
  if (TEXT_EXT.has(ext) || ct.startsWith("text/") || ct === "application/json" || ct === "application/xml") return "text";
  if (ct.includes("apple") || ct.includes("iwork")) return { cant: "an Apple Pages, Numbers or Keynote file" };
  return { cant: "a kind of file I can't open" };
}

/** Reads a document; never throws (a broken file comes back as unsupported). */
export async function readDocument(bytes: Uint8Array, ext: string, contentType: string): Promise<ReadDocument> {
  const format = formatOf(bytes, ext.toLowerCase(), contentType);
  if (typeof format === "object") return { kind: "unsupported", reason: format.cant };
  try {
    const read = await readAs(format, bytes);
    if (read.kind === "text" && !read.text.trim()) return { kind: "unsupported", reason: "a file with no readable text" };
    return read;
  } catch {
    return { kind: "unsupported", reason: "a file that couldn't be read (it may be damaged)" };
  }
}

async function readAs(format: Format, bytes: Uint8Array): Promise<ReadDocument> {
  switch (format) {
    case "pdf": {
      // unpdf takes ownership of the buffer it's given, so it gets a copy.
      const { totalPages, text } = await extractText(new Uint8Array(bytes), { mergePages: false });
      if (totalPages > MAX_DOCUMENT_PAGES) {
        // Claude reads at most 100 PDF pages at once: past that, the text of the first 100.
        return { kind: "text", text: text.slice(0, MAX_DOCUMENT_PAGES).join("\n\n"), pages: totalPages, clipped: true };
      }
      return { kind: "pdf", pdf: Buffer.from(bytes).toString("base64"), text: text.join("\n\n").trim(), pages: totalPages, clipped: false };
    }
    case "docx":
      return clip((await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value);
    case "xlsx": {
      const book = XLSX.read(bytes, { type: "array" });
      const sheets = book.SheetNames.map((name) => `Sheet "${name}":\n${XLSX.utils.sheet_to_csv(book.Sheets[name]!)}`);
      return clip(sheets.join("\n\n"));
    }
    case "pptx":
      return clip(await slidesText(bytes));
    case "rtf":
      return clip(rtfText(new TextDecoder().decode(bytes)));
    case "text":
      return clip(new TextDecoder().decode(bytes));
  }
}

function clip(text: string): ReadDocument {
  const trimmed = text.trim();
  return trimmed.length > MAX_DOCUMENT_CHARS
    ? { kind: "text", text: trimmed.slice(0, MAX_DOCUMENT_CHARS), clipped: true }
    : { kind: "text", text: trimmed, clipped: false };
}

/** Each slide's words, in order ("Slide 1: …"); pictures in slides aren't read (spec: out of scope). */
async function slidesText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .map((path) => ({ path, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(path)?.[1]) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n);
  const out: string[] = [];
  for (const s of slides) {
    const xml = await zip.file(s.path)!.async("string");
    const words = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]!)).join(" ").trim();
    out.push(`Slide ${s.n}: ${words}`);
  }
  return out.join("\n");
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Plain words from RTF: drops control words and groups; good enough for writing sent as RTF. */
function rtfText(rtf: string): string {
  return rtf
    .replace(/\\par[d]?/g, "\n")
    .replace(/\{\\\*[^{}]*\}/g, "")
    .replace(/\\'[0-9a-f]{2}/gi, "")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n");
}
