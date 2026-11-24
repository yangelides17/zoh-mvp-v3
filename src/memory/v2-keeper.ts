import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ClaudeModel } from "../claude/replier.js";
import type { Db } from "../db/client.js";
import { memoryV2Pages, stepDays, testerGoals, type MemoryV2Page, type Message, type StepDay, type Tester } from "../db/schema.js";
import { localDate } from "../coach/state.js";
import { addDays, localClock, weekdayOf } from "../nudges/schedule.js";
import { maskNumber, type Logger } from "../pipeline/inbound.js";
import { messageTime } from "./store.js";
import { stepLine, transcriptLine } from "./keeper.js";
import {
  addV2Entry,
  addV2Link,
  closeV2Entry,
  correctV2Entry,
  createV2Page,
  ensureV2RequiredPages,
  findV2Entry,
  findV2Page,
  getGoalTitle,
  getV2Children,
  getV2Dailies,
  getV2Entries,
  getV2EntryPeople,
  getV2GoalPage,
  getV2GoalSlugs,
  getV2Links,
  getV2OpenDated,
  getV2Pages,
  replaceV2Entry,
  updateV2Page,
  v2AllMessageIdsOn,
  v2EntryRef,
  v2MessageRef,
  v2PageRef,
  v2TextsOn,
  writeV2Daily,
  getV2ForgetTopics,
  type CreateV2PageInput,
} from "./v2-store.js";

/**
 * The v2 nightly writer (#250). Runs at 3 am like today's keeper but writes into the v2
 * tree with typed entries, a sensitive check, and read-before-write enforcement.
 */

/** Claude calls per day written. */
export const V2_KEEPER_MAX_ROUNDS = 12;
/** Output budget per call. */
export const V2_KEEPER_MAX_TOKENS = 8000;

// ─── Sensitive check ────────────────────────────────────────────────────

/**
 * Runs a Haiku call to check whether text contains sensitive content (health, medication,
 * mental-health, money details beyond what the step needs) or matches a forget topic.
 * Returns null if safe, or a reason string if rejected.
 */
export async function sensitiveCheck(
  checker: ClaudeModel,
  text: string,
  forgetTopics: string[],
): Promise<string | null> {
  const topicList = forgetTopics.length > 0
    ? `\n\nForgotten topics (reject if the text touches any of these):\n${forgetTopics.map((t) => `- ${t}`).join("\n")}`
    : "";
  const response = await checker.create({
    system: [{ type: "text", text: `You are a privacy filter. Decide whether the text contains sensitive details that should NOT be stored in a coaching memory. Reject if it contains:
- Health conditions, diagnoses, medications, or medical details beyond what a daily step needs (a bad knee that changes their workout is OK; a diagnosis, medication name, dosage, or test result is not)
- Mental health details (therapy, depression, anxiety, etc.)
- Financial details (income, debt, money trouble, specific amounts)
- Legal details
- Phone numbers, emails, or addresses
- A mention that something sensitive was omitted or left out (e.g. "I left out the sleep-aid detail", "medication details removed", "sensitive content excluded")
${topicList}

Respond with exactly one line:
SAFE — if the text can be stored
REJECT: <brief reason> — if the text should not be stored` }],
    messages: [{ role: "user", content: text }],
    tools: [],
    toolChoice: "none",
  });
  const reply = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  if (reply.startsWith("SAFE")) return null;
  const reason = reply.replace(/^REJECT:\s*/i, "").trim();
  return reason || "Contains sensitive content";
}

// ─── Writer tools ───────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().min(1).max(max);
const ref = text(40);

const schemas = {
  open_pages: z.object({ pages: z.array(ref).min(1).max(5) }).strict(),
  add_entry: z.object({
    page: ref,
    type: z.enum(["fact", "note", "unsure", "todo", "event", "followup"]),
    text: text(500),
    detail: text(1000).optional(),
    when: text(10).optional(),
    as_of: text(10).optional(),
    people: z.array(ref).max(5).optional(),
    source: ref,
  }).strict(),
  correct_entry: z.object({
    entry: ref,
    text: text(500).optional(),
    detail: text(1000).optional(),
    when: text(10).optional(),
    as_of: text(10).optional(),
    people: z.array(ref).max(5).optional(),
  }).strict(),
  replace_entry: z.object({
    entry: ref,
    text: text(500),
    detail: text(1000).optional(),
    when: text(10).optional(),
    as_of: text(10).optional(),
    people: z.array(ref).max(5).optional(),
    source: ref,
  }).strict(),
  close_entry: z.object({ entry: ref, status: z.enum(["done", "dropped"]) }).strict(),
  create_page: z.object({
    parent: ref,
    kind: z.enum(["area", "project", "goal", "person", "place"]),
    title: text(100),
    about: text(500).optional(),
    other_names: z.array(text(80)).max(5).optional(),
    goal_slug: text(40).optional(),
  }).strict(),
  add_other_name: z.object({ page: ref, name: text(80) }).strict(),
  correct_about: z.object({ page: ref, about: text(500) }).strict(),
  write_daily_summary: z.object({ text: text(2000) }).strict(),
};

type V2KeeperToolName = keyof typeof schemas;

export const V2_KEEPER_TOOLS: Anthropic.Tool[] = [
  { name: "open_pages", description: "Read pages in full (p: refs). Must open a page before writing to it.", input_schema: obj({ pages: { type: "array", items: str("p: ref") } }, ["pages"]) },
  {
    name: "add_entry",
    description: "Add an entry to an opened page. type: fact/note/unsure/todo/event/followup. Dated types (todo/event/followup) need a 'when' date (YYYY-MM-DD). source: the m: ref of the tester's text it came from.",
    input_schema: obj({
      page: str("p: ref"), type: { type: "string", enum: ["fact", "note", "unsure", "todo", "event", "followup"] },
      text: str(), detail: str("Optional longer note"), when: str("YYYY-MM-DD, required for dated types"),
      as_of: str("Date the fact was true as of"), people: { type: "array", items: str("p: ref of a person page") },
      source: str("m: ref"),
    }, ["page", "type", "text", "source"]),
  },
  { name: "correct_entry", description: "Fix an error in an entry (e.g. 'Anna not Ana'). Edits in place, no history. Only on opened pages.", input_schema: obj({ entry: str("e: ref"), text: str(), detail: str(), when: str(), as_of: str(), people: { type: "array", items: str() } }, ["entry"]) },
  { name: "replace_entry", description: "The world changed (e.g. 'chose Clemson' replaces 'heading to Clemson'). New entry, old one becomes history. Only on opened pages.", input_schema: obj({ entry: str("e: ref"), text: str(), detail: str(), when: str(), as_of: str(), people: { type: "array", items: str() }, source: str("m: ref") }, ["entry", "text", "source"]) },
  { name: "close_entry", description: "Close a dated entry (todo/event/followup): done or dropped.", input_schema: obj({ entry: str("e: ref"), status: { type: "string", enum: ["done", "dropped"] } }, ["entry", "status"]) },
  {
    name: "create_page",
    description: "Create a new page. Person pages go under People, place pages under Places, goal pages under an area (create the area first if needed). Passing mentions never create pages.",
    input_schema: obj({
      parent: str("p: ref of the parent page"), kind: { type: "string", enum: ["area", "project", "goal", "person", "place"] },
      title: str(), about: str("1-3 sentences, permanent facts only"), other_names: { type: "array", items: str() },
      goal_slug: str("Goal pages only: the goal's slug"),
    }, ["parent", "kind", "title"]),
  },
  { name: "add_other_name", description: "Add an alternate name to a page (Ana for Anna).", input_schema: obj({ page: str("p: ref"), name: str() }, ["page", "name"]) },
  { name: "correct_about", description: "Correct a page's About (corrections only, not updates for new information).", input_schema: obj({ page: str("p: ref"), about: str("1-3 sentences") }, ["page", "about"]) },
  { name: "write_daily_summary", description: "Write the day's summary. Exactly once, required. What happened with their step, how they sounded, anything new. Passing mentions go here as one line, not as entries.", input_schema: obj({ text: str("A few sentences") }, ["text"]) },
];

function str(description?: string) {
  return description ? { type: "string", description } : { type: "string" };
}
function obj(properties: Record<string, unknown>, required: string[]): Anthropic.Tool.InputSchema {
  return { type: "object", properties, required };
}

// ─── Writer context ─────────────────────────────────────────────────────

interface V2DayContext {
  db: Db;
  tester: Tester;
  date: string;
  at: Date;
  /** Pages opened this pass (read-before-write enforcement). */
  openedPages: Set<string>;
  /** Pages created this pass (also writable). */
  createdPages: Set<string>;
  wroteDaily: boolean;
  /** All inbound message IDs from this day (for source validation). */
  dayMessageIds: Set<string>;
  /** The sensitive checker model (Haiku). */
  checker: ClaudeModel;
  /** Forget topics for this tester. */
  forgetTopics: string[];
}

type ToolOutcome = { ok: true; message: string } | { ok: false; error: string };

/** Check that a page has been opened or created this pass. */
function isWritable(ctx: V2DayContext, pageId: string): boolean {
  return ctx.openedPages.has(pageId) || ctx.createdPages.has(pageId);
}

/** Validate a source ref is from an inbound message on this day. */
async function validateSource(ctx: V2DayContext, sourceRef: string): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const prefix = sourceRef.trim().toLowerCase().replace(/^m:/, "");
  // Check if any day message ID starts with this prefix
  for (const id of ctx.dayMessageIds) {
    if (id.startsWith(prefix)) return { ok: true, messageId: id };
  }
  return { ok: false, error: `${sourceRef} is not an inbound message from today's transcript.` };
}

/** Resolve person page refs to IDs. */
async function resolvePersonPages(ctx: V2DayContext, refs: string[] | undefined): Promise<string[] | undefined> {
  if (!refs?.length) return undefined;
  const ids: string[] = [];
  for (const r of refs) {
    const p = await findV2Page(ctx.db, ctx.tester.id, r);
    if (p?.kind === "person") ids.push(p.id);
  }
  return ids.length > 0 ? ids : undefined;
}

export async function runV2KeeperTool(ctx: V2DayContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (!(name in schemas)) return { ok: false, error: `Unknown tool "${name}"` };
  const parsed = schemas[name as V2KeeperToolName].safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }

  switch (name as V2KeeperToolName) {
    case "open_pages": {
      const { pages } = parsed.data as z.infer<typeof schemas.open_pages>;
      const out: string[] = [];
      for (const r of pages) {
        const page = await findV2Page(ctx.db, ctx.tester.id, r);
        if (!page) { out.push(`${r}: no such page`); continue; }
        ctx.openedPages.add(page.id);
        out.push(await renderV2PageFull(ctx.db, ctx.tester, page));
      }
      return { ok: true, message: out.join("\n\n") };
    }

    case "add_entry": {
      const input = parsed.data as z.infer<typeof schemas.add_entry>;
      const page = await findV2Page(ctx.db, ctx.tester.id, input.page);
      if (!page) return { ok: false, error: `No page ${input.page} for this tester.` };
      if (!isWritable(ctx, page.id)) return { ok: false, error: `Page ${input.page} hasn't been opened this pass. Call open_pages first.` };
      // Source validation
      const src = await validateSource(ctx, input.source);
      if (!src.ok) return { ok: false, error: src.error };
      // No inferences in the nightly pass
      // Dated types need a when
      if (["todo", "event", "followup"].includes(input.type) && !input.when) {
        return { ok: false, error: `${input.type} entries require a 'when' date.` };
      }
      // Sensitive check
      const textToCheck = [input.text, input.detail].filter(Boolean).join(" ");
      const rejection = await sensitiveCheck(ctx.checker, textToCheck, ctx.forgetTopics);
      if (rejection) return { ok: false, error: `Not saved: ${rejection}` };

      const people = await resolvePersonPages(ctx, input.people);
      const entry = await addV2Entry(ctx.db, {
        pageId: page.id, testerId: ctx.tester.id, type: input.type, text: input.text,
        detail: input.detail, when: input.when, asOf: input.as_of, origin: "stated",
        sourceMessageId: src.messageId, learnedOn: ctx.date, people,
      }, ctx.at);
      return { ok: true, message: `Added ${v2EntryRef(entry.id)} to ${v2PageRef(page.id)}: ${entry.text}` };
    }

    case "correct_entry": {
      const input = parsed.data as z.infer<typeof schemas.correct_entry>;
      const entry = await findV2Entry(ctx.db, ctx.tester.id, input.entry);
      if (!entry) return { ok: false, error: `No entry ${input.entry} for this tester.` };
      if (!isWritable(ctx, entry.pageId)) return { ok: false, error: `The page for ${input.entry} hasn't been opened this pass.` };
      // Sensitive check on new text
      const newText = input.text ?? entry.text;
      const rejection = await sensitiveCheck(ctx.checker, [newText, input.detail].filter(Boolean).join(" "), ctx.forgetTopics);
      if (rejection) return { ok: false, error: `Not saved: ${rejection}` };

      const people = await resolvePersonPages(ctx, input.people);
      await correctV2Entry(ctx.db, entry, { text: input.text, detail: input.detail, when: input.when, asOf: input.as_of, people }, ctx.at);
      return { ok: true, message: `Corrected ${v2EntryRef(entry.id)}` };
    }

    case "replace_entry": {
      const input = parsed.data as z.infer<typeof schemas.replace_entry>;
      const entry = await findV2Entry(ctx.db, ctx.tester.id, input.entry);
      if (!entry) return { ok: false, error: `No entry ${input.entry} for this tester.` };
      if (!isWritable(ctx, entry.pageId)) return { ok: false, error: `The page for ${input.entry} hasn't been opened this pass.` };
      const src = await validateSource(ctx, input.source);
      if (!src.ok) return { ok: false, error: src.error };
      // Sensitive check
      const rejection = await sensitiveCheck(ctx.checker, [input.text, input.detail].filter(Boolean).join(" "), ctx.forgetTopics);
      if (rejection) return { ok: false, error: `Not saved: ${rejection}` };

      const people = await resolvePersonPages(ctx, input.people);
      const newEntry = await replaceV2Entry(ctx.db, entry, {
        pageId: entry.pageId, testerId: ctx.tester.id, type: entry.type, text: input.text,
        detail: input.detail, when: input.when ?? entry.when ?? undefined, asOf: input.as_of,
        origin: "stated", sourceMessageId: src.messageId, learnedOn: ctx.date, people,
      }, ctx.at);
      return { ok: true, message: `Replaced ${v2EntryRef(entry.id)} → ${v2EntryRef(newEntry.id)}: ${newEntry.text}` };
    }

    case "close_entry": {
      const input = parsed.data as z.infer<typeof schemas.close_entry>;
      const entry = await findV2Entry(ctx.db, ctx.tester.id, input.entry);
      if (!entry) return { ok: false, error: `No entry ${input.entry} for this tester.` };
      const result = await closeV2Entry(ctx.db, entry, input.status, ctx.at);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, message: `Closed ${v2EntryRef(entry.id)} as ${input.status}` };
    }

    case "create_page": {
      const input = parsed.data as z.infer<typeof schemas.create_page>;
      const parent = await findV2Page(ctx.db, ctx.tester.id, input.parent);
      if (!parent) return { ok: false, error: `No page ${input.parent} for this tester.` };
      // Sensitive check on title and about
      const toCheck = [input.title, input.about].filter(Boolean).join(" ");
      const rejection = await sensitiveCheck(ctx.checker, toCheck, ctx.forgetTopics);
      if (rejection) return { ok: false, error: `Not saved: ${rejection}` };

      // Validate goal_slug exists in the goals table
      if (input.goal_slug) {
        const goalTitle = await getGoalTitle(ctx.db, input.goal_slug);
        if (!goalTitle) return { ok: false, error: `No goal with slug "${input.goal_slug}". Use the exact slug from the TRACKER GOALS list.` };
      }
      const pageInput: CreateV2PageInput = {
        kind: input.kind, title: input.title, about: input.about,
        otherNames: input.other_names, goalSlug: input.goal_slug, parentId: parent.id,
      };
      const result = await createV2Page(ctx.db, ctx.tester.id, pageInput, ctx.at);
      if (!result.ok) return { ok: false, error: result.error };
      ctx.createdPages.add(result.value.id);
      return { ok: true, message: `Created ${v2PageRef(result.value.id)} ${result.value.title}` };
    }

    case "add_other_name": {
      const input = parsed.data as z.infer<typeof schemas.add_other_name>;
      const page = await findV2Page(ctx.db, ctx.tester.id, input.page);
      if (!page) return { ok: false, error: `No page ${input.page} for this tester.` };
      const names = [...page.otherNames, input.name];
      await updateV2Page(ctx.db, page, { otherNames: names }, ctx.at);
      return { ok: true, message: `Added other name "${input.name}" to ${v2PageRef(page.id)}` };
    }

    case "correct_about": {
      const input = parsed.data as z.infer<typeof schemas.correct_about>;
      const page = await findV2Page(ctx.db, ctx.tester.id, input.page);
      if (!page) return { ok: false, error: `No page ${input.page} for this tester.` };
      // Sensitive check
      const rejection = await sensitiveCheck(ctx.checker, input.about, ctx.forgetTopics);
      if (rejection) return { ok: false, error: `Not saved: ${rejection}` };
      await updateV2Page(ctx.db, page, { about: input.about }, ctx.at);
      return { ok: true, message: `Corrected About for ${v2PageRef(page.id)}` };
    }

    case "write_daily_summary": {
      const input = parsed.data as z.infer<typeof schemas.write_daily_summary>;
      if (ctx.wroteDaily) return { ok: false, error: "Today's daily summary is already written." };
      // Sensitive check
      const rejection = await sensitiveCheck(ctx.checker, input.text, ctx.forgetTopics);
      if (rejection) return { ok: false, error: `Not saved: ${rejection}` };
      const allMsgIds = await v2AllMessageIdsOn(ctx.db, ctx.tester, ctx.date);
      await writeV2Daily(ctx.db, ctx.tester.id, ctx.date, input.text, allMsgIds, ctx.at);
      ctx.wroteDaily = true;
      return { ok: true, message: "Daily summary saved. Stop now unless something is still unfiled." };
    }
  }
}

// ─── Page rendering ─────────────────────────────────────────────────────

/** Render a v2 page in full for the writer (About, entries with refs, children, links). */
async function renderV2PageFull(db: Db, tester: Tester, page: MemoryV2Page): Promise<string> {
  const path = await pagePath(db, page);
  const lines = [`${v2PageRef(page.id)} ${path} [${page.kind}${page.status !== "active" ? `, ${page.status}` : ""}]`];
  if (page.otherNames.length > 0) lines.push(`Also known as: ${page.otherNames.join(", ")}`);
  if (page.about) lines.push(`About: ${page.about}`);

  const entries = await getV2Entries(db, page.id);
  const current = entries.filter((e) => e.status === "current" || e.status === "open");
  const history = entries.filter((e) => e.status === "expired" || e.status === "done" || e.status === "dropped");

  if (current.length > 0) {
    for (const e of current) {
      const people = await getV2EntryPeople(db, e.id);
      const ppl = people.length > 0 ? ` [people: ${people.map((p) => v2PageRef(p.id)).join(", ")}]` : "";
      const when = e.when ? ` (${e.when})` : "";
      const asOf = e.asOf ? ` (as of ${e.asOf})` : "";
      lines.push(`- ${v2EntryRef(e.id)} [${e.type}] ${e.text}${when}${asOf}${ppl}`);
      if (e.detail) lines.push(`  Detail: ${e.detail}`);
    }
  }

  if (history.length > 0) {
    lines.push(`History (${history.length} entries): ${history.map((e) => `${v2EntryRef(e.id)} [${e.type}, ${e.status}] ${e.text.slice(0, 60)}`).join("; ")}`);
  }

  const children = await getV2Children(db, page.id);
  if (children.length > 0) {
    lines.push("Children:");
    for (const c of children) {
      lines.push(`  ${v2PageRef(c.id)} [${c.kind}${c.status !== "active" ? `, ${c.status}` : ""}] ${c.title}${c.about ? ` — ${c.about}` : ""}`);
    }
  }

  const links = await getV2Links(db, page.id);
  if (links.length > 0) {
    const linkLines: string[] = [];
    for (const l of links) {
      const other = l.fromPageId === page.id ? l.toPageId : l.fromPageId;
      const otherPage = await findV2Page(db, tester.id, other);
      if (otherPage) linkLines.push(`${l.kind}: ${v2PageRef(otherPage.id)} ${otherPage.title}`);
    }
    if (linkLines.length > 0) lines.push(`Links: ${linkLines.join("; ")}`);
  }

  return lines.join("\n");
}

/** Build the path string for a page (Root > Coaching, etc.). */
async function pagePath(db: Db, page: MemoryV2Page): Promise<string> {
  const parts = [page.title];
  let current = page;
  const seen = new Set([page.id]);
  while (current.parentId) {
    const [parent] = await db.select().from(memoryV2Pages).where(eq(memoryV2Pages.id, current.parentId)).limit(1);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    parts.unshift(parent.title);
    current = parent;
  }
  return parts.join(" > ");
}

// ─── Writer instructions ────────────────────────────────────────────────

export const V2_KEEPER_INSTRUCTIONS = `You keep the memory of ZOH, a texting coach. Each night you read one day of texts between ZOH and one tester, and file what matters into their memory tree: a hierarchy of pages with typed entries.

## The tree
- Tier 0: Root (the person as a whole)
- Tier 1: Coaching (how to coach them), People, Places, and areas of life (Work, Running, etc.)
- Tier 2: Specific people, places, goals, projects under their tier-1 parent

## How to file
1. **Read before write:** open_pages any page you need to write to. Writes to unopened pages are rejected.
2. **Source every entry:** cite the m: ref of the tester's own text it came from. ZOH's texts are context, not sources.
3. **Dates are real dates:** "next Saturday" said on Fri Oct 10 → 2025-10-18. Dated types (todo, event, followup) need a YYYY-MM-DD date; code rejects them without one.
4. **No inferences nightly:** only file what they said or clearly showed. Observations of texting style or reply timing wait for the weekly pass and are never filed by this nightly pass.
5. **Placement:** person pages under People, place pages under Places, goal pages under their area (create the area first if needed). First match wins: an existing page > an entry > a new tier-2 page (if it'll keep coming up) > a new tier-1 area (a new part of life).
6. **Passing mentions:** a detail that doesn't touch their life, wants, people, plans or coaching goes in the daily summary as one line, never as an entry. Anything that matters is filed at once, even if said only once.
7. **Prefer their own words.** When they say why they're here, what they want or how they feel, use their words ("stop feeling dead all the time"), not a cleaned-up version.

## Tracker data — do not copy
The day's tracker records (THE STEP THAT DAY) are already recorded by the app. Never file them as entries: no events for planned or completed steps, no notes about the plan details, no facts about run times, distances, or proof results. Only file **durable meaning the tester expressed**: why the goal matters to them in their own words, what has and hasn't worked for them, a reason they gave for a miss. The plan itself is shown to the coach separately; don't copy it.

## Correct vs replace vs close
| Situation | Action | Example |
|---|---|---|
| The entry was wrong | correct_entry (edits in place) | "Anna, not Ana" |
| The world changed | replace_entry (new entry, old → history) | "She picked Clemson" replaces "heading to Clemson" |
| A dated thing happened or was dropped | close_entry (done or dropped) | The wedding happened → done |

## About rule
1-3 sentences on what the page is. Test: would it still be true after the page is finished? Never restate children's facts. Corrections only (correct_about), not updates.

## Coaching page
Only what the tester stated outright about how they want to be coached: "don't text 8am-2pm", "less hype". Never observed texting style, reply timing, reply length, or tone — those wait for the weekly pass.

## Sensitive content
Every write passes a privacy check. It rejects health, medication, mental-health and money details beyond what their step needs, and anything about a topic they asked to forget. If rejected, drop or reword it.

## Daily summary
write_daily_summary exactly once (required). Describe the person's day only: what happened, how they sounded, anything new they said. Never narrate what you filed, created, left out or decided ("I created", "I filed", "I left out"). Never mention that something sensitive was omitted.

## Goal pages
Every tracker goal must have exactly one goal page under its area by the end of your pass. When a new goal appears in the tracker records, create its area (if new) and goal page. When a goal is switched, mark the old page "past" and add a "leads_to" link with the reason.`;

// ─── Context building ───────────────────────────────────────────────────

async function v2ContextBlock(db: Db, tester: Tester, date: string): Promise<string> {
  const pages = await getV2Pages(db, tester.id);
  // Build tree map: each page's path, title, kind, status, About (no entries)
  const treeLines: string[] = [];
  for (const p of pages) {
    const path = await pagePath(db, p);
    const names = p.otherNames.length > 0 ? ` (also: ${p.otherNames.join(", ")})` : "";
    const status = p.status !== "active" ? ` [${p.status}]` : "";
    const about = p.about ? ` — ${p.about}` : "";
    treeLines.push(`${v2PageRef(p.id)} [${p.kind}${status}] ${path}${names}${about}`);
  }

  // Open dated items
  const openDated = await getV2OpenDated(db, tester.id);
  const datedLines = openDated.map((e) => `${v2EntryRef(e.id)} [${e.type}] ${e.text} (${e.when}) on ${e.pagePath}`);

  // Recent daily summaries
  const dailies = await getV2Dailies(db, tester.id, 7);
  const dailyLines = dailies.map((d) => `${d.date}: ${d.summary}`);

  // Tracker goals (so the writer knows the slugs)
  const goalRows = await db.select().from(testerGoals).where(eq(testerGoals.testerId, tester.id));
  const goalSlugs = goalRows.map((r) => r.goalSlug);
  const goalInfos: string[] = [];
  for (const slug of goalSlugs) {
    const title = await getGoalTitle(db, slug);
    const hasPage = await getV2GoalPage(db, tester.id, slug);
    goalInfos.push(`${slug} "${title ?? slug}" (role: ${goalRows.find((r) => r.goalSlug === slug)?.role ?? "unknown"}${hasPage ? ", has goal page" : ", needs goal page"})`);
  }

  return [
    `TESTER: ${tester.name ?? "(name not given)"}, phase ${tester.phase}. Today you're filing ${weekdayOf(date)} ${date} (their time).`,
    goalInfos.length > 0 ? `TRACKER GOALS (use the slug as goal_slug when creating a goal page)\n${goalInfos.join("\n")}` : "",
    `TREE MAP (every page's path, kind, status, About — no entries; use open_pages to read)\n${treeLines.join("\n") || "(no pages yet)"}`,
    openDated.length > 0 ? `OPEN DATED ITEMS (todos, events, follow-ups)\n${datedLines.join("\n")}` : "",
    dailies.length > 0 ? `LAST ${dailies.length} DAILY SUMMARIES\n${dailyLines.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

// ─── Goal page check (end of pass) ─────────────────────────────────────

/** Check that every tracker goal has a v2 goal page. Returns missing slugs. */
async function missingGoalPages(db: Db, tester: Tester): Promise<string[]> {
  // Get all tracker goals for this tester
  const testerGoalRows = await db.select({ goalSlug: testerGoals.goalSlug }).from(testerGoals).where(eq(testerGoals.testerId, tester.id));
  const trackerSlugs = testerGoalRows.map((r) => r.goalSlug);
  const existingSlugs = await getV2GoalSlugs(db, tester.id);
  return trackerSlugs.filter((s) => !existingSlugs.includes(s));
}

// ─── Main writeDay ──────────────────────────────────────────────────────

/**
 * Files one day for one v2 tester. Returns true if the day had inbound texts.
 */
export async function writeV2Day(
  db: Db,
  writerModel: ClaudeModel,
  checker: ClaudeModel,
  tester: Tester,
  date: string,
  at: Date,
  log?: Logger,
): Promise<boolean> {
  const texts = await v2TextsOn(db, tester, date);
  if (!texts.some((m) => m.direction === "inbound")) return false;
  await ensureV2RequiredPages(db, tester, at);

  const forgetTopics = await getV2ForgetTopics(db, tester.id);
  // Collect inbound message IDs for source validation
  const inboundMsgIds = new Set(texts.filter((m) => m.direction === "inbound").map((m) => m.id));

  const [day] = await db.select().from(stepDays).where(and(eq(stepDays.testerId, tester.id), eq(stepDays.date, date)));
  const ctx: V2DayContext = {
    db, tester, date, at, openedPages: new Set(), createdPages: new Set(),
    wroteDaily: false, dayMessageIds: inboundMsgIds, checker, forgetTopics,
  };

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: V2_KEEPER_INSTRUCTIONS, cache_control: { type: "ephemeral" } },
    { type: "text", text: await v2ContextBlock(db, tester, date) },
  ];
  const transcript = texts.map((m) => transcriptLine(m, tester)).join("\n");
  const claudeMessages: Anthropic.MessageParam[] = [
    { role: "user", content: `TEXTS ON ${weekdayOf(date).toUpperCase()} ${date}\n${transcript}\n\n${stepLine(day)}` },
  ];

  for (let round = 1; round <= V2_KEEPER_MAX_ROUNDS; round++) {
    const last = round === V2_KEEPER_MAX_ROUNDS;
    const response = await writerModel.create({ system, messages: claudeMessages, tools: V2_KEEPER_TOOLS, toolChoice: last ? "none" : "auto" });
    const calls = response.content.filter((b) => b.type === "tool_use");
    if (calls.length === 0 || last) break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const outcome = await runV2KeeperTool(ctx, call.name, call.input);
      results.push({ type: "tool_result", tool_use_id: call.id, ...(outcome.ok ? { content: outcome.message } : { content: outcome.error, is_error: true }) });
    }
    claudeMessages.push({ role: "assistant", content: response.raw ?? (response.content as Anthropic.ContentBlockParam[]) });
    claudeMessages.push({ role: "user", content: results });
  }

  // End-of-pass: check for missing goal pages
  const missing = await missingGoalPages(db, tester);
  if (missing.length > 0) {
    const goalDescs: string[] = [];
    for (const slug of missing) {
      const title = await getGoalTitle(db, slug);
      goalDescs.push(`"${title ?? slug}" (goal_slug: "${slug}")`);
    }
    const suffix = ctx.wroteDaily ? "" : " Then write the daily summary and stop.";
    const prompt = `These tracker goals still need a goal page (create each under the right area, creating the area if needed; use the goal_slug shown): ${goalDescs.join(", ")}.${suffix}`;
    claudeMessages.push({ role: "user", content: prompt });
    for (let round = 0; round < 4; round++) {
      const response = await writerModel.create({ system, messages: claudeMessages, tools: V2_KEEPER_TOOLS, toolChoice: round === 3 ? "none" : "auto" });
      const calls = response.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) break;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const outcome = await runV2KeeperTool(ctx, call.name, call.input);
        results.push({ type: "tool_result", tool_use_id: call.id, ...(outcome.ok ? { content: outcome.message } : { content: outcome.error, is_error: true }) });
      }
      claudeMessages.push({ role: "assistant", content: response.raw ?? (response.content as Anthropic.ContentBlockParam[]) });
      claudeMessages.push({ role: "user", content: results });
    }
  }

  // If writer never wrote the daily summary, write a plain one
  if (!ctx.wroteDaily) {
    log?.warn({ contact: maskNumber(tester.phone), date }, "V2 memory pass wrote no daily summary; saving a plain one");
    const theirs = texts.filter((m) => m.direction === "inbound").length;
    const allMsgIds = await v2AllMessageIdsOn(db, tester, date);
    await writeV2Daily(db, tester.id, date, `${theirs} text${theirs === 1 ? "" : "s"} from them; no summary written.`, allMsgIds, at);
  }

  return true;
}

// ─── V2 render for snapshots ────────────────────────────────────────────

/** Render all v2 memory as text for lab snapshots and debugging. */
export async function renderV2Memory(db: Db, tester: Tester): Promise<string> {
  const pages = await getV2Pages(db, tester.id);
  const sections: string[] = [];

  for (const page of pages) {
    sections.push(await renderV2PageFull(db, tester, page));
  }

  const dailies = await getV2Dailies(db, tester.id, 100);
  if (dailies.length > 0) {
    sections.push("DAILY SUMMARIES");
    for (const d of dailies) {
      sections.push(`${d.date}: ${d.summary}`);
    }
  }

  return sections.join("\n\n");
}
