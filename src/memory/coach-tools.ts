import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { clearCoaching, dropStyleNote, markOverridden } from "../coaching/coaching.js";
import { memoryFacts, memoryForgotten, memoryLinks, memoryPages, memoryV2Entries, type MemoryFact, type Message, type Tester } from "../db/schema.js";
import { localDate } from "../coach/state.js";
import { readDocument } from "../media/documents.js";
import { prepareImageForClaude } from "../media/images.js";
import { extensionOf, mediaKind, type MediaStore } from "../media/storage.js";
import { updateTester } from "../testers/testers.js";
import type { VideoWatcher } from "../video/gemini.js";
import { renderPage } from "./render.js";
import { addFact, ensureCorePages, factsOf, findFact, findMessage, findPage, mediaLabel, messageTime, removeFact, searchMemory } from "./store.js";
import {
  addV2Entry,
  addV2ForgetTopic,
  clearV2ForgetTopics,
  closeV2Entry,
  deleteV2Memory,
  deleteV2Page,
  ensureV2RequiredPages,
  findV2Entry,
  findV2MessageForSource,
  findV2Page,
  getV2DailiesWithMessages,
  getV2Entries,
  getV2ForgetTopics,
  getV2ReplacesChain,
  updateV2DailySummary,
  v2EntryRef,
  v2PageRef,
} from "./v2-store.js";
// sensitiveCheck imported lazily to avoid circular imports through keeper.ts → coach.ts
const loadSensitiveCheck = () => import("./v2-keeper.js").then((m) => m.sensitiveCheck);

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
  save_preference: z.object({ preference: text(160), replaces: z.array(text(40)).max(5).optional(), overrides_guidance: z.array(text(40)).max(5).optional() }).strict(),
  open_pages: z.object({ pages: z.array(text(40)).min(1).max(MAX_LOOKUPS), history: z.boolean().optional() }).strict(),
  search_memory: z.object({ query: text(120) }).strict(),
  open_file: z.object({ ref: text(40), question: text(300).optional() }).strict(),
  forget: z
    .object({
      facts: z.array(text(40)).max(10).optional(),
      pages: z.array(text(40)).max(5).optional(),
      // #250 decision 8: no length limit can make forget fail; a long topic is trimmed, not rejected.
      note: z.string().trim().min(1).optional(),
      everything: z.boolean().optional(),
    })
    .strict(),
  add_item: z.object({ type: z.enum(["todo", "followup"]), text: text(300), date: text(10), page: text(40).optional() }).strict(),
  close_item: z.object({ ref: text(40), status: z.enum(["done", "dropped"]) }).strict(),
};

export type MemoryToolName = keyof typeof schemas;
export const MEMORY_TOOL_NAMES = Object.keys(schemas) as MemoryToolName[];
/** Available before the plan locks too: a style request can come at any time. */
export const ALWAYS_MEMORY_TOOLS: MemoryToolName[] = ["save_preference"];

export const MEMORY_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "save_preference",
    description:
      'Save something they say about how they want to be coached (style, nudging, proof, timing: "no emojis", "chill out", "voice notes instead of photos"; proof can change form, never be dropped) the moment they say it. replaces: refs of learned preferences it overrides. overrides_guidance: refs of team guidance lines it goes against (they win; the team is told).',
    input_schema: {
      type: "object",
      properties: {
        preference: { type: "string" },
        replaces: { type: "array", items: { type: "string" }, description: "f: refs" },
        overrides_guidance: { type: "array", items: { type: "string" }, description: "g: refs" },
      },
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
    description: `Open a file they sent before (an m: ref from search_memory or the timeline): a document in full, a photo to look at again, a voice note's words, a video watched again with your question. Use it when they ask about one you can't see in the conversation; never answer about it from its one-line summary. Counts as a lookup.`,
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" }, question: { type: "string", description: "For a video: what to look for (their question)" } },
      required: ["ref"],
    },
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

/** #253: V2 memory tool definitions: same lookups plus add_item and close_item, e:/p: refs instead of f:. */
export const V2_MEMORY_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "save_preference",
    description:
      'Save something they say about how they want to be coached (style, nudging, proof, timing: "no emojis", "chill out", "voice notes instead of photos"; proof can change form, never be dropped) the moment they say it. replaces: e: refs of learned preferences it overrides. overrides_guidance: refs of team guidance lines it goes against (they win; the team is told).',
    input_schema: {
      type: "object",
      properties: {
        preference: { type: "string" },
        replaces: { type: "array", items: { type: "string" }, description: "e: refs" },
        overrides_guidance: { type: "array", items: { type: "string" }, description: "g: refs" },
      },
      required: ["preference"],
    },
  },
  {
    name: "open_pages",
    description: `Read v2 memory pages in full (p: refs from the tree map). history: true to include expired/done/dropped entries. Up to ${MAX_LOOKUPS} lookups a reply.`,
    input_schema: {
      type: "object",
      properties: { pages: { type: "array", items: { type: "string" } }, history: { type: "boolean", description: "Include expired/done/dropped entries" } },
      required: ["pages"],
    },
  },
  {
    name: "search_memory",
    description: `Word search over v2 entries, page titles, daily summaries and every older text, photo, voice note and document (by its words). Quoted phrases and OR work. At most ${MAX_SEARCHES} a reply.`,
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "open_file",
    description: `Open a file they sent before (an m: ref from search_memory): a document in full, a photo to look at again, a voice note's words, a video watched again with your question. Use it when they ask about one you can't see in the conversation; never answer about it from its one-line summary. Counts as a lookup.`,
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" }, question: { type: "string", description: "For a video: what to look for (their question)" } },
      required: ["ref"],
    },
  },
  {
    name: "forget",
    description:
      "They asked you to forget something. facts: the e: refs to remove. pages: p: refs of a person or subject page to remove whole (\"forget my dog\"). note: a few neutral words naming it (\"his job\", \"his ex\"), always: later replies and the overnight pass see it was forgotten on purpose and never file it again. everything: true only for \"forget everything\".",
    input_schema: {
      type: "object",
      properties: {
        facts: { type: "array", items: { type: "string" } },
        pages: { type: "array", items: { type: "string" } },
        note: { type: "string" }, everything: { type: "boolean" } },
    },
  },
  {
    name: "add_item",
    description:
      "Add a reminder or follow-up they asked for. type: 'todo' (a task they want to do) or 'followup' (something to bring up later). date: YYYY-MM-DD when it's due; proposes a date if they don't give one. page: p: ref of the page it belongs to (default: root).",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["todo", "followup"] },
        text: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        page: { type: "string", description: "p: ref (optional, default root)" },
      },
      required: ["type", "text", "date"],
    },
  },
  {
    name: "close_item",
    description: "Close an open item (todo or followup) when it's done or no longer relevant. ref: the e: ref of the entry. status: 'done' or 'dropped'.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" }, status: { type: "string", enum: ["done", "dropped"] } },
      required: ["ref", "status"],
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
  ctx: { at: Date; budget: LookupBudget; sourceMessageId?: string; media?: MediaStore; watcher?: VideoWatcher; checker?: import("../claude/replier.js").ClaudeModel },
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
      const { preference, replaces, overrides_guidance } = parsed.data as z.infer<typeof schemas.save_preference>;
      // V1 save (always, so switching back is clean)
      const { preferences } = await ensureCorePages(db, tester, at);
      await addFact(db, preferences, { text: preference, sourceMessageId: ctx.sourceMessageId ?? null, section: "stated", day: localDate(at, tester.timeZone) }, at, "tester");
      const dropped: MemoryFact[] = [];
      for (const ref of replaces ?? []) {
        const f = await findFact(db, tester.id, ref);
        // Only a learned preference gives way; a stated one stays until they change it themselves.
        if (f?.section === "learned" && f.pageId === preferences.id) {
          await removeFact(db, f, at, "tester");
          dropped.push(f);
        }
      }
      // Also kept on the tester for the state block, which every phase reads.
      const notes = tester.styleNotes ? `${tester.styleNotes}; ${preference}` : preference;
      const updated = await updateTester(db, tester.id, { styleNotes: notes });
      // #158: their word beats the team's guidance; the line is marked and the founders are told.
      const clashed: string[] = [];
      for (const ref of overrides_guidance ?? []) {
        const line = await markOverridden(db, tester, ref, preference, at);
        if (line) clashed.push(line.text);
      }
      // #253: v2 testers also save the preference as an entry on Coaching
      if (tester.memoryVersion === "v2") {
        const sourceId = ctx.sourceMessageId ?? await findV2MessageForSource(db, tester);
        if (sourceId) {
          const doSensitiveCheck = await loadSensitiveCheck();
          const { coaching } = await ensureV2RequiredPages(db, tester, at);
          const fTopics = await getV2ForgetTopics(db, tester.id);
          const rejection = ctx.checker ? await doSensitiveCheck(ctx.checker, preference, fTopics) : null;
          if (rejection) {
            // Check for avoidance language: "don't bring up", "don't mention", "forget about", etc.
            const avoidancePattern = /(?:don'?t\s+(?:bring up|mention|talk about|ask about)|forget about|stop talking about)/i;
            if (avoidancePattern.test(preference)) {
              await addV2Entry(db, {
                pageId: coaching.id, testerId: tester.id, type: "note",
                text: "Asked not to bring up a personal topic.",
                sourceMessageId: sourceId, learnedOn: localDate(at, tester.timeZone),
              }, at);
              // Record the original words as a forget topic
              await addV2ForgetTopic(db, tester.id, preference, at);
            }
          } else {
            await addV2Entry(db, {
              pageId: coaching.id, testerId: tester.id, type: "note",
              text: preference,
              sourceMessageId: sourceId, learnedOn: localDate(at, tester.timeZone),
            }, at);
          }
        }
      }
      const extra = [
        dropped.length ? ` Dropped the learned preference it overrides: ${dropped.map((f) => f.text).join("; ")}.` : "",
        clashed.length ? ` Follow it over the team's guidance: ${clashed.join("; ")}.` : "",
      ].join("");
      return { ok: true, message: `Preference saved: ${preference}.${extra}`, tester: updated, memoryChanged: true };
    }

    case "open_pages": {
      const { pages, history } = parsed.data as z.infer<typeof schemas.open_pages>;
      if (budget.lookups + pages.length > MAX_LOOKUPS) return { ok: false, error: spent };
      budget.lookups += pages.length;
      const out: string[] = [];
      if (tester.memoryVersion === "v2") {
        const { renderV2PageForCoach } = await import("./v2-keeper.js");
        for (const ref of pages) {
          const page = await findV2Page(db, tester.id, ref);
          out.push(page ? await renderV2PageForCoach(db, tester, page, { history: !!history }) : `${ref}: no such page`);
        }
      } else {
        for (const ref of pages) {
          const page = await findPage(db, tester.id, ref);
          out.push(page ? await renderPage(db, tester, page, { refs: true }) : `${ref}: no such page`);
        }
      }
      return { ok: true, message: out.join("\n\n"), tester };
    }

    case "search_memory": {
      const { query } = parsed.data as z.infer<typeof schemas.search_memory>;
      if (budget.lookups + 1 > MAX_LOOKUPS || budget.searches + 1 > MAX_SEARCHES) return { ok: false, error: spent };
      budget.lookups += 1;
      budget.searches += 1;
      if (tester.memoryVersion === "v2") {
        const { searchV2Memory } = await import("./v2-keeper.js");
        const hits = await searchV2Memory(db, tester, query, 8);
        if (hits.length === 0) return { ok: true, message: `Nothing found for "${query}". Try another phrasing, or say you don't know.`, tester };
        const lines = hits.map((h) => `${h.ref} (${h.where}, ${h.date}): ${h.text}`);
        return { ok: true, message: lines.join("\n"), tester };
      }
      const hits = await searchMemory(db, tester, query, 8);
      if (hits.length === 0) return { ok: true, message: `Nothing found for "${query}". Try another phrasing, or say you don't know.`, tester };
      const lines = hits.map((h) => `${h.ref} (${h.where}, ${localDate(h.at, tester.timeZone)}): ${h.text}`);
      return { ok: true, message: lines.join("\n"), tester };
    }

    case "open_file": {
      const { ref, question } = parsed.data as z.infer<typeof schemas.open_file>;
      if (budget.lookups + 1 > MAX_LOOKUPS) return { ok: false, error: spent };
      budget.lookups += 1;
      // Only this tester's own texts: a guessed ref never opens anyone else's file.
      const m = await findMessage(db, tester, ref);
      if (!m?.mediaUrl || m.direction !== "inbound") return { ok: false, error: `${ref}: no file they sent has that ref.` };
      return { ok: true, tester, ...(await openFile(m, tester, ctx.media, ctx.watcher, question)) };
    }

    case "forget": {
      const { facts, pages, note, everything } = parsed.data as z.infer<typeof schemas.forget>;
      const isV2 = tester.memoryVersion === "v2";
      // #250 decision 8: trim a long topic, never reject it.
      const trimmedNote = note ? note.slice(0, 500) : undefined;

      if (everything) {
        // V1 forget (always, so switching back is clean)
        await db.delete(memoryLinks).where(eq(memoryLinks.testerId, tester.id));
        await db.delete(memoryFacts).where(eq(memoryFacts.testerId, tester.id));
        await db.delete(memoryPages).where(eq(memoryPages.testerId, tester.id));
        await db.delete(memoryForgotten).where(eq(memoryForgotten.testerId, tester.id));
        // #250: also delete all v2 memory and clear forget topics
        if (isV2) {
          await deleteV2Memory(db, tester.id);
          await clearV2ForgetTopics(db, tester.id);
        }
        const updated = await updateTester(db, tester.id, { memorySince: at, styleNotes: "" });
        await clearCoaching(db, tester.id, "they asked ZOH to forget everything", at);
        return { ok: true, message: "Forgot everything: memory is empty and older texts won't be read again.", tester: updated, memoryChanged: true };
      }
      if (!facts?.length && !pages?.length && !trimmedNote) return { ok: false, error: "Give the facts' or pages' refs, a note, or everything: true." };
      const removed: string[] = [];
      const pageTitles: string[] = [];
      const forgottenMsgIds: string[] = [];

      // --- V1 forget (always runs, so switching back never restores forgotten content) ---
      for (const ref of pages ?? []) {
        const page = await findPage(db, tester.id, ref);
        if (!page) {
          // #250: for v2 testers, also try v2 pages
          if (!isV2) return { ok: false, error: `No page ${ref} for this tester.` };
          continue; // Will be handled in v2 section
        }
        if (page.kind !== "person" && page.kind !== "subject") return { ok: false, error: `${ref} is their ${page.kind} page: forget its facts instead.` };
        const sources = (await factsOf(db, [page.id])).flatMap((f) => (f.sourceMessageId ? [f.sourceMessageId] : []));
        if (sources.length) {
          await db.insert(memoryForgotten).values(sources.map((messageId) => ({ testerId: tester.id, messageId }))).onConflictDoNothing();
          forgottenMsgIds.push(...sources);
        }
        await db.delete(memoryPages).where(eq(memoryPages.id, page.id));
        removed.push(page.title);
        pageTitles.push(page.title);
      }
      for (const ref of facts ?? []) {
        const f = await findFact(db, tester.id, ref);
        if (!f) {
          // #250: for v2 testers, also try v2 entries
          if (!isV2) return { ok: false, error: `No fact ${ref} for this tester.` };
          continue; // Will be handled in v2 section
        }
        await removeFact(db, f, at, "tester");
        if (f.section === "stated") tester = await dropStyleNote(db, tester, f.text);
        if (f.sourceMessageId) {
          await db.insert(memoryForgotten).values({ testerId: tester.id, messageId: f.sourceMessageId }).onConflictDoNothing();
          forgottenMsgIds.push(f.sourceMessageId);
        }
        removed.push(f.text);
      }

      // --- V2 forget (only for v2 testers) ---
      if (isV2) {
        const {
          addV2Entry: addEntry, getV2EntriesByTester, getV2ForgetTopics,
          findV2MessageForSource, getV2Pages: getAllV2Pages, getV2Dailies,
        } = await import("./v2-store.js");
        const doSensitiveCheck = await loadSensitiveCheck();
        const { renderV2Memory } = await import("./v2-keeper.js");
        const topicText = trimmedNote ?? (pageTitles.length ? pageTitles.join("; ") : undefined);

        // 1. Delete v2 entries/pages by ref (when the caller passes e:/p: refs, e.g. from the lab)
        for (const ref of facts ?? []) {
          const entry = await findV2Entry(db, tester.id, ref);
          if (!entry) continue;
          const chain = await getV2ReplacesChain(db, entry.id);
          for (const id of [entry.id, ...chain]) {
            const [e] = await db.select().from(memoryV2Entries).where(eq(memoryV2Entries.id, id)).limit(1);
            if (e?.sourceMessageId) {
              await db.insert(memoryForgotten).values({ testerId: tester.id, messageId: e.sourceMessageId }).onConflictDoNothing();
              forgottenMsgIds.push(e.sourceMessageId);
            }
            await db.delete(memoryV2Entries).where(eq(memoryV2Entries.id, id));
          }
          removed.push(entry.text);
        }
        for (const ref of pages ?? []) {
          const page = await findV2Page(db, tester.id, ref);
          if (!page) continue;
          const entries = await getV2Entries(db, page.id);
          for (const e of entries) {
            if (e.sourceMessageId) {
              await db.insert(memoryForgotten).values({ testerId: tester.id, messageId: e.sourceMessageId }).onConflictDoNothing();
              forgottenMsgIds.push(e.sourceMessageId);
            }
          }
          const result = await deleteV2Page(db, page);
          if (result.ok) { removed.push(page.title); pageTitles.push(page.title); }
        }

        const rewrittenDailies = new Set<string>();
        // 2. Model-based identification: ask Haiku which v2 entries, pages and summaries
        //    are ABOUT the topic, then delete/rewrite only those.
        if (topicText && ctx.checker) {
          const v2Memory = await renderV2Memory(db, tester);
          const identifyPrompt = `The tester asked to forget: "${topicText}"

Here is their memory. Identify which entries, pages and daily summaries are ABOUT this topic and should be removed or rewritten. Be precise: only items directly about the topic, not items that merely mention a person or place also involved in unrelated context. For example, if forgetting "the divorce and Karen", delete Karen's page and entries about the divorce, but do NOT delete Emma's page or entries about Emma that aren't about the divorce.

Return JSON only:
{ "entries": ["e:ref", ...], "pages": ["p:ref", ...], "summaries": ["YYYY-MM-DD", ...] }

MEMORY:
${v2Memory}`;
          // Try up to 2 attempts to get valid JSON from the identification model.
          let identified: { entries?: string[]; pages?: string[]; summaries?: string[] } | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            const response = await ctx.checker.create({
              system: [{ type: "text", text: "Identify memory items about a topic to forget. Return JSON only." }],
              messages: [{ role: "user", content: identifyPrompt }],
              tools: [], toolChoice: "none",
            });
            const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
            const jsonStr = text.replace(/^```json?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
            try {
              identified = JSON.parse(jsonStr) as { entries?: string[]; pages?: string[]; summaries?: string[] };
              break;
            } catch {
              if (attempt === 1) {
                console.error("V2 forget identification failed after retry", { testerId: tester.id, topic: topicText });
                return { ok: false, error: "Could not identify what to forget — please try again." };
              }
            }
          }

          if (identified) {
            // Delete identified entries
            for (const ref of identified.entries ?? []) {
              const entry = await findV2Entry(db, tester.id, ref);
              if (!entry) continue;
              const chain = await getV2ReplacesChain(db, entry.id);
              for (const id of [entry.id, ...chain]) {
                const [e] = await db.select().from(memoryV2Entries).where(eq(memoryV2Entries.id, id)).limit(1);
                if (e?.sourceMessageId) {
                  await db.insert(memoryForgotten).values({ testerId: tester.id, messageId: e.sourceMessageId }).onConflictDoNothing();
                  forgottenMsgIds.push(e.sourceMessageId);
                }
                await db.delete(memoryV2Entries).where(eq(memoryV2Entries.id, id));
              }
            }
            // Delete identified pages
            for (const ref of identified.pages ?? []) {
              const page = await findV2Page(db, tester.id, ref);
              if (!page) continue;
              const entries = await getV2Entries(db, page.id);
              for (const e of entries) {
                if (e.sourceMessageId) {
                  await db.insert(memoryForgotten).values({ testerId: tester.id, messageId: e.sourceMessageId }).onConflictDoNothing();
                  forgottenMsgIds.push(e.sourceMessageId);
                }
              }
              await deleteV2Page(db, page);
            }
            // Rewrite identified daily summaries
            for (const dateStr of identified.summaries ?? []) {
              const allDailies = await getV2Dailies(db, tester.id, 1000);
              const daily = allDailies.find((d) => d.date === dateStr);
              if (!daily) continue;
              const rwResp = await ctx.checker.create({
                system: [{ type: "text", text: "Rewrite the summary without the specified topic. Output only the rewritten summary, nothing else." }],
                messages: [{ role: "user", content: `Rewrite removing any mention of "${topicText}". Keep everything else. If nothing remains, write "No notable events."\n\nOriginal: ${daily.summary}` }],
                tools: [], toolChoice: "none",
              });
              const rewritten = rwResp.content.find((b) => b.type === "text")?.text?.trim() ?? "No notable events.";
              const fTopics = await getV2ForgetTopics(db, tester.id);
              const rejection = await doSensitiveCheck(ctx.checker, rewritten, fTopics);
              await updateV2DailySummary(db, daily, rejection ? "No notable events." : rewritten, at);
              rewrittenDailies.add(dateStr);
            }
          }
        }

        // Also rewrite any summaries with matching forgotten message IDs
        // (only those not already rewritten by the model identification above)
        if (forgottenMsgIds.length > 0 && ctx.checker) {
          const topic = topicText ?? "the forgotten content";
          const affected = await getV2DailiesWithMessages(db, tester.id, forgottenMsgIds);
          for (const daily of affected) {
            if (rewrittenDailies.has(daily.date)) continue; // already handled by model identification
            const rwResp = await ctx.checker.create({
              system: [{ type: "text", text: "Rewrite the summary without the specified topic. Output only the rewritten summary, nothing else." }],
              messages: [{ role: "user", content: `Rewrite removing any mention of "${topic}". Keep everything else. If nothing remains, write "No notable events."\n\nOriginal: ${daily.summary}` }],
              tools: [], toolChoice: "none",
            });
            const rewritten = rwResp.content.find((b) => b.type === "text")?.text?.trim() ?? "No notable events.";
            const fTopics = await getV2ForgetTopics(db, tester.id);
            const rejection = await doSensitiveCheck(ctx.checker, rewritten, fTopics);
            await updateV2DailySummary(db, daily, rejection ? "No notable events." : rewritten, at);
          }
        }

        // 3. Record the forget topic
        if (topicText) await addV2ForgetTopic(db, tester.id, topicText, at);

        // 4. Neutral note on Coaching ("asked to forget something on <date>")
        const { coaching } = await ensureV2RequiredPages(db, tester, at);
        const sourceForNote = ctx.sourceMessageId ?? await findV2MessageForSource(db, tester);
        if (sourceForNote) {
          await addEntry(db, {
            pageId: coaching.id, testerId: tester.id, type: "note",
            text: `Asked to forget something on ${localDate(at, tester.timeZone)}.`,
            sourceMessageId: sourceForNote, learnedOn: localDate(at, tester.timeZone),
          }, at);
        }
      }

      // V1 forget note (always leave one)
      const forgetNote = trimmedNote ?? (pageTitles.length ? pageTitles.join("; ") : undefined);
      if (forgetNote) {
        const { preferences } = await ensureCorePages(db, tester, at);
        await addFact(db, preferences, { text: forgetNote, sourceMessageId: ctx.sourceMessageId ?? null, section: "forget", day: localDate(at, tester.timeZone) }, at);
      }
      return { ok: true, message: `Forgotten${removed.length ? `: ${removed.join("; ")}` : ""}${forgetNote ? ` (won't keep: ${forgetNote})` : ""}.`, tester, memoryChanged: true };
    }

    case "add_item": {
      if (tester.memoryVersion !== "v2") return { ok: false, error: "add_item is only available for v2 testers." };
      const { type: itemType, text: itemText, date, page } = parsed.data as z.infer<typeof schemas.add_item>;
      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "date must be YYYY-MM-DD." };
      const doSensitiveCheck = await loadSensitiveCheck();
      const fTopics = await getV2ForgetTopics(db, tester.id);
      const rejection = ctx.checker ? await doSensitiveCheck(ctx.checker, itemText, fTopics) : null;
      if (rejection) return { ok: false, error: `Not saved: ${rejection}` };
      // Find the target page (default to root)
      let targetPageId: string;
      if (page) {
        const p = await findV2Page(db, tester.id, page);
        if (!p) return { ok: false, error: `No page ${page} for this tester.` };
        targetPageId = p.id;
      } else {
        const { root } = await ensureV2RequiredPages(db, tester, at);
        targetPageId = root.id;
      }
      const sourceId = ctx.sourceMessageId ?? await findV2MessageForSource(db, tester);
      if (!sourceId) return { ok: false, error: "No source message found." };
      const entry = await addV2Entry(db, {
        pageId: targetPageId, testerId: tester.id, type: itemType,
        text: itemText, when: date,
        sourceMessageId: sourceId, learnedOn: localDate(at, tester.timeZone),
      }, at);
      return { ok: true, message: `Added ${v2EntryRef(entry.id)} [${itemType}] "${itemText}" due ${date}.`, tester, memoryChanged: true };
    }

    case "close_item": {
      if (tester.memoryVersion !== "v2") return { ok: false, error: "close_item is only available for v2 testers." };
      const { ref, status } = parsed.data as z.infer<typeof schemas.close_item>;
      const entry = await findV2Entry(db, tester.id, ref);
      if (!entry) return { ok: false, error: `No entry ${ref} for this tester.` };
      const result = await closeV2Entry(db, entry, status, at);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, message: `Closed ${v2EntryRef(entry.id)}: ${status}.`, tester, memoryChanged: true };
    }
  }
}

/**
 * #163: a file they sent, opened again from our copy and read afresh: a document in full (a PDF as the
 * file itself), a photo to look at, a voice note's words. Gone or unreadable: says so, with what's known.
 */
async function openFile(
  m: Message,
  tester: Tester,
  media: MediaStore | undefined,
  watcher: VideoWatcher | undefined,
  question: string | undefined,
): Promise<{ message: string; blocks?: FileBlock[] }> {
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
  if (kind === "video") {
    // Watched again from our copy, with their question; else what was seen when it arrived.
    if (stored && watcher) {
      try {
        const watched = await watcher.watch({ video: stored.bytes, contentType: stored.contentType, ...(question ? { question } : {}) });
        return { message: `${head}, watched again${question ? " for your question" : ""}:\n${watched.account}` };
      } catch {
        // Falls through to what was seen when it arrived.
      }
    }
    return { message: m.transcript ? `${head} (as seen when it arrived):\n${m.transcript}` : `${head} can't be watched again.${known}` };
  }
  return { message: `${head} can't be opened here.${known}` };
}
