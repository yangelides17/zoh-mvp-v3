import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { recentConversation } from "../db/messages.js";
import { memoryPages, messages, type Message, type Tester } from "../db/schema.js";
import { localDate } from "../coach/state.js";
import { addDays, zonedTime } from "../nudges/schedule.js";
import { renderPage, renderTimeline } from "./render.js";
import { corePage, goalPage, sentTime, stepPath, switchReasons, timeline } from "./store.js";
// describePlan imported lazily to avoid a circular import through coach/tools.ts → coach/state.ts
const loadDescribePlan = () => import("../coach/tools.js").then((m) => m.describePlan);
import {
  ensureV2RequiredPages,
  getV2Children,
  getV2Dailies,
  getV2Entries,
  getV2GoalPage,
  getV2Pages,
  v2EntryRef,
  v2PageRef,
} from "./v2-store.js";
import type { MemoryV2Entry, MemoryV2Page } from "../db/schema.js";

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
 * V2 testers: since memoryV2Through (as a date → timestamp), never fewer than MIN_HISTORY_TEXTS.
 */
export async function coachHistory(db: Db, tester: Tester, now: Date, cap: number): Promise<Message[]> {
  if (!usesMemory(tester)) return recentConversation(db, tester.phone, cap, tester.contextStartedAt);

  if (tester.memoryVersion === "v2" && tester.memoryV2Through) {
    // V2: texts since the day after memoryV2Through (the nightly pass has filed everything through that day)
    const since = zonedTime(addDays(tester.memoryV2Through, 1), "00:00", tester.timeZone);
    const recent = await db
      .select()
      .from(messages)
      .where(and(eq(messages.contactNumber, tester.phone), gte(messages.createdAt, tester.contextStartedAt), gte(sentTime, since)))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(cap);
    if (recent.length >= MIN_HISTORY_TEXTS) return recent.reverse();
    return recentConversation(db, tester.phone, MIN_HISTORY_TEXTS, tester.contextStartedAt);
  }

  // V1 (default): today's and yesterday's texts
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
  if (tester.memoryVersion === "v2") return v2MemoryBlock(db, tester);
  return v1MemoryBlock(db, tester);
}

/** V1 memory block: the original layout. */
async function v1MemoryBlock(db: Db, tester: Tester): Promise<string> {
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

/** Render one v2 entry as a compact line. */
function renderV2Entry(e: MemoryV2Entry): string {
  const when = e.when ? ` (${e.when})` : "";
  const asOf = e.asOf && !e.text.includes(e.asOf) ? ` (as of ${e.asOf})` : "";
  const status = e.status === "open" ? " [open]" : "";
  return `- ${v2EntryRef(e.id)} [${e.type}] ${e.text}${when}${asOf}${status}`;
}

/** V2 memory block: a tree map, Coaching in full, the focus goal page with tracker data, and recent daily summaries. */
async function v2MemoryBlock(db: Db, tester: Tester): Promise<string> {
  const { root, coaching } = await ensureV2RequiredPages(db, tester, new Date());
  const allPages = await getV2Pages(db, tester.id);
  const sections: string[] = ["MEMORY (a tree of what you know about them; updated overnight)"];

  // 1. Root page: About + current entries, then every tier-1 page as a map line
  const rootEntries = (await getV2Entries(db, root.id)).filter((e) => e.status === "current" || e.status === "open");
  const rootLines = [
    `${v2PageRef(root.id)} ${root.title ?? tester.name ?? "Root"} [root]`,
    ...(root.about ? [`About: ${root.about}`] : []),
    ...rootEntries.map(renderV2Entry),
  ];
  const tier1 = allPages.filter((p) => p.parentId === root.id);
  if (tier1.length) {
    rootLines.push("Map:");
    for (const p of tier1) {
      const names = p.otherNames?.length ? ` (also: ${p.otherNames.join(", ")})` : "";
      rootLines.push(`  ${v2PageRef(p.id)} [${p.kind}] ${p.title}${names}${p.about ? ` — ${p.about}` : ""}`);
      // Show tier-2 children as a brief sub-list (title + About) so the coach knows who's in People, etc.
      const children = allPages.filter((c) => c.parentId === p.id);
      for (const c of children) {
        const cNames = c.otherNames?.length ? ` (also: ${c.otherNames.join(", ")})` : "";
        rootLines.push(`    ${v2PageRef(c.id)} [${c.kind}] ${c.title}${cNames}${c.about ? ` — ${c.about}` : ""}`);
      }
    }
  }
  sections.push(rootLines.join("\n"));

  // 2. Coaching page: rendered in full (About + current entries)
  const coachingEntries = (await getV2Entries(db, coaching.id)).filter((e) => e.status === "current" || e.status === "open");
  const coachingLines = [
    `${v2PageRef(coaching.id)} Coaching [coaching]`,
    ...(coaching.about ? [`About: ${coaching.about}`] : []),
    ...coachingEntries.map(renderV2Entry),
  ];
  sections.push(coachingLines.join("\n"));

  // 3. Focus goal page (if the tester has one): its parent area's About, its own About + entries, and tracker data
  if (tester.goalSlug) {
    const goalPage = await getV2GoalPage(db, tester.id, tester.goalSlug);
    if (goalPage) {
      await renderGoalSection(db, tester, goalPage, allPages, sections);
    }
  }

  // 4. Last 7 daily summaries
  const dailies = await getV2Dailies(db, tester.id, DAILY_DOCS_SHOWN);
  if (dailies.length) {
    const dailyLines = [`RECENT DAYS (newest first)`];
    for (const d of dailies) dailyLines.push(`${d.date}: ${d.summary}`);
    sections.push(dailyLines.join("\n"));
  }

  return sections.join("\n\n");
}

/** Render the focus goal's section: parent area context, the goal page, and the live tracker. */
async function renderGoalSection(db: Db, tester: Tester, goalPage: MemoryV2Page, allPages: MemoryV2Page[], sections: string[]): Promise<void> {
  const parent = goalPage.parentId ? allPages.find((p) => p.id === goalPage.parentId) : undefined;
  const goalEntries = (await getV2Entries(db, goalPage.id)).filter((e) => e.status === "current" || e.status === "open");
  const lines = [
    `${v2PageRef(goalPage.id)} ${goalPage.title} [goal, focus]`,
    ...(parent?.about ? [`Area: ${parent.title} — ${parent.about}`] : []),
    ...(goalPage.about ? [`About: ${goalPage.about}`] : []),
    ...goalEntries.map(renderV2Entry),
  ];

  // Live tracker: step path and switch reasons (same data the v1 goal page renders)
  if (goalPage.goalSlug) {
    const versions = await stepPath(db, tester.id, goalPage.goalSlug);
    if (versions.length) {
      const latest = versions.at(-1)!;
      const steps = versions.map(
        (v) => `v${v.version}: ${v.step}${v.destination ? ` → ${v.destination}` : ""}${v.endsOn ? ` (lighter, through ${v.endsOn})` : ""}${v.id === latest.id ? " (current)" : ""}`,
      );
      lines.push(`Step path: ${steps.join(" → ")}`);
      const describePlan = await loadDescribePlan();
      lines.push(`Current plan: ${describePlan(latest)}`);
    }
    // Goal path (if they switched goals)
    const reasons = await switchReasons(db, tester);
    if (reasons.size > 0) {
      const entries = [...reasons.entries()].map(([pair, r]) => `${pair}: ${r.reason}`);
      lines.push(`Goal switches: ${entries.join("; ")}`);
    }
  }
  sections.push(lines.join("\n"));
}
