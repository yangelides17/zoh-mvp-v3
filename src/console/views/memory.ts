import type { MemoryPage, MemoryPageKind } from "../../db/schema.js";
import { addDays } from "../../nudges/schedule.js";
import type { MemoryCard, MemoryPageView, MemoryTabData } from "../memory-view.js";
import { esc, when } from "./shared.js";

/**
 * The Memory tab (#63), Sentience-style: a search box, filter chips, a grid of tinted cards and a
 * page per card whose links click through. Filtering and search run in the page; without the
 * script every card still shows.
 */

const KIND_LABELS: Record<MemoryPageKind, string> = {
  self: "About them",
  preferences: "Preferences",
  goal: "Goal",
  person: "Person",
  subject: "Subject",
  daily: "Daily",
};

/** Chips: a label and the kinds it shows. "About them" covers their own page and preferences. */
const CHIPS: [id: string, label: string, kinds: MemoryPageKind[]][] = [
  ["all", "All", []],
  ["about", "About them", ["self", "preferences"]],
  ["goal", "Goals", ["goal"]],
  ["person", "People", ["person"]],
  ["subject", "Subjects", ["subject"]],
  ["daily", "Daily", ["daily"]],
];

const group = (kind: MemoryPageKind) => CHIPS.find(([, , kinds]) => kinds.includes(kind))![0];

export const memoryHref = (testerId: string, pageId: string) => `/console/testers/${esc(testerId)}/memory/${esc(pageId)}`;

function shortDay(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
}

function card(c: MemoryCard, testerId: string): string {
  const p = c.page;
  const date = p.kind === "daily" && p.date ? shortDay(p.date) : `Updated ${when(p.updatedAt)}`;
  return `<a class="mem k-${p.kind}" href="${memoryHref(testerId, p.id)}" data-group="${group(p.kind)}" data-search="${esc(c.search)}">
<div class="row spread"><span class="muted">${esc(date)}</span><span class="chip">${esc(KIND_LABELS[p.kind])}${p.status === "past" ? " · past" : ""}</span></div>
<h3>${esc(p.title)}</h3><p class="fade">${esc(c.preview) || `<span class="muted">Nothing saved yet.</span>`}</p></a>`;
}

/** Daily pages grouped Today / Yesterday / This week / Earlier, by their local date. */
function timeline(cards: MemoryCard[], testerId: string, today: string): string {
  const daily = cards.filter((c) => c.page.kind === "daily" && c.page.date).sort((a, b) => b.page.date!.localeCompare(a.page.date!));
  const bucket = (date: string) => (date === today ? "Today" : date === addDays(today, -1) ? "Yesterday" : date > addDays(today, -7) ? "This week" : "Earlier");
  const groups = new Map<string, MemoryCard[]>();
  for (const c of daily) groups.set(bucket(c.page.date!), [...(groups.get(bucket(c.page.date!)) ?? []), c]);
  const html = [...groups.entries()].map(([label, list]) => `<h3>${esc(label)}</h3><div class="grid">${list.map((c) => card(c, testerId)).join("")}</div>`).join("");
  return html || `<p class="empty">No daily pages yet: the 3 am pass writes one for each day they text.</p>`;
}

export function memoryTabHtml(data: MemoryTabData, testerId: string): string {
  if (!data.cards.length) return `<p class="empty">Nothing in memory yet.</p>`;
  const counts = (kinds: MemoryPageKind[]) => data.cards.filter((c) => !kinds.length || kinds.includes(c.page.kind)).length;
  const chips = [
    ...CHIPS.map(([id, label, kinds], i) => `<button type="button" class="chip-btn${i === 0 ? " on" : ""}" data-chip="${id}">${esc(label)} <span class="muted">${counts(kinds)}</span></button>`),
    `<button type="button" class="chip-btn" data-chip="timeline">Timeline</button>`,
  ].join("");
  return `<section id="memory" class="memory">
<input type="search" class="mem-search" placeholder="Search their memory" aria-label="Search their memory">
<div class="row chips">${chips}</div>
<div class="grid mem-grid">${data.cards.map((c) => card(c, testerId)).join("")}</div>
<p class="empty mem-none" hidden>Nothing matches.</p>
<div class="mem-timeline" hidden>${timeline(data.cards, testerId, data.today)}</div></section>`;
}

function pageLink(p: MemoryPage, testerId: string): string {
  return `<a href="${memoryHref(testerId, p.id)}">${esc(p.title)}</a>`;
}

/** One memory page, cleanly laid out, its links clicking through. */
export function memoryPageHtml(v: MemoryPageView, testerId: string): string {
  const p = v.page;
  const sections = v.sections
    .map((s) => `<h3>${esc(s.heading)}</h3><ul class="facts">${s.facts.map((f) => `<li>${f.label ? `<span class="chip">${esc(f.label)}</span> ` : ""}${esc(f.text)}${f.day ? ` <span class="muted">${esc(shortDay(f.day))}</span>` : ""}</li>`).join("")}</ul>`)
    .join("");
  const body = p.kind === "daily" && p.body ? `<div class="daily-body">${esc(p.body)}</div>` : "";
  const path = v.path.length > 1 ? `<h3>Path</h3><div class="row">${v.path.map((q) => (q.id === p.id ? `<strong>${esc(q.title)}</strong>` : pageLink(q, testerId))).join(" → ")}</div>` : "";
  const related = v.related.length ? `<h3>Related</h3><div class="row">${v.related.map((q) => `<span class="chip">${pageLink(q, testerId)}</span>`).join("")}</div>` : "";
  const empty = !sections && !body ? `<p class="muted">Nothing saved on this page yet.</p>` : "";
  return `<p><a href="/console/testers/${esc(testerId)}?tab=memory">← All memory</a></p>
<article class="card mem-page k-${p.kind}"><div class="row spread"><span class="chip">${esc(KIND_LABELS[p.kind])}${p.status === "past" ? " · past" : ""}</span><span class="muted">${p.kind === "daily" && p.date ? esc(shortDay(p.date)) : `Updated ${esc(when(p.updatedAt))}`}</span></div>
<h1 style="margin-top:10px">${esc(p.title)}</h1>${p.summary ? `<p class="lede">${esc(p.summary)}</p>` : ""}${body}${sections}${empty}${path}${related}</article>`;
}
