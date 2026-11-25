import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  goals,
  memoryV2Daily,
  memoryV2Entries,
  memoryV2EntryPeople,
  memoryV2ForgetTopics,
  memoryV2Links,
  memoryV2Pages,
  messages,
  type MemoryV2Daily,
  type MemoryV2Entry,
  type MemoryV2EntryStatus,
  type MemoryV2EntryType,
  type MemoryV2Link,
  type MemoryV2Origin,
  type MemoryV2Page,
  type MemoryV2PageKind,
  type MemoryV2PageStatus,
  type Message,
  type Tester,
} from "../db/schema.js";
import { memoryStart, sentTime } from "./store.js";
import { addDays, zonedTime } from "../nudges/schedule.js";

/**
 * V2 memory data layer (#250). Every write path is here, with the store-layer checks the
 * spec requires. The database handles type/status pairs, tier range and parent presence;
 * this code handles parent–tier consistency, placement rules and protected pages.
 */

/** Characters of a uuid in a short ref. */
export const V2_REF_LENGTH = 8;
export const v2PageRef = (id: string) => `p:${id.slice(0, V2_REF_LENGTH)}`;
export const v2EntryRef = (id: string) => `e:${id.slice(0, V2_REF_LENGTH)}`;
export const v2MessageRef = (id: string) => `m:${id.slice(0, V2_REF_LENGTH)}`;

/** Required page kinds — one of each per tester, created by code. */
const REQUIRED_KINDS: MemoryV2PageKind[] = ["root", "coaching", "people", "places"];

/** Kinds that can't be deleted. */
const PROTECTED_KINDS: MemoryV2PageKind[] = ["root", "coaching", "people", "places"];

// ─── Refs ───────────────────────────────────────────────────────────────

function prefixOf(ref: string, kind: "p" | "e" | "m"): string | undefined {
  const raw = ref.trim().toLowerCase().replace(new RegExp(`^${kind}:`), "");
  return /^[0-9a-f-]{4,36}$/.test(raw) ? raw : undefined;
}

export async function findV2Page(db: Db, testerId: string, ref: string): Promise<MemoryV2Page | undefined> {
  const prefix = prefixOf(ref, "p");
  if (!prefix) return undefined;
  const rows = await db
    .select()
    .from(memoryV2Pages)
    .where(and(eq(memoryV2Pages.testerId, testerId), sql`${memoryV2Pages.id}::text like ${`${prefix}%`}`))
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

export async function findV2Entry(db: Db, testerId: string, ref: string): Promise<MemoryV2Entry | undefined> {
  const prefix = prefixOf(ref, "e");
  if (!prefix) return undefined;
  const rows = await db
    .select()
    .from(memoryV2Entries)
    .where(and(eq(memoryV2Entries.testerId, testerId), sql`${memoryV2Entries.id}::text like ${`${prefix}%`}`))
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

export async function findV2Message(db: Db, tester: Tester, ref: string): Promise<Message | undefined> {
  const prefix = prefixOf(ref, "m");
  if (!prefix) return undefined;
  const start = memoryStart(tester);
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), sql`${messages.createdAt} >= ${start}`, sql`${messages.id}::text like ${`${prefix}%`}`))
    .limit(2);
  return rows.length === 1 ? rows[0] : undefined;
}

// ─── Pages ──────────────────────────────────────────────────────────────

export async function getV2Page(db: Db, pageId: string): Promise<MemoryV2Page | undefined> {
  const [row] = await db.select().from(memoryV2Pages).where(eq(memoryV2Pages.id, pageId)).limit(1);
  return row;
}

export async function getV2Pages(db: Db, testerId: string): Promise<MemoryV2Page[]> {
  return db.select().from(memoryV2Pages).where(eq(memoryV2Pages.testerId, testerId)).orderBy(asc(memoryV2Pages.tier), asc(memoryV2Pages.title));
}

export async function getV2PagesByKind(db: Db, testerId: string, kind: MemoryV2PageKind): Promise<MemoryV2Page[]> {
  return db
    .select()
    .from(memoryV2Pages)
    .where(and(eq(memoryV2Pages.testerId, testerId), eq(memoryV2Pages.kind, kind)));
}

export async function getV2Children(db: Db, pageId: string): Promise<MemoryV2Page[]> {
  return db.select().from(memoryV2Pages).where(eq(memoryV2Pages.parentId, pageId)).orderBy(asc(memoryV2Pages.title));
}

/** Store-layer validation for page creation. Returns an error string or null. */
function validatePagePlacement(parent: MemoryV2Page | undefined, kind: MemoryV2PageKind, tier: number): string | null {
  if (kind === "root") return null; // root has no parent
  if (!parent) return "Non-root pages must have a parent.";
  // Parent's tier must be tier - 1
  if (parent.tier !== tier - 1) return `Parent tier ${parent.tier} doesn't match child tier ${tier} (must be tier - 1).`;
  // Person pages must sit under People
  if (kind === "person" && parent.kind !== "people") return "Person pages must sit under People.";
  // Place pages must sit under Places
  if (kind === "place" && parent.kind !== "places") return "Place pages must sit under Places.";
  // Goal pages must be tier 2 under an area
  if (kind === "goal" && parent.kind !== "area") return "Goal pages must sit under an area page.";
  return null;
}

export interface CreateV2PageInput {
  kind: MemoryV2PageKind;
  title: string;
  about?: string;
  otherNames?: string[];
  status?: MemoryV2PageStatus;
  goalSlug?: string;
  parentId?: string;
}

type StoreResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function createV2Page(
  db: Db,
  testerId: string,
  input: CreateV2PageInput,
  at: Date,
): Promise<StoreResult<MemoryV2Page>> {
  const tier = REQUIRED_KINDS.includes(input.kind) ? (input.kind === "root" ? 0 : 1) : input.kind === "area" || input.kind === "project" ? 1 : 2;
  let parent: MemoryV2Page | undefined;
  if (input.parentId) {
    parent = await getV2Page(db, input.parentId);
    if (!parent) return { ok: false, error: "Parent page not found." };
  }
  const err = validatePagePlacement(parent, input.kind, tier);
  if (err) return { ok: false, error: err };

  const [page] = await db
    .insert(memoryV2Pages)
    .values({
      testerId,
      parentId: input.parentId ?? null,
      tier,
      kind: input.kind,
      title: input.title,
      about: input.about ?? "",
      otherNames: input.otherNames ?? [],
      status: input.status ?? "active",
      goalSlug: input.goalSlug,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!page) throw new Error("createV2Page returned no row");
  return { ok: true, value: page };
}

export async function updateV2Page(
  db: Db,
  page: MemoryV2Page,
  patch: Partial<Pick<MemoryV2Page, "title" | "about" | "status" | "otherNames">>,
  at: Date,
): Promise<MemoryV2Page> {
  const [updated] = await db
    .update(memoryV2Pages)
    .set({ ...patch, updatedAt: at })
    .where(eq(memoryV2Pages.id, page.id))
    .returning();
  if (!updated) throw new Error("updateV2Page found no row");
  return updated;
}

export async function deleteV2Page(db: Db, page: MemoryV2Page): Promise<StoreResult<void>> {
  if (PROTECTED_KINDS.includes(page.kind)) {
    return { ok: false, error: `Cannot delete ${page.kind} page (protected). Delete its entries instead.` };
  }
  // Cascade deletes children, entries and links via FK
  await db.delete(memoryV2Pages).where(eq(memoryV2Pages.id, page.id));
  return { ok: true, value: undefined };
}

/** Create the four required pages (root, Coaching, People, Places) for a tester on v2. */
export async function ensureV2RequiredPages(
  db: Db,
  tester: Tester,
  at: Date,
): Promise<{ root: MemoryV2Page; coaching: MemoryV2Page; people: MemoryV2Page; places: MemoryV2Page }> {
  const existing = await db
    .select()
    .from(memoryV2Pages)
    .where(and(eq(memoryV2Pages.testerId, tester.id), inArray(memoryV2Pages.kind, REQUIRED_KINDS)));
  const byKind = new Map(existing.map((p) => [p.kind, p]));

  let root = byKind.get("root");
  if (!root) {
    const name = tester.name ?? "The tester";
    const result = await createV2Page(db, tester.id, { kind: "root", title: `${name}` }, at);
    if (!result.ok) throw new Error(result.error);
    root = result.value;
    root = await updateV2Page(db, root, { about: `${name} as a whole` }, at);
  }

  let coaching = byKind.get("coaching");
  if (!coaching) {
    const result = await createV2Page(db, tester.id, { kind: "coaching", title: "Coaching", about: "How they like to be coached", parentId: root.id }, at);
    if (!result.ok) throw new Error(result.error);
    coaching = result.value;
  }

  let people = byKind.get("people");
  if (!people) {
    const result = await createV2Page(db, tester.id, { kind: "people", title: "People", about: "Everyone in their life", parentId: root.id }, at);
    if (!result.ok) throw new Error(result.error);
    people = result.value;
  }

  let places = byKind.get("places");
  if (!places) {
    const result = await createV2Page(db, tester.id, { kind: "places", title: "Places", about: "Places that matter to them", parentId: root.id }, at);
    if (!result.ok) throw new Error(result.error);
    places = result.value;
  }

  return { root, coaching, people, places };
}

/** Get the goal page for a tester and goal slug. */
export async function getV2GoalPage(db: Db, testerId: string, goalSlug: string): Promise<MemoryV2Page | undefined> {
  const [row] = await db
    .select()
    .from(memoryV2Pages)
    .where(and(eq(memoryV2Pages.testerId, testerId), eq(memoryV2Pages.kind, "goal"), eq(memoryV2Pages.goalSlug, goalSlug)))
    .limit(1);
  return row;
}

/** Get all goal slugs that have a v2 goal page for this tester. */
export async function getV2GoalSlugs(db: Db, testerId: string): Promise<string[]> {
  const rows = await db
    .select({ goalSlug: memoryV2Pages.goalSlug })
    .from(memoryV2Pages)
    .where(and(eq(memoryV2Pages.testerId, testerId), eq(memoryV2Pages.kind, "goal")));
  return rows.flatMap((r) => (r.goalSlug ? [r.goalSlug] : []));
}

// ─── Entries ────────────────────────────────────────────────────────────

export interface CreateV2EntryInput {
  pageId: string;
  testerId: string;
  type: MemoryV2EntryType;
  text: string;
  detail?: string;
  when?: string;
  asOf?: string;
  origin?: MemoryV2Origin;
  sourceMessageId: string;
  replacesId?: string;
  learnedOn?: string;
  people?: string[]; // person page IDs
}

export async function addV2Entry(db: Db, input: CreateV2EntryInput, at: Date): Promise<MemoryV2Entry> {
  const status: MemoryV2EntryStatus = ["todo", "event", "followup"].includes(input.type) ? "open" : "current";
  const [entry] = await db
    .insert(memoryV2Entries)
    .values({
      pageId: input.pageId,
      testerId: input.testerId,
      type: input.type,
      status,
      text: input.text,
      detail: input.detail,
      when: input.when,
      asOf: input.asOf,
      origin: input.origin ?? "stated",
      sourceMessageId: input.sourceMessageId,
      replacesId: input.replacesId,
      learnedOn: input.learnedOn,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  if (!entry) throw new Error("addV2Entry returned no row");
  // Link people
  for (const personPageId of input.people ?? []) {
    await db.insert(memoryV2EntryPeople).values({ entryId: entry.id, pageId: personPageId }).onConflictDoNothing();
  }
  // Touch the page
  await db.update(memoryV2Pages).set({ updatedAt: at }).where(eq(memoryV2Pages.id, input.pageId));
  return entry;
}

/** Correct an entry in place (the entry was wrong, e.g. "Anna not Ana"). No history kept. */
export async function correctV2Entry(
  db: Db,
  entry: MemoryV2Entry,
  patch: { text?: string; detail?: string; when?: string; asOf?: string; people?: string[] },
  at: Date,
): Promise<MemoryV2Entry> {
  const updates: Record<string, unknown> = { updatedAt: at };
  if (patch.text !== undefined) updates.text = patch.text;
  if (patch.detail !== undefined) updates.detail = patch.detail;
  if (patch.when !== undefined) updates.when = patch.when;
  if (patch.asOf !== undefined) updates.asOf = patch.asOf;
  const [updated] = await db.update(memoryV2Entries).set(updates).where(eq(memoryV2Entries.id, entry.id)).returning();
  if (!updated) throw new Error("correctV2Entry found no row");
  if (patch.people) {
    await db.delete(memoryV2EntryPeople).where(eq(memoryV2EntryPeople.entryId, entry.id));
    for (const pid of patch.people) {
      await db.insert(memoryV2EntryPeople).values({ entryId: entry.id, pageId: pid }).onConflictDoNothing();
    }
  }
  await db.update(memoryV2Pages).set({ updatedAt: at }).where(eq(memoryV2Pages.id, entry.pageId));
  return updated;
}

/** Replace an entry (the world changed). New entry with replaces_id; old one expired. */
export async function replaceV2Entry(
  db: Db,
  oldEntry: MemoryV2Entry,
  newInput: Omit<CreateV2EntryInput, "replacesId">,
  at: Date,
): Promise<MemoryV2Entry> {
  // Dated types (todo/event/followup) can only be open|done|dropped — close as "dropped".
  // Non-dated types (fact/note/unsure) → "expired".
  const closeStatus = ["todo", "event", "followup"].includes(oldEntry.type) ? "dropped" : "expired";
  await db.update(memoryV2Entries).set({ status: closeStatus, updatedAt: at }).where(eq(memoryV2Entries.id, oldEntry.id));
  return addV2Entry(db, { ...newInput, replacesId: oldEntry.id }, at);
}

/** Close a dated entry (todo/event/followup): done or dropped. */
export async function closeV2Entry(
  db: Db,
  entry: MemoryV2Entry,
  status: "done" | "dropped",
  at: Date,
): Promise<StoreResult<MemoryV2Entry>> {
  if (!["todo", "event", "followup"].includes(entry.type)) {
    return { ok: false, error: `Only dated types (todo, event, followup) can be closed, not ${entry.type}.` };
  }
  if (entry.status !== "open") {
    return { ok: false, error: `Entry is already ${entry.status}, not open.` };
  }
  const [updated] = await db
    .update(memoryV2Entries)
    .set({ status, updatedAt: at })
    .where(eq(memoryV2Entries.id, entry.id))
    .returning();
  if (!updated) throw new Error("closeV2Entry found no row");
  await db.update(memoryV2Pages).set({ updatedAt: at }).where(eq(memoryV2Pages.id, entry.pageId));
  return { ok: true, value: updated };
}

export async function getV2Entries(db: Db, pageId: string): Promise<MemoryV2Entry[]> {
  return db.select().from(memoryV2Entries).where(eq(memoryV2Entries.pageId, pageId)).orderBy(asc(memoryV2Entries.createdAt));
}

export async function getV2EntriesByTester(db: Db, testerId: string): Promise<MemoryV2Entry[]> {
  return db.select().from(memoryV2Entries).where(eq(memoryV2Entries.testerId, testerId)).orderBy(asc(memoryV2Entries.createdAt));
}

/** All open dated entries (todo/event/followup) for a tester. */
export async function getV2OpenDated(db: Db, testerId: string): Promise<(MemoryV2Entry & { pagePath: string })[]> {
  const entries = await db
    .select()
    .from(memoryV2Entries)
    .where(
      and(
        eq(memoryV2Entries.testerId, testerId),
        inArray(memoryV2Entries.type, ["todo", "event", "followup"]),
        eq(memoryV2Entries.status, "open"),
      ),
    )
    .orderBy(asc(memoryV2Entries.when));
  // Resolve page paths for context
  const pageIds = [...new Set(entries.map((e) => e.pageId))];
  const pages = pageIds.length > 0 ? await db.select().from(memoryV2Pages).where(inArray(memoryV2Pages.id, pageIds)) : [];
  const pageMap = new Map(pages.map((p) => [p.id, p]));
  return entries.map((e) => ({ ...e, pagePath: pageMap.get(e.pageId)?.title ?? "unknown" }));
}

/** People (person pages) linked to an entry. */
export async function getV2EntryPeople(db: Db, entryId: string): Promise<MemoryV2Page[]> {
  const links = await db.select().from(memoryV2EntryPeople).where(eq(memoryV2EntryPeople.entryId, entryId));
  if (links.length === 0) return [];
  const pageIds = links.map((l) => l.pageId);
  return db.select().from(memoryV2Pages).where(inArray(memoryV2Pages.id, pageIds));
}

/** The full replaces chain of an entry (walking replaces_id backwards). */
export async function getV2ReplacesChain(db: Db, entryId: string): Promise<string[]> {
  const chain: string[] = [];
  let current = entryId;
  const seen = new Set<string>();
  for (;;) {
    const [entry] = await db.select({ id: memoryV2Entries.id, replacesId: memoryV2Entries.replacesId }).from(memoryV2Entries).where(eq(memoryV2Entries.id, current)).limit(1);
    if (!entry?.replacesId || seen.has(entry.replacesId)) break;
    seen.add(entry.replacesId);
    chain.push(entry.replacesId);
    current = entry.replacesId;
  }
  // Also find entries that replace this one (walk forward)
  const forward: string[] = [];
  current = entryId;
  const seenFwd = new Set<string>();
  for (;;) {
    const [child] = await db.select({ id: memoryV2Entries.id }).from(memoryV2Entries).where(eq(memoryV2Entries.replacesId, current)).limit(1);
    if (!child || seenFwd.has(child.id)) break;
    seenFwd.add(child.id);
    forward.push(child.id);
    current = child.id;
  }
  return [...chain, ...forward];
}

// ─── Links ──────────────────────────────────────────────────────────────

export async function addV2Link(db: Db, fromPageId: string, toPageId: string, kind: "related" | "leads_to"): Promise<void> {
  if (fromPageId === toPageId) return;
  await db.insert(memoryV2Links).values({ fromPageId, toPageId, kind }).onConflictDoNothing();
}

export async function getV2Links(db: Db, pageId: string): Promise<MemoryV2Link[]> {
  return db
    .select()
    .from(memoryV2Links)
    .where(sql`${memoryV2Links.fromPageId} = ${pageId} or ${memoryV2Links.toPageId} = ${pageId}`);
}

// ─── Daily summaries ────────────────────────────────────────────────────

export async function writeV2Daily(
  db: Db,
  testerId: string,
  date: string,
  summary: string,
  sourceMessageIds: string[],
  at: Date,
): Promise<MemoryV2Daily> {
  const [row] = await db
    .insert(memoryV2Daily)
    .values({ testerId, date, summary, sourceMessageIds, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [memoryV2Daily.testerId, memoryV2Daily.date],
      set: { summary, sourceMessageIds, updatedAt: at },
    })
    .returning();
  if (!row) throw new Error("writeV2Daily returned no row");
  return row;
}

export async function getV2Dailies(db: Db, testerId: string, limit = 7): Promise<MemoryV2Daily[]> {
  return db
    .select()
    .from(memoryV2Daily)
    .where(eq(memoryV2Daily.testerId, testerId))
    .orderBy(desc(memoryV2Daily.date))
    .limit(limit);
}

/** All daily summaries whose source_message_ids include any of the given message IDs. */
export async function getV2DailiesWithMessages(db: Db, testerId: string, messageIds: string[]): Promise<MemoryV2Daily[]> {
  if (messageIds.length === 0) return [];
  return db
    .select()
    .from(memoryV2Daily)
    .where(
      and(
        eq(memoryV2Daily.testerId, testerId),
        sql`${memoryV2Daily.sourceMessageIds} && ${sql.raw(`ARRAY[${messageIds.map((id) => `'${id}'`).join(",")}]::text[]`)}`,
      ),
    );
}

export async function updateV2DailySummary(db: Db, daily: MemoryV2Daily, summary: string, at: Date): Promise<void> {
  await db.update(memoryV2Daily).set({ summary, updatedAt: at }).where(eq(memoryV2Daily.id, daily.id));
}

// ─── Forget topics ──────────────────────────────────────────────────────

export async function addV2ForgetTopic(db: Db, testerId: string, topic: string, at: Date): Promise<void> {
  await db.insert(memoryV2ForgetTopics).values({ testerId, topic, at });
}

export async function getV2ForgetTopics(db: Db, testerId: string): Promise<string[]> {
  const rows = await db.select({ topic: memoryV2ForgetTopics.topic }).from(memoryV2ForgetTopics).where(eq(memoryV2ForgetTopics.testerId, testerId));
  return rows.map((r) => r.topic);
}

export async function clearV2ForgetTopics(db: Db, testerId: string): Promise<void> {
  await db.delete(memoryV2ForgetTopics).where(eq(memoryV2ForgetTopics.testerId, testerId));
}

// ─── Texts on a day ─────────────────────────────────────────────────────

/** All texts (both ways) on one local day, oldest first; forgotten messages excluded. */
export async function v2TextsOn(db: Db, tester: Tester, date: string): Promise<Message[]> {
  // Reuse the v1 implementation — same query, same tables
  const { textsOn } = await import("./store.js");
  return textsOn(db, tester, date);
}

/** All message IDs on a local day (both directions), for filling daily source_message_ids. */
export async function v2AllMessageIdsOn(db: Db, tester: Tester, date: string): Promise<string[]> {
  const start = zonedTime(date, "00:00", tester.timeZone);
  const end = zonedTime(addDays(date, 1), "00:00", tester.timeZone);
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), sql`${messages.createdAt} >= ${memoryStart(tester)}`, sql`${sentTime} >= ${start}`, sql`${sentTime} < ${end}`));
  return rows.map((r) => r.id);
}

/** Find the most recent inbound message for a tester, to use as source for notes without a specific text. */
export async function findV2MessageForSource(db: Db, tester: Tester): Promise<string | undefined> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), eq(messages.direction, "inbound")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.id;
}

// ─── Bulk delete for rebuild ────────────────────────────────────────────

/** Delete all v2 memory for a tester (for rebuild). Never touches v1 tables. */
export async function deleteV2Memory(db: Db, testerId: string): Promise<void> {
  await db.delete(memoryV2Links).where(
    sql`${memoryV2Links.fromPageId} in (select id from memory_v2_pages where tester_id = ${testerId})`,
  );
  await db.delete(memoryV2ForgetTopics).where(eq(memoryV2ForgetTopics.testerId, testerId));
  await db.delete(memoryV2Daily).where(eq(memoryV2Daily.testerId, testerId));
  // Entries and entry_people cascade from pages
  await db.delete(memoryV2Pages).where(eq(memoryV2Pages.testerId, testerId));
}

// ─── Goal lookup ────────────────────────────────────────────────────────

/** Get the goal title from the catalog for prompt fallback. */
export async function getGoalTitle(db: Db, goalSlug: string): Promise<string | undefined> {
  const [row] = await db.select({ title: goals.title }).from(goals).where(eq(goals.slug, goalSlug)).limit(1);
  return row?.title;
}
