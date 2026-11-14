import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { MediaFetcher } from "../src/media/storage.js";
import type { Transcriber } from "../src/transcription/speaches.js";

/** Photos a case can send: small JPEGs with their metadata (location, camera) stripped. */
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const HOST = "https://eval.media";

/**
 * A case line that sends media instead of (or with) text:
 *   "[photo dark-selfie.jpg: a dark, flash-lit selfie, shirt off] phone's down"
 *   "[voice: I made my bed and did the dishes]"
 *   "[document essay.pdf: The lighthouse keeper woke before dawn…]" (#163; .pdf, .docx, any text type, or .pages)
 * The bracket is for the grader (what the photo shows, what the voice note or document says); ZOH gets the real
 * photo, transcript or document through the normal pipeline, and the text after it as the caption.
 */
export const MEDIA_LINE =
  /^\[(photo) ([\w.-]+\.jpe?g): ([^\]]+)\]\s*(.*)$|^\[(voice): ([^\]]+)\]\s*(.*)$|^\[(document) ([\w.-]+\.\w+): ([^\]]+)\]\s*(.*)$/i;

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
  if (m[5]) return { caption: m[7]!.trim(), mediaUrl: `${HOST}/voice/${Buffer.from(m[6]!.trim()).toString("base64url")}.caf` };
  return { caption: m[11]!.trim(), mediaUrl: `${HOST}/document/${Buffer.from(m[10]!.trim()).toString("base64url")}/${basename(m[9]!)}` };
}

/**
 * Serves fixture photos, voice notes whose "audio" is their transcript (for `evalTranscriber`), and
 * documents built from their text: a real PDF or Word file, a Pages file it can't open, else plain text.
 */
export const evalMediaFetcher: MediaFetcher = async (url) => {
  const photo = url.match(/^https:\/\/eval\.media\/photo\/([\w.-]+)$/);
  if (photo) return { bytes: new Uint8Array(await readFile(join(FIXTURES_DIR, photo[1]!))), contentType: "image/jpeg" };
  const voice = url.match(/^https:\/\/eval\.media\/voice\/([\w-]+)\.caf$/);
  if (voice) return { bytes: new Uint8Array(Buffer.from(voice[1]!, "base64url")), contentType: "audio/x-caf" };
  const doc = url.match(/^https:\/\/eval\.media\/document\/([\w-]+)\/[\w.-]+\.(\w+)$/);
  if (doc) {
    const text = Buffer.from(doc[1]!, "base64url").toString("utf8");
    const ext = doc[2]!.toLowerCase();
    if (ext === "pdf") return { bytes: makePdf(text.split(/\n{2,}/)), contentType: "application/pdf" };
    if (ext === "docx") return { bytes: await makeDocx(text), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    if (ext === "pages") return { bytes: await zipOf({ "index.xml": text }), contentType: "application/x-iwork-pages-sffpages" };
    return { bytes: new TextEncoder().encode(text), contentType: "text/plain" };
  }
  throw new Error(`The eval has no media at ${url}`);
};

/** A real PDF, one page per paragraph, with Helvetica text (tests and the eval; no fixture files). */
export function makePdf(pages: string[]): Uint8Array {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((text, i) => {
    const lines = text.match(/.{1,90}(\s|$)/g) ?? [text];
    const stream = `BT /F1 11 Tf 14 TL 50 740 Td ${lines.map((l) => `(${escape(l.trim())}) Tj T*`).join(" ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** A real Word file holding these paragraphs. */
export function makeDocx(text: string): Promise<Uint8Array> {
  const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = text.split("\n").map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join("");
  return zipOf({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/** A real PowerPoint file, one slide per entry (words only). */
export function makePptx(slides: string[]): Promise<Uint8Array> {
  const files: Record<string, string> = {};
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  });
  return zipOf(files);
}

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

/** Stands in for Speaches: the eval's voice notes carry their transcript as the audio bytes. */
export const evalTranscriber: Transcriber = {
  async transcribe(audio) {
    return Buffer.from(audio).toString("utf8");
  },
  async check() {},
};
