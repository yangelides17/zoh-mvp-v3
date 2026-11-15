import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { makeDocx, makePdf, makePptx } from "../eval/media.js";
import { loadProof } from "../src/coach/state.js";
import { messages, testers } from "../src/db/schema.js";
import { MAX_DOCUMENT_PAGES, readDocument } from "../src/media/documents.js";
import type { AudioRewrapper } from "../src/media/rewrap.js";
import { MediaTooBigError, mediaKind, type MediaFetcher } from "../src/media/storage.js";
import { searchMemory } from "../src/memory/store.js";
import { serviceDate } from "../src/nudges/schedule.js";
import { proofHtml } from "../src/console/views/shared.js";
import { fakeFetchMedia, inboundEvent, makeApp, postWebhook, type TestApp } from "./helpers.js";

const ESSAY = "The lighthouse keeper woke before dawn and counted the ships.";
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("#163: reading documents", () => {
  it("reads a PDF as the file itself plus its text and page count", async () => {
    const doc = await readDocument(makePdf([ESSAY, "Page two: the storm."]), "pdf", "application/pdf");
    expect(doc.kind).toBe("pdf");
    if (doc.kind !== "pdf") return;
    expect(doc.pages).toBe(2);
    expect(doc.text).toContain("lighthouse keeper");
    expect(doc.text).toContain("the storm");
    expect(Buffer.from(doc.pdf, "base64").subarray(0, 4).toString()).toBe("%PDF");
  });

  it("reads only the first 100 pages of a longer PDF, as text, and says it clipped", async () => {
    const pages = Array.from({ length: MAX_DOCUMENT_PAGES + 5 }, (_, i) => `Page number ${i + 1}`);
    const doc = await readDocument(makePdf(pages), "pdf", "application/pdf");
    expect(doc).toMatchObject({ kind: "text", pages: MAX_DOCUMENT_PAGES + 5, clipped: true });
    if (doc.kind !== "text") return;
    expect(doc.text).toContain("Page number 100");
    expect(doc.text).not.toContain("Page number 101");
  });

  it("reads Word, Excel, CSV, PowerPoint, markdown, text and code files as text", async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["day", "miles"], ["Mon", 3]]), "Runs");
    const cases: [Uint8Array, string, string, string][] = [
      [await makeDocx(ESSAY), "docx", WORD, "lighthouse keeper"],
      [new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer), "xlsx", "application/octet-stream", 'Sheet "Runs":\nday,miles\nMon,3'],
      [new TextEncoder().encode("day,miles\nTue,4"), "csv", "text/csv", "Tue,4"],
      [await makePptx(["Why I run", "Week one"]), "pptx", "application/octet-stream", "Slide 1: Why I run\nSlide 2: Week one"],
      [new TextEncoder().encode("# Notes\n- ran 3 miles"), "md", "text/markdown", "ran 3 miles"],
      [new TextEncoder().encode("just words"), "txt", "text/plain", "just words"],
      [new TextEncoder().encode("const miles = 3;"), "ts", "application/octet-stream", "const miles = 3;"],
    ];
    for (const [bytes, ext, type, expected] of cases) {
      const doc = await readDocument(bytes, ext, type);
      expect(doc.kind, ext).toBe("text");
      if (doc.kind === "text") expect(doc.text, ext).toContain(expected);
    }
  });

  it("says why it can't open Apple files, old Office files, broken files and unknown ones", async () => {
    expect(await readDocument(new Uint8Array([80, 75, 3, 4]), "pages", "application/x-iwork-pages-sffpages")).toEqual({ kind: "unsupported", reason: "an Apple Pages file" });
    expect(await readDocument(new Uint8Array([1, 2]), "doc", "application/msword")).toMatchObject({ kind: "unsupported", reason: expect.stringContaining(".doc") });
    expect(await readDocument(new Uint8Array([1, 2, 3]), "docx", WORD)).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("damaged") });
    expect(await readDocument(new Uint8Array([7]), "bin", "application/octet-stream")).toMatchObject({ kind: "unsupported" });
  });
});

/** Serves documents by name; anything else as the shared fake does. */
function fetcherWith(files: Record<string, { bytes: Uint8Array; contentType: string }>): MediaFetcher {
  return async (url) => files[url.split("/").pop()!] ?? fakeFetchMedia(url);
}

describe("#163: a document reaches the coach", () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  it("shows the coach a PDF as the file itself, keeps its words, and counts it as proof", async () => {
    t = await makeApp({ fetchMedia: fetcherWith({ "essay.pdf": { bytes: makePdf([ESSAY]), contentType: "application/pdf" } }) });
    await postWebhook(t, inboundEvent({ content: "draft done", media_url: "https://cdn.sendblue.test/files/essay.pdf" }));
    await t.queue.idle();
    const turn = t.replier.received[0]!.at(-1)!;
    expect(turn.text).toBe("[Sent a document: essay.pdf, 1 page; the file is attached]\ndraft done");
    expect(Buffer.from(turn.pdf!, "base64").subarray(0, 4).toString()).toBe("%PDF");
    const [stored] = await t.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(stored!.transcript).toContain("lighthouse keeper");
    expect(stored!.mediaKey).toMatch(/\.pdf$/);

    const tester = (await t.db.select().from(testers))[0]!;
    const now = new Date();
    expect((await loadProof(t.db, tester, serviceDate(now, tester), now)).today).toBe(1);
    expect((await searchMemory(t.db, tester, "lighthouse")).map((h) => h.where)).toContain("their document");
  });

  it("gives the coach a Word file's words in full", async () => {
    t = await makeApp({ fetchMedia: fetcherWith({ "essay.docx": { bytes: await makeDocx(ESSAY), contentType: WORD } }) });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/files/essay.docx" }));
    await t.queue.idle();
    const turn = t.replier.received[0]!.at(-1)!;
    expect(turn.text).toBe(`[Sent a document: essay.docx]\n<document>\n${ESSAY}\n</document>`);
    expect(turn.pdf).toBeUndefined();
  });

  it("keeps an earlier document readable in the next reply, like a paste", async () => {
    t = await makeApp({ fetchMedia: fetcherWith({ "essay.docx": { bytes: await makeDocx(ESSAY), contentType: WORD } }) });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/files/essay.docx" }));
    await t.queue.idle();
    await postWebhook(t, inboundEvent({ content: "what about the ending?" }));
    await t.queue.idle();
    const turns = t.replier.received[1]!;
    expect(turns.map((x) => x.text).join("\n")).toContain(`[Sent a document earlier: essay.docx]\n<document>\n${ESSAY}\n</document>`);
    expect(turns.at(-1)!.text).toBe("what about the ending?");
  });

  it("tells the coach a Pages file or an unknown file couldn't be opened, and still replies", async () => {
    const pages = new Uint8Array([80, 75, 3, 4, 0]);
    t = await makeApp({ fetchMedia: fetcherWith({ "essay.pages": { bytes: pages, contentType: "application/x-iwork-pages-sffpages" } }) });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/files/essay.pages" }));
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/files/blob" }));
    await t.queue.idle();
    const said = t.replier.received.flat().map((x) => x.text).join("\n");
    expect(said).toContain("[Sent an Apple Pages file (essay.pages), which couldn't be opened: a PDF, screenshot or voice note would work]");
    expect(said).toContain("[Sent a kind of file I can't open, which couldn't be opened: a PDF, screenshot or voice note would work]");
    expect(t.sendblue.sends.length).toBeGreaterThan(0);
  });

  it("tells the coach a file too big to download was too big", async () => {
    t = await makeApp({ fetchMedia: async () => { throw new MediaTooBigError("big"); } });
    await postWebhook(t, inboundEvent({ content: "my set", media_url: "https://cdn.sendblue.test/v/clip.mov" }));
    await t.queue.idle();
    expect(t.replier.received[0]!.at(-1)!.text).toBe("[Sent a video too big to open (over 500 MB): a shorter or smaller one would work]\nmy set");
  });
});

describe("#163: the holding text", () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  /** A fetcher that takes `ms` to download, as a big file does. */
  const slow = (ms: number, file: { bytes: Uint8Array; contentType: string }): MediaFetcher => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return file;
  };

  it("sends one 'reading it now' when a document takes long, then the reply; it isn't one of ZOH's texts since the proof", async () => {
    t = await makeApp({ holdingAfterMs: 20, fetchMedia: slow(120, { bytes: await makeDocx(ESSAY), contentType: WORD }) });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/files/essay.docx" }));
    await t.queue.idle();
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["reading it now 📖", t.replier.replyText]);
    const out = await t.db.select().from(messages).where(eq(messages.direction, "outbound"));
    expect(out.find((m) => m.content === "reading it now 📖")?.timings).toMatchObject({ holding: 1 });

    const tester = (await t.db.select().from(testers))[0]!;
    const now = new Date(Date.now() + 1000);
    expect(await loadProof(t.db, tester, serviceDate(now, tester), now)).toMatchObject({ today: 1, zohTextsSince: 1 });
  });

  it("says 'watching it now' for a slow video", async () => {
    t = await makeApp({ holdingAfterMs: 20, fetchMedia: slow(120, { bytes: new Uint8Array([0, 0, 0]), contentType: "video/quicktime" }) });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/v/set.mov" }));
    await t.queue.idle();
    expect(t.sendblue.sends.map((s) => s.content)).toEqual(["watching it now 👀", t.replier.replyText]);
  });

  it("sends nothing extra when the file is read quickly, or for a photo", async () => {
    t = await makeApp({ holdingAfterMs: 200, fetchMedia: slow(5, { bytes: await makeDocx(ESSAY), contentType: WORD }) });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/files/essay.docx" }));
    await t.queue.idle();
    expect(t.sendblue.sends.map((s) => s.content)).toEqual([t.replier.replyText]);
    await t.close();

    t = await makeApp({ holdingAfterMs: 20, fetchMedia: async (url) => { await new Promise((r) => setTimeout(r, 120)); return fakeFetchMedia(url); } });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/photos/IMG_1.jpg" }));
    await t.queue.idle();
    expect(t.sendblue.sends.map((s) => s.content)).toEqual([t.replier.replyText]);
  });
});

describe("#185: voice notes play in Chrome", () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  class FakeRewrapper implements AudioRewrapper {
    got: Uint8Array[] = [];
    fail = false;
    async rewrap(caf: Uint8Array) {
      this.got.push(caf);
      if (this.fail) throw new Error("ffmpeg: not found");
      return { bytes: new Uint8Array([9, 9]), ext: "m4a" as const, contentType: "audio/mp4" };
    }
    async check() {}
  }

  it("keeps an iPhone voice note as .m4a and transcribes the original", async () => {
    const rewrapper = new FakeRewrapper();
    t = await makeApp({ rewrapper });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/audio/note.caf" }));
    await t.queue.idle();
    const [stored] = await t.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(stored!.mediaKey).toMatch(/\.m4a$/);
    expect(stored!.mediaContentType).toBe("audio/mp4");
    expect(t.media.objects.get(stored!.mediaKey!)?.bytes).toEqual(new Uint8Array([9, 9]));
    expect(rewrapper.got[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(stored!.transcript).toBe("I went for a run this morning");
    expect(proofHtml(stored!)).not.toContain("Download");
  });

  it("keeps the .caf when ffmpeg fails, and still transcribes it", async () => {
    const rewrapper = new FakeRewrapper();
    rewrapper.fail = true;
    t = await makeApp({ rewrapper });
    await postWebhook(t, inboundEvent({ content: "", media_url: "https://cdn.sendblue.test/audio/note.caf" }));
    await t.queue.idle();
    const [stored] = await t.db.select().from(messages).where(eq(messages.direction, "inbound"));
    expect(stored!.mediaKey).toMatch(/\.caf$/);
    expect(stored!.transcript).toBe("I went for a run this morning");
    expect(stored!.status).toBe("REPLIED");
    expect(proofHtml(stored!)).toContain("Download (Chrome can't play iPhone voice notes");
  });
});

describe("#163: more file types are recognized", () => {
  it("maps the new audio, video and document extensions to their kind", () => {
    for (const ext of ["aiff", "aif", "3ga"]) expect(mediaKind(undefined, `https://cdn.sendblue.test/f/note.${ext}`)).toBe("audio");
    for (const ext of ["avi", "mkv", "3gp"]) expect(mediaKind(undefined, `https://cdn.sendblue.test/f/clip.${ext}`)).toBe("video");
    expect(mediaKind("video/webm", "https://cdn.sendblue.test/f/clip.webm")).toBe("video");
    for (const ext of ["pdf", "docx", "xlsx", "csv", "pptx", "txt", "md", "ts"]) expect(mediaKind(undefined, `https://cdn.sendblue.test/f/file.${ext}`)).toBe("document");
  });
});
