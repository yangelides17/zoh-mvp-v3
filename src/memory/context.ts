import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { recentConversation } from "../db/messages.js";
import { memoryPages, messages, type Message, type Tester } from "../db/schema.js";
import { localDate } from "../coach/state.js";
import { addDays, zonedTime } from "../nudges/schedule.js";
import { renderPage, renderTimeline } from "./render.js";
import { corePage, goalPage, sentTime, timeline } from "./store.js";

/**
 * What the coach sees once a tester's plan is locked (spec: GitHub issue "Coach memory"): a
 * memory block in place of the long history, plus today's and yesterday's texts word for word.
 */

/** Daily docs shown on every reply, newest first. */
export const DAILY_DOCS_SHOWN = 7;
/** Lines in the timeline index on every reply. */
export const INDEX_ITEMS = 30;
/** Never fewer recent texts than this, word for word, however quiet the last two days were. */
export const MIN_HISTORY_TEXTS = 30;

/** Memory takes over from the long history only once the plan is locked; onboarding and planning see everything. */
export function usesMemory(tester: Pick<Tester, "phase">): boolean {
  return tester.phase === "active";
}

/**
 * The texts the coach reads word for word. Before the plan locks: the whole conversation since
 * their context started (up to `cap`). After: today's and yesterday's, and never fewer than the last 30.
 */
export async function coachHistory(db: Db, tester: Tester, now: Date, cap: number): Promise<Message[]> {
  if (!usesMemory(tester)) return recentConversation(db, tester.phone, cap, tester.contextStartedAt);
  const yesterday = zonedTime(addDays(localDate(now, tester.timeZone), -1), "00:00", tester.timeZone);
  const twoDays = await db
    .select()
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), gte(messages.createdAt, tester.contextStartedAt), gte(sentTime, yesterday)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(cap);
  if (twoDays.length >= MIN_HISTORY_TEXTS) return twoDays.reverse();
  return recentConversation(db, tester.phone, MIN_HISTORY_TEXTS, tester.contextStartedAt);
}

/**
 * The memory block: their page, preferences, the current goal page (with its paths), the last
 * daily docs and the timeline index. It only changes overnight or on a stated preference or a
 * forget, so it's cached between calls.
 */
export async function memoryBlock(db: Db, tester: Tester): Promise<string> {
  const pages = [await corePage(db, tester.id, "self"), await corePage(db, tester.id, "preferences")];
  if (tester.goalSlug) pages.push(await goalPage(db, tester.id, tester.goalSlug));
  const core = await Promise.all(pages.flatMap((p) => (p ? [renderPage(db, tester, p, { refs: true })] : [])));
  const daily = await db
    .select()
    .from(memoryPages)
    .where(and(eq(memoryPages.testerId, tester.id), eq(memoryPages.kind, "daily")))
    .orderBy(desc(memoryPages.date))
    .limit(DAILY_DOCS_SHOWN);
  const docs = await Promise.all(daily.map((d) => renderPage(db, tester, d)));
  const index = await timeline(db, tester, INDEX_ITEMS);
  return [
    "MEMORY (what you know about them beyond the recent texts; updated overnight)",
    core.length ? core.join("\n\n") : "(nothing filed yet: memory is written overnight)",
    `RECENT DAYS (newest first)\n${docs.length ? docs.join("\n\n") : "(none yet)"}`,
    `INDEX (newest first; open_pages for p: refs, search_memory for anything older)\n${renderTimeline(index, tester)}`,
  ].join("\n\n");
}
