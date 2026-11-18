import { and, eq, isNotNull } from "drizzle-orm";
import { localDate } from "../coach/state.js";
import type { Db } from "../db/client.js";
import { memoryPages, messages, stepDays, type MemoryFact, type MemoryPage, type Message, type Tester } from "../db/schema.js";
import { factsOf, getPages, messageTime, pathThrough, relatedPages } from "../memory/store.js";

/**
 * Memory for the founders (#63): cards to browse and a page to read, Sentience-style. Read only, and
 * separate from `renderPage` (memory as the coach reads it), which stays as it is.
 */

export interface MemoryCard {
  page: MemoryPage;
  /** The summary, or the first facts (a daily doc: its body). */
  preview: string;
  /** Lower-cased title, summary, facts and body, for the search box. */
  search: string;
}

/** Fact sections, in reading order, with the heading founders see. */
export const SECTION_HEADINGS: [section: string, heading: string][] = [
  ["", "Notes"],
  ["voice", "How they text"],
  ["stated", "They said"],
  ["learned", "Patterns"],
  ["observation", "Observations"],
  ["forget", "Asked to forget (never brought up)"],
];

/** #98: one photo, voice note, video or file they sent. */
export interface MediaItem {
  message: Message;
  at: Date;
  /** Their local day it came in. */
  day: string;
  /** That day has a step day, so it links to it. */
  stepDay: boolean;
  /** Lower-cased description, transcript and words, for the search box. */
  search: string;
}

export interface MemoryTabData {
  cards: MemoryCard[];
  /** Everything they sent with media, newest first (#98). */
  media: MediaItem[];
  /** Their zone and local today, for the timeline and the media times. */
  timeZone: string;
  today: string;
}

/** Every page as a card, most recently updated first. */
export async function memoryCards(db: Db, tester: Tester, now: Date): Promise<MemoryTabData> {
  const pages = await getPages(db, tester.id);
  const facts = await factsOf(db, pages.map((p) => p.id));
  const byPage = new Map<string, MemoryFact[]>();
  for (const f of facts) byPage.set(f.pageId, [...(byPage.get(f.pageId) ?? []), f]);
  const cards = pages.map((page) => {
    const mine = (byPage.get(page.id) ?? []).filter((f) => f.section !== "forget");
    const preview = page.summary || (page.kind === "daily" ? page.body : mine.map((f) => f.text).join(" · "));
    const search = [page.title, page.summary, page.body, ...mine.map((f) => f.text)].join(" ").toLowerCase();
    return { page, preview, search };
  });
  cards.sort((a, b) => b.page.updatedAt.getTime() - a.page.updatedAt.getTime());
  const sent = await db
    .select()
    .from(messages)
    .where(and(eq(messages.contactNumber, tester.phone), eq(messages.direction, "inbound"), isNotNull(messages.mediaUrl)));
  const stepDates = new Set((await db.select({ date: stepDays.date }).from(stepDays).where(eq(stepDays.testerId, tester.id))).map((d) => d.date));
  const media = sent
    .map((message) => {
      const at = messageTime(message);
      const day = localDate(at, tester.timeZone);
      const search = [message.description, message.transcript, message.content].filter(Boolean).join(" ").toLowerCase();
      return { message, at, day, stepDay: stepDates.has(day), search };
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  return { cards, media, timeZone: tester.timeZone, today: localDate(now, tester.timeZone) };
}

export interface MemoryPageView {
  page: MemoryPage;
  sections: { heading: string; facts: MemoryFact[] }[];
  related: MemoryPage[];
  /** The "leads to" path through this page, start first; just this page when it's on none. */
  path: MemoryPage[];
}

/** One page, only if it's this tester's. */
export async function memoryPageView(db: Db, testerId: string, pageId: string): Promise<MemoryPageView | undefined> {
  const [page] = await db
    .select()
    .from(memoryPages)
    .where(and(eq(memoryPages.id, pageId), eq(memoryPages.testerId, testerId)));
  if (!page) return undefined;
  const facts = await factsOf(db, [page.id]);
  const known = new Set(SECTION_HEADINGS.map(([s]) => s));
  const sections = [
    ...SECTION_HEADINGS.map(([section, heading]) => ({ heading, facts: facts.filter((f) => f.section === section) })),
    // Sections added later still show, under their own name.
    ...[...new Set(facts.map((f) => f.section).filter((s) => !known.has(s)))].map((s) => ({ heading: s, facts: facts.filter((f) => f.section === s) })),
  ].filter((s) => s.facts.length);
  return { page, sections, related: await relatedPages(db, page), path: await pathThrough(db, page) };
}
