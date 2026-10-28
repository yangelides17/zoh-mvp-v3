import type { Db } from "../db/client.js";
import type { MemoryFact, MemoryPage, Tester } from "../db/schema.js";
import { describePlan } from "../coach/tools.js";
import { localDate } from "../coach/state.js";
import { weekdayOf } from "../nudges/schedule.js";
import {
  factRef,
  factsOf,
  messageRef,
  pageRef,
  pathThrough,
  relatedPages,
  stepPath,
  switchReasons,
  type TimelineItem,
} from "./store.js";

/** Memory as Claude reads it: pages with their facts, links and paths, and the timeline index. */

export interface RenderOptions {
  /** Show each fact's ref and source text ref, for the overnight pass that edits them. */
  refs?: boolean;
}

const SECTION_TITLES: Record<string, string> = {
  stated: "Stated (they said so; always wins)",
  learned: "Learned (a pattern seen over several days)",
  observation: "Observations (evidence, not yet a pattern)",
  voice: "How they text",
  forget: "Asked to forget (never bring up, never file)",
};

function shortDate(d: string | Date, tester: Tester): string {
  const date = typeof d === "string" ? d : localDate(d, tester.timeZone);
  const [, m, day] = date.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1]} ${Number(day)}`;
}

function weekdayLabel(date: string): string {
  const d = weekdayOf(date);
  return d[0]!.toUpperCase() + d.slice(1);
}

function factLine(f: MemoryFact, tester: Tester, opts: RenderOptions): string {
  const when = f.day ? shortDate(f.day, tester) : "";
  const label = f.label ? `[${f.label}] ` : "";
  if (!opts.refs) return `- ${label}${f.text}${when ? ` (${when})` : ""}`;
  const source = f.sourceMessageId ? messageRef(f.sourceMessageId) : "no source";
  return `- ${factRef(f.id)} ${label}${f.text} (${[when, source].filter(Boolean).join(", ")})`;
}

/** One page, in full. */
export async function renderPage(db: Db, tester: Tester, page: MemoryPage, opts: RenderOptions = {}): Promise<string> {
  const day = page.kind === "daily" && page.date ? `${weekdayLabel(page.date)} ${shortDate(page.date, tester)} · ` : "";
  const lines = [`${pageRef(page.id)} · ${day}${page.title} [${page.kind}${page.status === "past" ? ", past" : ""}]`];
  if (page.summary) lines.push(page.summary);
  if (page.kind === "daily") {
    if (page.body) lines.push(page.body);
    return lines.join("\n");
  }

  const facts = await factsOf(db, [page.id]);
  const sections = new Map<string, MemoryFact[]>();
  for (const f of facts) sections.set(f.section, [...(sections.get(f.section) ?? []), f]);
  const order = ["", "voice", "stated", "learned", "observation", "forget", ...[...sections.keys()].filter((s) => !(s in SECTION_TITLES) && s !== "")];
  for (const section of new Set(order)) {
    const list = sections.get(section);
    if (!list?.length) continue;
    if (section) lines.push(`${SECTION_TITLES[section] ?? section}:`);
    lines.push(...list.map((f) => factLine(f, tester, opts)));
  }
  if (facts.length === 0) lines.push("(nothing saved yet)");

  if (page.kind === "goal") lines.push(...(await goalLines(db, tester, page)));
  const related = await relatedPages(db, page);
  if (related.length) lines.push(`Related: ${related.map((p) => `${pageRef(p.id)} ${p.title}`).join("; ")}`);
  return lines.join("\n");
}

/** Where this goal came from and leads to (with the reasons for each switch), and its step path. */
async function goalLines(db: Db, tester: Tester, page: MemoryPage): Promise<string[]> {
  const lines: string[] = [];
  const path = await pathThrough(db, page);
  if (path.length > 1) {
    const reasons = await switchReasons(db, tester);
    const steps = path.map((p, i) => {
      const prev = path[i - 1];
      const why = prev ? reasons.get(`${prev.goalSlug}→${p.goalSlug}`) : undefined;
      const here = p.id === page.id ? " (this page)" : "";
      return `${pageRef(p.id)} ${p.title}${here}${why ? ` [switched ${shortDate(why.at, tester)}: ${why.reason}]` : ""}`;
    });
    lines.push(`Goal path, first to latest: ${steps.join(" → ")}`);
  }
  if (page.goalSlug) {
    const versions = await stepPath(db, tester.id, page.goalSlug);
    if (versions.length) {
      const latest = versions.at(-1)!;
      const steps = versions.map(
        (v) =>
          `v${v.version}${v.lockedAt ? ` (${shortDate(v.lockedAt, tester)})` : ""}: ${v.step}${v.endsOn ? ` (lighter, through ${v.endsOn})` : ""}${v.id === latest.id ? " (current)" : ""}`,
      );
      lines.push(`Step path, first to latest: ${steps.join(" → ")}`);
      lines.push(`Current plan: ${describePlan(latest)}`);
    }
  }
  return lines;
}

/** The timeline as an index: one line per item, newest first. */
export function renderTimeline(items: TimelineItem[], tester: Tester): string {
  if (items.length === 0) return "(nothing in memory yet)";
  return items
    .map((i) => `${i.ref} [${i.kind}] ${i.kind === i.title ? "" : `${i.title} — `}${i.summary} · ${shortDate(i.at, tester)}`.replace(/ — $/, ""))
    .join("\n");
}
