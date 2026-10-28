import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  flags,
  goals,
  memoryFacts,
  memoryForgotten,
  memoryLinks,
  memoryPages,
  messages,
  plans,
  type MemoryFact,
  type MemoryPage,
  type MemoryPageKind,
  type Message,
  type Tester,
} from "../db/schema.js";
import { mediaKind } from "../media/storage.js";
import { GOAL_SWITCH_FLAG } from "../coach/tools.js";
import { addDays, zonedTime } from "../nudges/schedule.js";

/**
 * Coach memory's data (spec: GitHub issue "Coach memory"). Everything here is scoped to one
 * tester: a page, fact or text from anyone else is never found, however it's referred to.
 * Claude refers to rows by short refs ("p:1a2b3c4d" pages, "f:…" facts, "m:…" texts).
 */

/** Characters of a uuid in a short ref: plenty to be unique within one tester's rows. */
export const REF_LENGTH = 8;
/** Preferences page sections. */
export const PREFERENCE_SECTIONS = ["stated", "learned", "observation"] as const;
/** A learned preference needs at least this many observations of its pattern, on as many different days. */
export const LEARN_AFTER = 3;

export const pageRef = (id: string) => `p:${id.slice(0, REF_LENGTH)}`;
export const factRef = (id: string) => `f:${id.slice(0, REF_LENGTH)}`;
export const messageRef = (id: string) => `m:${id.slice(0, REF_LENGTH)}`;

/** "p:1a2b3c4d" or "1a2b3c4d" → the hex prefix; undefined if it isn't one. */
function prefixOf(ref: string, kind: "p" | "f" | "m"): string | undefined {
  const raw = ref.trim().toLowerCase().replace(new RegExp(`^${kind}:`), "");
  return /^[0-9a-f-]{4,36}$/.test(raw) ? raw : undefined;
}

/**
 * When a text happened: Sendblue's sent time (what the nudge tick reads too), else when it was
 * stored. Memory files texts into days by this.
 */
export const sentTime = sql<Date>`coalesce(${messages.sentAt}, ${messages.createdAt})`;
export const messageTime = (m: Pick<Message, "sentAt" | "createdAt">): Date => m.sentAt ?? m.createdAt;

/** Texts memory may read for this tester: since their context started and since "forget everything". */
export function memoryStart(tester: Pick<Tester, "contextStartedAt" | "memorySince">): Date {
  return tester.memorySince && tester.memorySince > tester.contextStartedAt ? tester.memorySince : tester.contextStartedAt;
}

export async function findPage(db: Db, testerId: string, ref: string): Promise<MemoryPage | undefined> {
  const prefix = prefixOf(ref, "p");
  if (!prefix) return undefined;
  const rows = await db
    .select()
    .from(memoryPages)
    .where(and(eq(memoryPages.testerId, testerId), sql`${memoryPages.id}::text like ${`${prefix}%`}`))
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

export async function findFact(db: Db, testerId: string, ref: string): Promise<MemoryFact | undefined> {
  const prefix = prefixOf(ref, "f");
  if (!prefix) return undefined;
  const rows = await db
    .select()
    .from(memoryFacts)
    .where(and(eq(memoryFacts.testerId, testerId), sql`${memoryFacts.id}::text like ${`${prefix}%`}`))
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

/** One of the tester's own texts (in or out), never one from before memory may read. */
export async function findMessage(db: Db, tester: Tester, ref: string): Promise<Message | undefined> {
  const prefix = prefixOf(ref, "m");
  if (!prefix) return undefined;
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.contactNumber, tester.phone),
        gte(messages.createdAt, memoryStart(tester)),
        sql`${messages.id}::text like ${`${prefix}%`}`,
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

export async function getPages(db: Db, testerId: string, kinds?: MemoryPageKind[]): Promise<MemoryPage[]> {
  return db
    .select()
    .from(memoryPages)
    .where(and(eq(memoryPages.testerId, testerId), kinds ? inArray(memoryPages.kind, kinds) : undefined))
    .orderBy(desc(memoryPages.updatedAt), desc(memoryPages.id));
}

export async function corePage(db: Db, testerId: string, kind: "self" | "preferences"): Promise<MemoryPage | undefined> {
  const rows = await db
    .select()
    .from(memoryPages)
    .where(and(eq(memoryPages.testerId, testerId), eq(memoryPages.kind, kind)))
    .limit(1);
  return rows[0];
}

export async function goalPage(db: Db, testerId: string, goalSlug: string): Promise<MemoryPage | undefined> {
  const rows = await db
    .select()
    .from(memoryPages)
    .where(and(eq(memoryPages.testerId, testerId), eq(memoryPages.kind, "goal"), eq(memoryPages.goalSlug, goalSlug)))
    .limit(1);
  return rows[0];
}

export async function createPage(
  db: Db,
  testerId: string,
  values: { kind: MemoryPageKind; title: string; summary?: string; body?: string; goalSlug?: string; status?: "active" | "past"; date?: string },
  at: Date,
): Promise<MemoryPage> {
  const [page] = await db
    .insert(memoryPages)
    .values({ testerId, ...values, createdAt: at, updatedAt: at })
    .returning();
  if (!page) throw new Error("createPage returned no row");
  return page;
}

export async function updatePage(
  db: Db,
  page: MemoryPage,
  patch: Partial<Pick<MemoryPage, "title" | "summary" | "body" | "status">>,
  at: Date,
): Promise<MemoryPage> {
  const [updated] = await db
    .update(memoryPages)
    .set({ ...patch, updatedAt: at })
    .where(eq(memoryPages.id, page.id))
    .returning();
  if (!updated) throw new Error("updatePage found no row");
  return updated;
}

/** A page counts as updated whenever one of its facts changes, so the timeline shows it. */
async function touch(db: Db, pageId: string, at: Date): Promise<void> {
  await db.update(memoryPages).set({ updatedAt: at }).where(eq(memoryPages.id, pageId));
}

export async function addFact(
  db: Db,
  page: MemoryPage,
  values: { text: string; sourceMessageId: string | null; section?: string; label?: string; day?: string },
  at: Date,
): Promise<MemoryFact> {
  const [fact] = await db
    .insert(memoryFacts)
    .values({ pageId: page.id, testerId: page.testerId, ...values, createdAt: at, updatedAt: at })
    .returning();
  if (!fact) throw new Error("addFact returned no row");
  await touch(db, page.id, at);
  return fact;
}

export async function updateFact(
  db: Db,
  fact: MemoryFact,
  patch: { text: string; sourceMessageId?: string | null; day?: string },
  at: Date,
): Promise<MemoryFact> {
  const [updated] = await db
    .update(memoryFacts)
    .set({ ...patch, updatedAt: at })
    .where(eq(memoryFacts.id, fact.id))
    .returning();
  if (!updated) throw new Error("updateFact found no row");
  await touch(db, fact.pageId, at);
  return updated;
}

export async function removeFact(db: Db, fact: MemoryFact, at: Date): Promise<void> {
  await db.delete(memoryFacts).where(eq(memoryFacts.id, fact.id));
  await touch(db, fact.pageId, at);
}

export async function factsOf(db: Db, pageIds: string[]): Promise<MemoryFact[]> {
  if (pageIds.length === 0) return [];
  return db
    .select()
    .from(memoryFacts)
    .where(inArray(memoryFacts.pageId, pageIds))
    .orderBy(asc(memoryFacts.createdAt), asc(memoryFacts.id));
}

/** Adds a link once. "related" is stored one way and read both ways. */
export async function link(db: Db, testerId: string, from: string, to: string, kind: "related" | "leads_to"): Promise<void> {
  if (from === to) return;
  if (kind === "related") {
    const existing = await db
      .select({ id: memoryLinks.id })
      .from(memoryLinks)
      .where(and(eq(memoryLinks.kind, "related"), eq(memoryLinks.fromPageId, to), eq(memoryLinks.toPageId, from)))
      .limit(1);
    if (existing.length) return;
  }
  await db.insert(memoryLinks).values({ testerId, fromPageId: from, toPageId: to, kind }).onConflictDoNothing();
}

/** Pages linked "related" to this one, either way round. */
export async function relatedPages(db: Db, page: MemoryPage): Promise<MemoryPage[]> {
  const rows = await db
    .select({ from: memoryLinks.fromPageId, to: memoryLinks.toPageId })
    .from(memoryLinks)
    .where(and(eq(memoryLinks.kind, "related"), or(eq(memoryLinks.fromPageId, page.id), eq(memoryLinks.toPageId, page.id))));
  const ids = rows.map((r) => (r.from === page.id ? r.to : r.from));
  if (ids.length === 0) return [];
  return db.select().from(memoryPages).where(inArray(memoryPages.id, ids)).orderBy(asc(memoryPages.title));
}

/**
 * The whole "leads to" path through a page, start first: walked back to where it began and
 * forward to where it ends, so it reads the same from any point on it.
 */
export async function pathThrough(db: Db, page: MemoryPage): Promise<MemoryPage[]> {
  const links = await db
    .select({ from: memoryLinks.fromPageId, to: memoryLinks.toPageId })
    .from(memoryLinks)
    .where(and(eq(memoryLinks.testerId, page.testerId), eq(memoryLinks.kind, "leads_to")))
    .orderBy(asc(memoryLinks.createdAt), asc(memoryLinks.id));
  const next = new Map<string, string>();
  const prev = new Map<string, string>();
  for (const l of links) {
    next.set(l.from, l.to);
    prev.set(l.to, l.from);
  }
  // Walk back to the start (a goal they returned to can make a loop: stop at the first repeat).
  let start = page.id;
  const seenBack = new Set([start]);
  for (let p = prev.get(start); p && !seenBack.has(p); p = prev.get(p)) {
    seenBack.add(p);
    start = p;
  }
  const ids = [start];
  for (let n = next.get(start); n && !ids.includes(n); n = next.get(n)) ids.push(n);
  if (ids.length === 1) return [page];
  const rows = await db.select().from(memoryPages).where(inArray(memoryPages.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Their own page and the preferences page, created the first time memory runs. Style notes
 * saved before memory existed become stated preferences.
 */
export async function ensureCorePages(db: Db, tester: Tester, at: Date): Promise<{ self: MemoryPage; preferences: MemoryPage }> {
  let self = await corePage(db, tester.id, "self");
  if (!self) {
    self = await createPage(
      db,
      tester.id,
      { kind: "self", title: tester.name ? `${tester.name} (the tester)` : "The tester", summary: "Who they are: life, values, likes and how they text." },
      at,
    );
  } else if (tester.name && self.title === "The tester") {
    self = await updatePage(db, self, { title: `${tester.name} (the tester)` }, at);
  }
  let preferences = await corePage(db, tester.id, "preferences");
  if (!preferences) {
    preferences = await createPage(
      db,
      tester.id,
      { kind: "preferences", title: "How they like to be coached", summary: "Stated and learned preferences: nudging, tone, proof, timing." },
      at,
    );
    const notes = tester.styleNotes.split(";").map((n) => n.trim()).filter(Boolean);
    // A millisecond apart, so they keep the order they were said in.
    for (const [i, note] of notes.entries()) {
      await addFact(db, preferences, { text: note, sourceMessageId: null, section: "stated" }, new Date(at.getTime() + i));
    }
  }
  return { self, preferences };
}

/**
 * A page per goal they've had, in the order they had them, linked goal → next goal. Made from
 * the goal switches on record (never by Claude), so the path is always complete and in order.
 */
export async function ensureGoalPages(db: Db, tester: Tester, at: Date): Promise<MemoryPage[]> {
  const switches = await db
    .select({ detail: flags.detail })
    .from(flags)
    .where(and(eq(flags.testerId, tester.id), eq(flags.kind, GOAL_SWITCH_FLAG), gte(flags.createdAt, tester.contextStartedAt)))
    .orderBy(asc(flags.createdAt), asc(flags.id));
  const order: string[] = [];
  const push = (slug: string | undefined) => {
    if (slug && slug !== "null" && order.at(-1) !== slug) order.push(slug);
  };
  for (const s of switches) {
    const [from, to] = (s.detail ?? "").split(":")[0]!.split("→").map((x) => x.trim());
    push(from);
    push(to);
  }
  push(tester.goalSlug ?? undefined);
  if (order.length === 0) return [];

  const known = await db.select().from(goals).where(inArray(goals.slug, order));
  const pages: MemoryPage[] = [];
  for (const slug of new Set(order)) {
    const goal = known.find((g) => g.slug === slug);
    if (!goal) continue;
    const status = slug === tester.goalSlug ? "active" : "past";
    let page = await goalPage(db, tester.id, slug);
    if (!page) {
      page = await createPage(db, tester.id, { kind: "goal", title: `Goal: ${goal.title}`, summary: goal.description, goalSlug: slug, status }, at);
    } else if (page.status !== status) {
      page = await updatePage(db, page, { status }, at);
    }
    pages.push(page);
  }
  const bySlug = new Map(pages.map((p) => [p.goalSlug, p]));
  for (let i = 0; i + 1 < order.length; i++) {
    const from = bySlug.get(order[i]!);
    const to = bySlug.get(order[i + 1]!);
    if (from && to) await link(db, tester.id, from.id, to.id, "leads_to");
  }
  return pages;
}

/** Observations of a pattern on the preferences page: how many, and on how many different days. */
export async function observationCount(db: Db, testerId: string, label: string): Promise<{ count: number; days: number; latest?: MemoryFact }> {
  const rows = await db
    .select()
    .from(memoryFacts)
    .where(and(eq(memoryFacts.testerId, testerId), eq(memoryFacts.section, "observation"), eq(memoryFacts.label, label)))
    .orderBy(desc(memoryFacts.createdAt), desc(memoryFacts.id));
  return { count: rows.length, days: new Set(rows.map((r) => r.day)).size, latest: rows[0] };
}

export interface TimelineItem {
  ref: string;
  kind: MemoryPageKind | "photo" | "voice note" | "video" | "attachment";
  title: string;
  summary: string;
  at: Date;
}

/** Everything in memory, newest update first: pages, daily docs and media. */
export async function timeline(db: Db, tester: Tester, limit = 30): Promise<TimelineItem[]> {
  const pages = await db
    .select()
    .from(memoryPages)
    .where(eq(memoryPages.testerId, tester.id))
    .orderBy(desc(memoryPages.updatedAt), desc(memoryPages.id))
    .limit(limit);
  const media = await db
    .select()
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), isNotNull(messages.mediaUrl), gte(messages.createdAt, memoryStart(tester))))
    .orderBy(desc(sentTime), desc(messages.id))
    .limit(limit);
  const items: TimelineItem[] = [
    ...pages.map((p) => ({ ref: pageRef(p.id), kind: p.kind, title: p.title, summary: p.summary, at: p.updatedAt })),
    ...media.map((m) => ({ ref: messageRef(m.id), kind: mediaLabel(m), title: mediaLabel(m), summary: mediaText(m), at: messageTime(m) })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

export function mediaLabel(m: Message): TimelineItem["kind"] {
  const kind = mediaKind(m.mediaContentType ?? undefined, m.mediaUrl ?? "");
  return kind === "image" ? "photo" : kind === "audio" ? "voice note" : kind === "video" ? "video" : "attachment";
}

/** What a media text holds, in words: its description or transcript, plus any caption. */
export function mediaText(m: Message): string {
  const parts = [m.description ?? m.transcript ?? "", m.content ?? ""].map((s) => s.trim()).filter(Boolean);
  return parts.join(" · ") || "(not described yet)";
}

export interface SearchHit {
  ref: string;
  where: string;
  text: string;
  at: Date;
}

/**
 * Word search over everything memory holds: facts, pages, daily docs, texts, transcripts and
 * media descriptions. Postgres matches word forms ("running" finds "run"); quoted phrases and
 * OR work as in a search box. Forgotten texts and anything before "forget everything" are skipped.
 */
export async function searchMemory(db: Db, tester: Tester, query: string, limit = 8): Promise<SearchHit[]> {
  const q = sql`websearch_to_tsquery('english', ${query})`;
  const match = (doc: ReturnType<typeof sql>) => sql`to_tsvector('english', ${doc}) @@ ${q}`;
  const rank = (doc: ReturnType<typeof sql>) => sql<number>`ts_rank(to_tsvector('english', ${doc}), ${q})`;

  const factDoc = sql`${memoryFacts.text}`;
  const factRows = await db
    .select({ fact: memoryFacts, title: memoryPages.title, pageId: memoryPages.id, score: rank(factDoc) })
    .from(memoryFacts)
    .innerJoin(memoryPages, eq(memoryPages.id, memoryFacts.pageId))
    .where(and(eq(memoryFacts.testerId, tester.id), match(factDoc)))
    .orderBy(desc(rank(factDoc)))
    .limit(limit);

  const pageDoc = sql`${memoryPages.title} || ' ' || ${memoryPages.summary} || ' ' || ${memoryPages.body}`;
  const pageRows = await db
    .select({ page: memoryPages, score: rank(pageDoc) })
    .from(memoryPages)
    .where(and(eq(memoryPages.testerId, tester.id), match(pageDoc)))
    .orderBy(desc(rank(pageDoc)))
    .limit(limit);

  const forgotten = db.select({ id: memoryForgotten.messageId }).from(memoryForgotten).where(eq(memoryForgotten.testerId, tester.id));
  const msgDoc = sql`coalesce(${messages.content}, '') || ' ' || coalesce(${messages.transcript}, '') || ' ' || coalesce(${messages.description}, '')`;
  const msgRows = await db
    .select({ message: messages, score: rank(msgDoc) })
    .from(messages)
    .where(
      and(
        eq(messages.contactNumber, tester.phone),
        gte(messages.createdAt, memoryStart(tester)),
        notInArray(messages.id, forgotten),
        match(msgDoc),
      ),
    )
    .orderBy(desc(rank(msgDoc)))
    .limit(limit);

  const hits: (SearchHit & { score: number })[] = [
    ...factRows.map((r) => ({ ref: factRef(r.fact.id), where: `${pageRef(r.pageId)} ${r.title}`, text: r.fact.text, at: r.fact.updatedAt, score: r.score })),
    ...pageRows.map((r) => ({
      ref: pageRef(r.page.id),
      where: r.page.kind,
      text: [r.page.title, r.page.summary, r.page.body].filter(Boolean).join(" — ").slice(0, 400),
      at: r.page.updatedAt,
      score: r.score,
    })),
    ...msgRows.map((r) => ({
      ref: messageRef(r.message.id),
      where: r.message.direction === "inbound" ? (r.message.mediaUrl ? `their ${mediaLabel(r.message)}` : "their text") : "ZOH's text",
      text: r.message.mediaUrl ? mediaText(r.message) : (r.message.content ?? ""),
      at: messageTime(r.message),
      score: r.score,
    })),
  ];
  return hits
    .sort((a, b) => b.score - a.score || b.at.getTime() - a.at.getTime())
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit);
}

/** Their texts (both ways) on one local day, oldest first; never a text behind something they asked to forget. */
export async function textsOn(db: Db, tester: Tester, date: string): Promise<Message[]> {
  const start = zonedTime(date, "00:00", tester.timeZone);
  const end = zonedTime(addDays(date, 1), "00:00", tester.timeZone);
  const forgotten = db.select({ id: memoryForgotten.messageId }).from(memoryForgotten).where(eq(memoryForgotten.testerId, tester.id));
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.contactNumber, tester.phone),
        // Context start is a stored time (like the coach's history); the day is by sent time.
        gte(messages.createdAt, memoryStart(tester)),
        gte(sentTime, start),
        lt(sentTime, end),
        notInArray(messages.id, forgotten),
      ),
    )
    .orderBy(asc(sentTime), asc(messages.id));
}

/** Locked plan versions for a goal, oldest first: the step path. */
export async function stepPath(db: Db, testerId: string, goalSlug: string) {
  return db
    .select()
    .from(plans)
    .where(and(eq(plans.testerId, testerId), eq(plans.goalSlug, goalSlug), ne(plans.status, "draft")))
    .orderBy(asc(plans.version));
}

/** Goal switch reasons, keyed "from→to". */
export async function switchReasons(db: Db, tester: Tester): Promise<Map<string, { reason: string; at: Date }>> {
  const rows = await db
    .select()
    .from(flags)
    .where(and(eq(flags.testerId, tester.id), eq(flags.kind, GOAL_SWITCH_FLAG), gte(flags.createdAt, tester.contextStartedAt)))
    .orderBy(asc(flags.createdAt));
  const out = new Map<string, { reason: string; at: Date }>();
  for (const r of rows) {
    const detail = r.detail ?? "";
    const i = detail.indexOf(":");
    const pair = (i >= 0 ? detail.slice(0, i) : detail).replace(/\s/g, "");
    out.set(pair, { reason: i >= 0 ? detail.slice(i + 1).trim() : "", at: r.createdAt });
  }
  return out;
}
