import type Anthropic from "@anthropic-ai/sdk";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import type { ClaudeModel } from "../claude/replier.js";
import type { Db } from "../db/client.js";
import { memoryPages, testers, type MemoryPage, type Message, type Tester } from "../db/schema.js";
import { safeError } from "../errors.js";
import { localDate } from "../coach/state.js";
import { addDays, localClock, weekdayOf } from "../nudges/schedule.js";
import { maskNumber, type Logger } from "../pipeline/inbound.js";
import { isJumping, testerNow } from "../testers/clock.js";
import { getTester, updateTester } from "../testers/testers.js";
import { renderPage, renderTimeline } from "./render.js";
import {
  addFact,
  createPage,
  ensureCorePages,
  ensureGoalPages,
  findFact,
  findMessage,
  findPage,
  getPages,
  LEARN_AFTER,
  link,
  mediaLabel,
  mediaText,
  messageRef,
  messageTime,
  observationCount,
  pageRef,
  removeFact,
  textsOn,
  timeline,
  updateFact,
  updatePage,
} from "./store.js";

/**
 * The overnight memory pass (spec: GitHub issue "Coach memory"). At 3 am in each tester's time
 * zone it reads the day that just ended and files it: a daily doc, facts on the right pages,
 * links, and observations toward learned preferences. One run per tester-day, never repeated.
 */

/** Local time the pass runs for the day before. */
export const MEMORY_RUN_AT = "03:00";
/** On a tester's first run, how far back it reads (texts from before memory existed). */
export const BACKFILL_DAYS = 14;
/** Claude calls per day written; the last one can't use tools. */
export const KEEPER_MAX_ROUNDS = 10;
/** Output budget per call: a daily doc plus a round of tool calls, thinking included. */
export const KEEPER_MAX_TOKENS = 8000;
/** Wait after a failed day before trying that tester again. */
export const RETRY_AFTER_MS = 60 * 60_000;

export const KEEPER_INSTRUCTIONS = `You keep the memory of ZOH, a texting coach. Each night you read one day of texts between ZOH and one tester, and file what matters into their memory: a small wiki of pages made of short facts. The coach reads these pages every day to coach them well, so be accurate, specific and brief.

Pages:
- Their own page (kind self): who they are, life, work, schedule, values, likes and dislikes, habits. Under section "voice": how they text (length, shorthand like "u" or "lol", emoji, swearing, tone).
- Preferences (kind preferences): how they like to be coached. Section "stated": things they said outright ("less hype", "photos are a pain, I'll send voice notes"). Observations and learned preferences are recorded with their own tools (below).
- Goal pages: why the goal matters to them in their own words, what has and hasn't worked. The plan itself is already shown; don't copy it.
- Person and subject pages: one for every real person, pet, place, group, event, project or thing in their life, even if mentioned once ("my dog Max helps me sleep" → a page for Max; their sister Ana; their running club; a trip next month). Not for passing mentions or general topics ("saw a cute dog today", "dogs are the best"): a general like, opinion or habit goes as a fact on the right person's page instead ("I love dogs" → their own page; "my sister's obsessed with dogs" → the sister's page).

How to file:
- Check the index first: update an existing page rather than making a second one for the same person or thing. A correction ("Anna, not Ana") updates the fact or title.
- Titles say who or what it is on their own ("Ana (his sister)", "Max (his dog)", "Knee injury (left knee, Oct)"). The summary is one line.
- Facts are short, specific and in plain words, each citing the text it came from (an m: ref from today's texts). Only what they actually said or clearly showed: never guess, never embellish. Prefer their words.
- Link pages that belong together ("related": Ana ↔ the reading goal she does with them).
- Never store sensitive health, mental-health, legal or financial details beyond what their step needs (a bad knee that changes their workout: yes; a diagnosis, medication or money trouble: no), and never anyone's phone number, email or address.
- ZOH's own texts are context, not facts about the tester.
- Anything listed under "Asked to forget" on the preferences page is never filed, and any fact about it is removed.

Preferences from evidence:
- record_observation when today shows how they respond to a kind of coaching: which texts got a quick reply or a done step and which were ignored (hype or calm, a challenge or a reason why, morning or evening, a joke or straight talk). The label names what today's evidence shows, and every observation under a label must support it (observations are counted toward that pattern): a late reply never goes under "replies fast…". Reuse an existing label only when today shows the same thing.
- learn_preference only once a pattern has at least ${LEARN_AFTER} observations on ${LEARN_AFTER} different days (the app checks). One moment is never a pattern: a bad day is just a bad day.
- A stated preference always wins: if they state the opposite of a learned one, remove the learned one.

Finally, write_daily_doc exactly once: a title like "Tue Oct 27: 10 pages, Ana joined", a one-line summary, and a short body (a few sentences): what happened with their step, how they sounded, anything new learned. It records the day, not advice or conclusions (those come only from patterns). Then stop (reply with no tool calls).`;

const text = (max: number) => z.string().trim().min(1).max(max);
const ref = text(40);

const schemas = {
  open_page: z.object({ page: ref }).strict(),
  create_page: z
    .object({
      kind: z.enum(["person", "subject"]),
      title: text(80),
      summary: text(200),
      facts: z.array(z.object({ text: text(300), source: ref }).strict()).max(10).optional(),
      related: z.array(ref).max(5).optional(),
    })
    .strict(),
  update_page: z.object({ page: ref, title: text(80).optional(), summary: text(200).optional() }).strict(),
  add_fact: z.object({ page: ref, text: text(300), source: ref, section: z.enum(["stated", "voice"]).optional() }).strict(),
  update_fact: z.object({ fact: ref, text: text(300), source: ref }).strict(),
  remove_fact: z.object({ fact: ref }).strict(),
  link_pages: z.object({ from: ref, to: ref }).strict(),
  record_observation: z.object({ pattern: text(60), text: text(300), source: ref }).strict(),
  learn_preference: z.object({ pattern: text(60), text: text(300) }).strict(),
  write_daily_doc: z.object({ title: text(100), summary: text(200), body: text(1500) }).strict(),
};

type KeeperToolName = keyof typeof schemas;

export const KEEPER_TOOLS: Anthropic.Tool[] = [
  { name: "open_page", description: "Read a page in full, with its facts' refs.", input_schema: obj({ page: str("p: ref") }, ["page"]) },
  {
    name: "create_page",
    description: "A new person or subject page, with its first facts. Check the index first.",
    input_schema: obj(
      {
        kind: { type: "string", enum: ["person", "subject"] },
        title: str("Who or what, on its own"),
        summary: str("One line"),
        facts: { type: "array", items: obj({ text: str(), source: str("m: ref") }, ["text", "source"]) },
        related: { type: "array", items: str("p: ref"), description: "Pages to link as related" },
      },
      ["kind", "title", "summary"],
    ),
  },
  { name: "update_page", description: "Change a page's title or one-line summary.", input_schema: obj({ page: str(), title: str(), summary: str() }, ["page"]) },
  {
    name: "add_fact",
    description: 'Add a fact to a page. section "stated" (preferences page) or "voice" (their own page); otherwise leave it out.',
    input_schema: obj({ page: str("p: ref"), text: str(), source: str("m: ref"), section: { type: "string", enum: ["stated", "voice"] } }, ["page", "text", "source"]),
  },
  { name: "update_fact", description: "Correct or refresh a fact.", input_schema: obj({ fact: str("f: ref"), text: str(), source: str("m: ref") }, ["fact", "text", "source"]) },
  { name: "remove_fact", description: "Remove a fact that's wrong or no longer true.", input_schema: obj({ fact: str("f: ref") }, ["fact"]) },
  { name: "link_pages", description: "Link two pages as related.", input_schema: obj({ from: str("p: ref"), to: str("p: ref") }, ["from", "to"]) },
  {
    name: "record_observation",
    description: "Evidence of how they respond to a kind of coaching, under a short pattern label (reuse existing labels).",
    input_schema: obj({ pattern: str('e.g. "replies fast to challenges"'), text: str("What happened today"), source: str("m: ref") }, ["pattern", "text", "source"]),
  },
  {
    name: "learn_preference",
    description: `Turn a pattern into a learned preference; needs ${LEARN_AFTER}+ observations on ${LEARN_AFTER}+ different days.`,
    input_schema: obj({ pattern: str(), text: str("The preference, as advice to the coach") }, ["pattern", "text"]),
  },
  {
    name: "write_daily_doc",
    description: "Today's daily doc. Exactly once, last.",
    input_schema: obj({ title: str(), summary: str("One line"), body: str("A few sentences") }, ["title", "summary", "body"]),
  },
];

function str(description?: string) {
  return description ? { type: "string", description } : { type: "string" };
}
function obj(properties: Record<string, unknown>, required: string[]): Anthropic.Tool.InputSchema {
  return { type: "object", properties, required };
}

interface DayContext {
  db: Db;
  tester: Tester;
  date: string;
  at: Date;
  wroteDoc: boolean;
}

type ToolOutcome = { ok: true; message: string } | { ok: false; error: string };

/** Runs one tool call for the pass; bad input or a ref outside this tester comes back as an error. */
export async function runKeeperTool(ctx: DayContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (!(name in schemas)) return { ok: false, error: `Unknown tool "${name}"` };
  const parsed = schemas[name as KeeperToolName].safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  const { db, tester, at, date } = ctx;
  const page = async (r: string) => findPage(db, tester.id, r);
  const source = async (r: string) => {
    const m = await findMessage(db, tester, r);
    return m && m.direction === "inbound" ? m : undefined;
  };
  const noPage = (r: string) => ({ ok: false as const, error: `No page ${r} for this tester; check the index.` });
  const noSource = (r: string) => ({ ok: false as const, error: `${r} isn't one of the tester's own texts; cite the m: ref of what they said.` });

  switch (name as KeeperToolName) {
    case "open_page": {
      const { page: r } = parsed.data as z.infer<typeof schemas.open_page>;
      const p = await page(r);
      return p ? { ok: true, message: await renderPage(db, tester, p, { refs: true }) } : noPage(r);
    }
    case "create_page": {
      const input = parsed.data as z.infer<typeof schemas.create_page>;
      const sources: Message[] = [];
      for (const f of input.facts ?? []) {
        const m = await source(f.source);
        if (!m) return noSource(f.source);
        sources.push(m);
      }
      const related: MemoryPage[] = [];
      for (const r of input.related ?? []) {
        const p = await page(r);
        if (!p) return noPage(r);
        related.push(p);
      }
      const created = await createPage(db, tester.id, { kind: input.kind, title: input.title, summary: input.summary }, at);
      for (const [i, f] of (input.facts ?? []).entries()) {
        await addFact(db, created, { text: f.text, sourceMessageId: sources[i]!.id, day: date }, at);
      }
      const self = (await getPages(db, tester.id, ["self"]))[0];
      // Every page hangs off their own page, so nothing in memory is an orphan.
      for (const p of self ? [self, ...related] : related) await link(db, tester.id, p.id, created.id, "related");
      return { ok: true, message: `Created ${pageRef(created.id)} ${created.title}` };
    }
    case "update_page": {
      const { page: r, title, summary } = parsed.data as z.infer<typeof schemas.update_page>;
      const p = await page(r);
      if (!p) return noPage(r);
      if (p.kind === "daily") return { ok: false, error: "Daily docs are written with write_daily_doc." };
      await updatePage(db, p, { ...(title ? { title } : {}), ...(summary ? { summary } : {}) }, at);
      return { ok: true, message: `Updated ${pageRef(p.id)}` };
    }
    case "add_fact": {
      const input = parsed.data as z.infer<typeof schemas.add_fact>;
      const p = await page(input.page);
      if (!p) return noPage(input.page);
      if (p.kind === "daily") return { ok: false, error: "Daily docs don't hold facts." };
      if (input.section === "stated" && p.kind !== "preferences") return { ok: false, error: 'section "stated" is for the preferences page.' };
      if (input.section === "voice" && p.kind !== "self") return { ok: false, error: 'section "voice" is for their own page.' };
      const m = await source(input.source);
      if (!m) return noSource(input.source);
      const f = await addFact(db, p, { text: input.text, sourceMessageId: m.id, section: input.section ?? "", day: date }, at);
      return { ok: true, message: `Added to ${pageRef(p.id)}: ${f.text}` };
    }
    case "update_fact": {
      const input = parsed.data as z.infer<typeof schemas.update_fact>;
      const f = await findFact(db, tester.id, input.fact);
      if (!f) return { ok: false, error: `No fact ${input.fact} for this tester.` };
      const m = await source(input.source);
      if (!m) return noSource(input.source);
      await updateFact(db, f, { text: input.text, sourceMessageId: m.id, day: date }, at);
      return { ok: true, message: "Fact updated" };
    }
    case "remove_fact": {
      const { fact: r } = parsed.data as z.infer<typeof schemas.remove_fact>;
      const f = await findFact(db, tester.id, r);
      if (!f) return { ok: false, error: `No fact ${r} for this tester.` };
      await removeFact(db, f, at);
      return { ok: true, message: "Fact removed" };
    }
    case "link_pages": {
      const { from, to } = parsed.data as z.infer<typeof schemas.link_pages>;
      const a = await page(from);
      const b = await page(to);
      if (!a) return noPage(from);
      if (!b) return noPage(to);
      await link(db, tester.id, a.id, b.id, "related");
      return { ok: true, message: "Linked" };
    }
    case "record_observation": {
      const input = parsed.data as z.infer<typeof schemas.record_observation>;
      const m = await findMessage(db, tester, input.source);
      if (!m) return noSource(input.source);
      const { preferences } = await ensureCorePages(db, tester, at);
      await addFact(db, preferences, { text: input.text, sourceMessageId: m.id, section: "observation", label: input.pattern, day: date }, at);
      const seen = await observationCount(db, tester.id, input.pattern);
      return { ok: true, message: `Observation saved (${seen.count} for "${input.pattern}", on ${seen.days} day${seen.days === 1 ? "" : "s"}).` };
    }
    case "learn_preference": {
      const input = parsed.data as z.infer<typeof schemas.learn_preference>;
      const seen = await observationCount(db, tester.id, input.pattern);
      if (seen.count < LEARN_AFTER || seen.days < LEARN_AFTER) {
        return {
          ok: false,
          error: `Not a pattern yet: "${input.pattern}" has ${seen.count} observation(s) on ${seen.days} day(s); it needs ${LEARN_AFTER} on ${LEARN_AFTER} different days.`,
        };
      }
      const { preferences } = await ensureCorePages(db, tester, at);
      await addFact(db, preferences, { text: input.text, sourceMessageId: seen.latest?.sourceMessageId ?? null, section: "learned", label: input.pattern, day: date }, at);
      return { ok: true, message: `Learned: ${input.text}` };
    }
    case "write_daily_doc": {
      const input = parsed.data as z.infer<typeof schemas.write_daily_doc>;
      if (ctx.wroteDoc) return { ok: false, error: "Today's daily doc is already written." };
      await writeDailyDoc(db, tester, date, input, at);
      ctx.wroteDoc = true;
      return { ok: true, message: "Daily doc saved. Stop now unless something is still unfiled." };
    }
  }
}

async function writeDailyDoc(db: Db, tester: Tester, date: string, doc: { title: string; summary: string; body: string }, at: Date): Promise<void> {
  await db
    .insert(memoryPages)
    .values({ testerId: tester.id, kind: "daily", date, ...doc, createdAt: at, updatedAt: at })
    .onConflictDoNothing();
}

/** One text as the pass reads it: time, ref, who, and what it held. */
export function transcriptLine(m: Message, tester: Tester): string {
  const who = m.direction === "inbound" ? "Tester" : "ZOH";
  const media = m.mediaUrl ? `[${mediaLabel(m)}: ${m.description ?? m.transcript ?? "not described"}] ` : "";
  return `[${localClock(messageTime(m), tester.timeZone)}] ${messageRef(m.id)} ${who}: ${media}${m.content ?? ""}`.trimEnd();
}

/** The part of the system prompt about this tester: their pages and the index. */
async function contextBlock(db: Db, tester: Tester, date: string): Promise<string> {
  const pages = await getPages(db, tester.id, ["self", "preferences", "goal"]);
  const core = pages.filter((p) => p.kind !== "goal" || p.status === "active");
  const rendered = await Promise.all(core.map((p) => renderPage(db, tester, p, { refs: true })));
  const others = (await getPages(db, tester.id, ["person", "subject", "goal"])).slice(0, 150);
  const items = await timeline(db, tester, 7);
  return [
    `TESTER: ${tester.name ?? "(name not given)"}, phase ${tester.phase}. Today you're filing ${weekdayOf(date)} ${date} (their time).`,
    `THEIR CORE PAGES\n${rendered.join("\n\n")}`,
    `INDEX OF OTHER PAGES (open one to see its facts)\n${others.map((p) => `${pageRef(p.id)} [${p.kind}] ${p.title} — ${p.summary}`).join("\n") || "(none yet)"}`,
    `RECENT\n${renderTimeline(items, tester)}`,
  ].join("\n\n");
}

/**
 * Files one day for one tester. Days without texts write nothing. If Claude never writes the
 * daily doc, a plain one is written so every texting day has exactly one.
 */
export async function writeDay(db: Db, model: ClaudeModel, tester: Tester, date: string, at: Date, log?: Logger): Promise<boolean> {
  const texts = await textsOn(db, tester, date);
  if (!texts.some((m) => m.direction === "inbound")) return false;
  await ensureCorePages(db, tester, at);
  await ensureGoalPages(db, tester, at);

  const ctx: DayContext = { db, tester, date, at, wroteDoc: false };
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: KEEPER_INSTRUCTIONS, cache_control: { type: "ephemeral" } },
    { type: "text", text: await contextBlock(db, tester, date) },
  ];
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `TEXTS ON ${weekdayOf(date).toUpperCase()} ${date}\n${texts.map((m) => transcriptLine(m, tester)).join("\n")}` },
  ];
  for (let round = 1; round <= KEEPER_MAX_ROUNDS; round++) {
    const last = round === KEEPER_MAX_ROUNDS;
    const response = await model.create({ system, messages, tools: KEEPER_TOOLS, toolChoice: last ? "none" : "auto" });
    const calls = response.content.filter((b) => b.type === "tool_use");
    if (calls.length === 0 || last) break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const outcome = await runKeeperTool(ctx, call.name, call.input);
      results.push({ type: "tool_result", tool_use_id: call.id, ...(outcome.ok ? { content: outcome.message } : { content: outcome.error, is_error: true }) });
    }
    messages.push({ role: "assistant", content: response.raw ?? (response.content as Anthropic.ContentBlockParam[]) });
    messages.push({ role: "user", content: results });
  }
  if (!ctx.wroteDoc) {
    log?.warn({ contact: maskNumber(tester.phone), date }, "Memory pass wrote no daily doc; saving a plain one");
    const theirs = texts.filter((m) => m.direction === "inbound").length;
    await writeDailyDoc(db, tester, date, { title: `${weekdayOf(date)} ${date}`, summary: `${theirs} text${theirs === 1 ? "" : "s"} from them; no summary written.`, body: "" }, at);
  }
  return true;
}

/** The days a tester's memory still needs, oldest first, as of `now`. */
export function daysDue(tester: Tester, now: Date): string[] {
  const today = localDate(now, tester.timeZone);
  const last = localClock(now, tester.timeZone) >= MEMORY_RUN_AT ? addDays(today, -1) : addDays(today, -2);
  const firstAllowed = localDate(tester.memorySince && tester.memorySince > tester.contextStartedAt ? tester.memorySince : tester.contextStartedAt, tester.timeZone);
  let from = tester.memoryThrough ? addDays(tester.memoryThrough, 1) : addDays(last, -(BACKFILL_DAYS - 1));
  if (from < firstAllowed) from = firstAllowed;
  const days: string[] = [];
  for (let d = from; d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

export interface MemoryKeeperDeps {
  db: Db;
  log: Logger;
  /** Without a model the pass never runs (and never marks a day done). */
  model?: ClaudeModel;
  /** Only these testers get memory (ALLOWED_NUMBERS). */
  allowedNumbers: string[];
  now?: () => Date;
}

export interface MemoryKeeper {
  /** One pass over every allowed tester, each on their own clock; ticks never overlap. Returns the days written per tester. */
  tick(now?: Date): Promise<Map<string, string[]>>;
  /** One tester at `now` on their clock, outside the ticks (a jump, #14). Returns the days written. */
  tickTester(tester: Tester, now: Date): Promise<string[]>;
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

export function createMemoryKeeper(deps: MemoryKeeperDeps): MemoryKeeper {
  const clock = deps.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  /** After a failed day, that tester waits this long before the next try, so an outage can't burn calls every minute. */
  const retryAfter = new Map<string, number>();

  async function run(now: Date): Promise<Map<string, string[]>> {
    const written = new Map<string, string[]>();
    if (!deps.model || deps.allowedNumbers.length === 0) return written;
    const rows = await deps.db.select().from(testers).where(inArray(testers.phone, deps.allowedNumbers));
    for (const row of rows) {
      // Mid-jump, the jump runs this tester's pass itself (#14).
      if (isJumping(row.id)) continue;
      const tester = (row.isTestUser && (await getTester(deps.db, row.id))) || row;
      const days = await forTester(tester, testerNow(tester, now));
      if (days.length) written.set(tester.id, days);
    }
    return written;
  }

  async function forTester(tester: Tester, now: Date): Promise<string[]> {
    const written: string[] = [];
    if (!deps.model || (retryAfter.get(tester.id) ?? 0) > now.getTime()) return written;
    const ctx = { contact: maskNumber(tester.phone) };
    for (const date of daysDue(tester, now)) {
      try {
        // Reloaded per day: the day before may have changed the tester's pages, never the row itself.
        if (await writeDay(deps.db, deps.model, tester, date, now, deps.log)) written.push(date);
        await updateTester(deps.db, tester.id, { memoryThrough: date });
        tester.memoryThrough = date;
      } catch (err) {
        deps.log.error({ ...ctx, date, err: safeError(err) }, "Memory pass failed; will retry in an hour");
        retryAfter.set(tester.id, now.getTime() + RETRY_AFTER_MS);
        break;
      }
    }
    return written;
  }

  return {
    tick(now = clock()) {
      const next = chain.then(() => run(now));
      chain = next.catch(() => undefined);
      return next;
    },
    tickTester(tester, now) {
      return forTester(tester, now);
    },
    start(intervalMs = 60_000) {
      if (timer) return;
      if (!deps.model) {
        deps.log.warn("Coach memory is off: Claude isn't configured");
        return;
      }
      timer = setInterval(() => {
        void this.tick().catch((err: unknown) => deps.log.error({ err: safeError(err) }, "Memory tick failed"));
      }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await chain;
    },
  };
}
