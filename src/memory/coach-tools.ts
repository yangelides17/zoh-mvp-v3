import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { memoryFacts, memoryForgotten, memoryLinks, memoryPages, type MemoryFact, type Message, type Tester } from "../db/schema.js";
import { localDate } from "../coach/state.js";
import { readDocument } from "../media/documents.js";
import { prepareImageForClaude } from "../media/images.js";
import { extensionOf, mediaKind, type MediaStore } from "../media/storage.js";
import { updateTester } from "../testers/testers.js";
import { renderPage } from "./render.js";
import { addFact, ensureCorePages, factsOf, findFact, findMessage, findPage, mediaLabel, messageTime, removeFact, searchMemory } from "./store.js";

/**
 * The coach's memory tools (spec: GitHub issue "Coach memory"): saving a stated preference the
 * moment it's said, forgetting, and looking things up. Lookups are capped per reply in code.
 */

/** Opens and searches per reply, together. */
export const MAX_LOOKUPS = 5;
/** Of those, searches. */
export const MAX_SEARCHES = 2;

const text = (max: number) => z.string().trim().min(1).max(max);

const schemas = {
  save_preference: z.object({ preference: text(160), replaces: z.array(text(40)).max(5).optional() }).strict(),
  open_pages: z.object({ pages: z.array(text(40)).min(1).max(MAX_LOOKUPS) }).strict(),
  search_memory: z.object({ query: text(120) }).strict(),
  open_file: z.object({ ref: text(40) }).strict(),
  forget: z
    .object({
      facts: z.array(text(40)).max(10).optional(),
      pages: z.array(text(40)).max(5).optional(),
      note: text(120).optional(),
      everything: z.boolean().optional(),
    })
    .strict(),
};

export type MemoryToolName = keyof typeof schemas;
export const MEMORY_TOOL_NAMES = Object.keys(schemas) as MemoryToolName[];
/** Available before the plan locks too: a style request can come at any time. */
export const ALWAYS_MEMORY_TOOLS: MemoryToolName[] = ["save_preference"];

export const MEMORY_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "save_preference",
    description:
      'Save something they say about how they want to be coached (style, nudging, proof, timing: "no emojis", "chill out", "voice notes instead of photos"; proof can change form, never be dropped) the moment they say it. replaces: refs of learned preferences it overrides.',
    input_schema: {
      type: "object",
      properties: { preference: { type: "string" }, replaces: { type: "array", items: { type: "string" }, description: "f: refs" } },
      required: ["preference"],
    },
  },
  {
    name: "open_pages",
    description: `Read memory pages in full (p: refs from the index). Up to ${MAX_LOOKUPS} lookups a reply.`,
    input_schema: { type: "object", properties: { pages: { type: "array", items: { type: "string" } } }, required: ["pages"] },
  },
  {
    name: "search_memory",
    description: `Word search over everything you remember and every older text, photo, voice note and document (by its words). Quoted phrases and OR work. At most ${MAX_SEARCHES} a reply.`,
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "open_file",
    description: `Open a file they sent before (an m: ref from search_memory or the timeline): a document in full, a photo to look at again, a voice note's words. Use it when they ask about one you can't see in the conversation; never answer about it from its one-line summary. Counts as a lookup.`,
    input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "forget",
    description:
      "They asked you to forget something. facts: the f: refs to remove. pages: p: refs of a person or subject page to remove whole (\"forget my dog\"). note: a few neutral words naming it (\"his job\", \"his ex\"), always: later replies and the overnight pass see it was forgotten on purpose and never file it again. everything: true only for \"forget everything\".",
    input_schema: {
      type: "object",
      properties: {
        facts: { type: "array", items: { type: "string" } },
        pages: { type: "array", items: { type: "string" } },
        note: { type: "string" }, everything: { type: "boolean" } },
    },
  },
];

/** Lookups used so far in one reply. */
export interface LookupBudget {
  lookups: number;
  searches: number;
}

/** #163: what open_file shows Claude beyond words: a photo or a PDF. */
export type FileBlock = Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam;

export type MemoryToolResult =
  | { ok: true; message: string; tester: Tester; memoryChanged?: boolean; blocks?: FileBlock[] }
  | { ok: false; error: string };

/**
 * Runs one memory tool for the coach. `sourceMessageId` is the text being answered (what a stated
 * preference cites). Never throws for bad input: the model gets the error back.
 */
export async function runMemoryTool(
  db: Db,
  tester: Tester,
  name: string,
  rawInput: unknown,
  ctx: { at: Date; budget: LookupBudget; sourceMessageId?: string; media?: MediaStore },
): Promise<MemoryToolResult> {
  if (!(name in schemas)) return { ok: false, error: `Unknown tool "${name}"` };
  const parsed = schemas[name as MemoryToolName].safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  const { at, budget } = ctx;
  const spent = "Lookup limit reached for this reply: answer with what you have.";

  switch (name as MemoryToolName) {
    case "save_preference": {
      const { preference, replaces } = parsed.data as z.infer<typeof schemas.save_preference>;
      const { preferences } = await ensureCorePages(db, tester, at);
      await addFact(db, preferences, { text: preference, sourceMessageId: ctx.sourceMessageId ?? null, section: "stated", day: localDate(at, tester.timeZone) }, at);
      const dropped: MemoryFact[] = [];
      for (const ref of replaces ?? []) {
        const f = await findFact(db, tester.id, ref);
        // Only a learned preference gives way; a stated one stays until they change it themselves.
        if (f?.section === "learned" && f.pageId === preferences.id) {
          await removeFact(db, f, at);
          dropped.push(f);
        }
      }
      // Also kept on the tester for the state block, which every phase reads.
      const notes = tester.styleNotes ? `${tester.styleNotes}; ${preference}` : preference;
      const updated = await updateTester(db, tester.id, { styleNotes: notes });
      const extra = dropped.length ? ` Dropped the learned preference it overrides: ${dropped.map((f) => f.text).join("; ")}.` : "";
      return { ok: true, message: `Preference saved: ${preference}.${extra}`, tester: updated, memoryChanged: true };
    }

    case "open_pages": {
      const { pages } = parsed.data as z.infer<typeof schemas.open_pages>;
      if (budget.lookups + pages.length > MAX_LOOKUPS) return { ok: false, error: spent };
      budget.lookups += pages.length;
      const out: string[] = [];
      for (const ref of pages) {
        const page = await findPage(db, tester.id, ref);
        out.push(page ? await renderPage(db, tester, page, { refs: true }) : `${ref}: no such page`);
      }
      return { ok: true, message: out.join("\n\n"), tester };
    }

    case "search_memory": {
      const { query } = parsed.data as z.infer<typeof schemas.search_memory>;
      if (budget.lookups + 1 > MAX_LOOKUPS || budget.searches + 1 > MAX_SEARCHES) return { ok: false, error: spent };
      budget.lookups += 1;
      budget.searches += 1;
      const hits = await searchMemory(db, tester, query, 8);
      if (hits.length === 0) return { ok: true, message: `Nothing found for "${query}". Try another phrasing, or say you don't know.`, tester };
      const lines = hits.map((h) => `${h.ref} (${h.where}, ${localDate(h.at, tester.timeZone)}): ${h.text}`);
      return { ok: true, message: lines.join("\n"), tester };
    }

    case "open_file": {
      const { ref } = parsed.data as z.infer<typeof schemas.open_file>;
      if (budget.lookups + 1 > MAX_LOOKUPS) return { ok: false, error: spent };
      budget.lookups += 1;
      // Only this tester's own texts: a guessed ref never opens anyone else's file.
      const m = await findMessage(db, tester, ref);
      if (!m?.mediaUrl || m.direction !== "inbound") return { ok: false, error: `${ref}: no file they sent has that ref.` };
      return { ok: true, tester, ...(await openFile(m, tester, ctx.media)) };
    }

    case "forget": {
      const { facts, pages, note, everything } = parsed.data as z.infer<typeof schemas.forget>;
      if (everything) {
        await db.delete(memoryLinks).where(eq(memoryLinks.testerId, tester.id));
        await db.delete(memoryFacts).where(eq(memoryFacts.testerId, tester.id));
        await db.delete(memoryPages).where(eq(memoryPages.testerId, tester.id));
        await db.delete(memoryForgotten).where(eq(memoryForgotten.testerId, tester.id));
        // From here memory reads nothing older, and the overnight pass doesn't refile it.
        const updated = await updateTester(db, tester.id, { memorySince: at, styleNotes: "" });
        return { ok: true, message: "Forgot everything: memory is empty and older texts won't be read again.", tester: updated, memoryChanged: true };
      }
      if (!facts?.length && !pages?.length && !note) return { ok: false, error: "Give the facts' or pages' refs, a note, or everything: true." };
      const removed: string[] = [];
      const pageTitles: string[] = [];
      for (const ref of pages ?? []) {
        const page = await findPage(db, tester.id, ref);
        if (!page) return { ok: false, error: `No page ${ref} for this tester.` };
        // Their own page, preferences, goals and days stay: forget the facts on them instead.
        if (page.kind !== "person" && page.kind !== "subject") return { ok: false, error: `${ref} is their ${page.kind} page: forget its facts instead.` };
        const sources = (await factsOf(db, [page.id])).flatMap((f) => (f.sourceMessageId ? [f.sourceMessageId] : []));
        if (sources.length) {
          await db.insert(memoryForgotten).values(sources.map((messageId) => ({ testerId: tester.id, messageId }))).onConflictDoNothing();
        }
        // Its facts and links go with it.
        await db.delete(memoryPages).where(eq(memoryPages.id, page.id));
        removed.push(page.title);
        pageTitles.push(page.title);
      }
      for (const ref of facts ?? []) {
        const f = await findFact(db, tester.id, ref);
        if (!f) return { ok: false, error: `No fact ${ref} for this tester.` };
        await removeFact(db, f, at);
        if (f.sourceMessageId) {
          await db.insert(memoryForgotten).values({ testerId: tester.id, messageId: f.sourceMessageId }).onConflictDoNothing();
        }
        removed.push(f.text);
      }
      // Always leave a note: without it a later reply sees its own earlier words missing from memory
      // and thinks it made them up, and the overnight pass could file it again from today's texts.
      const forgetNote = note ?? (pageTitles.length ? pageTitles.join("; ") : undefined);
      if (forgetNote) {
        const { preferences } = await ensureCorePages(db, tester, at);
        await addFact(db, preferences, { text: forgetNote, sourceMessageId: ctx.sourceMessageId ?? null, section: "forget", day: localDate(at, tester.timeZone) }, at);
      }
      return { ok: true, message: `Forgotten${removed.length ? `: ${removed.join("; ")}` : ""}${forgetNote ? ` (won't keep: ${forgetNote})` : ""}.`, tester, memoryChanged: true };
    }
  }
}

/**
 * #163: a file they sent, opened again from our copy and read afresh: a document in full (a PDF as the
 * file itself), a photo to look at, a voice note's words. Gone or unreadable: says so, with what's known.
 */
async function openFile(m: Message, tester: Tester, media: MediaStore | undefined): Promise<{ message: string; blocks?: FileBlock[] }> {
  const kind = mediaKind(m.mediaContentType ?? undefined, m.mediaUrl!);
  const said = m.content?.trim() ? ` (their words with it: "${m.content.trim()}")` : "";
  const head = `The ${mediaLabel(m)} they sent ${localDate(messageTime(m), tester.timeZone)}${said}`;
  const known = m.description ? ` When it arrived: ${m.description}.` : "";
  if (kind === "audio") return { message: m.transcript ? `${head}. Its words: "${m.transcript}"` : `${head} has no transcript.${known}` };
  const stored = m.mediaKey && !m.mediaDeletedAt && media ? await media.get(m.mediaKey) : undefined;
  if (kind === "image") {
    const image = stored ? await prepareImageForClaude(stored.bytes) : undefined;
    if (!image) return { message: `${head} can't be opened again.${known}` };
    return { message: `${head}, attached.`, blocks: [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }] };
  }
  if (kind === "document" || kind === "other") {
    const doc = stored ? await readDocument(stored.bytes, extensionOf(m.mediaUrl!), stored.contentType) : undefined;
    if (doc?.kind === "pdf") {
      const pages = `${doc.pages} page${doc.pages === 1 ? "" : "s"}`;
      return { message: `${head}, attached (${pages}).`, blocks: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.pdf } }] };
    }
    if (doc?.kind === "text") return { message: `${head}${doc.clipped ? " (only the first part: it's longer)" : ""}:\n<document>\n${doc.text}\n</document>` };
    if (m.transcript) return { message: `${head}:\n<document>\n${m.transcript}\n</document>` };
    return { message: `${head} couldn't be opened${doc?.kind === "unsupported" ? ` (${doc.reason})` : ""}.${known}` };
  }
  return { message: `${head} can't be opened here.${known}` };
}
