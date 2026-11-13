import { aheadBy } from "../../testers/clock.js";
import { maskNumber } from "../../pipeline/inbound.js";
import type { GoalView, TesterHeader } from "../data.js";
import { layout } from "./layout.js";
import { esc, hitRatePct, initials } from "./shared.js";

/**
 * A tester's page (#63), laid out as in #106: a tab rail (closed to icons until opened; along the
 * bottom on a phone), then one slim header line whose More holds the focus and settings, then the tab.
 */

export const TABS = ["console", "texts", "memory", "progress"] as const;
export type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { console: "Console", texts: "Texts", memory: "Memory", progress: "Progress" };

const ICON = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const TAB_ICONS: Record<Tab, string> = {
  console: ICON(`<path d="M4 5h16v11H9l-5 4z"/>`),
  texts: ICON(`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>`),
  memory: ICON(`<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>`),
  progress: ICON(`<path d="M4 19h16M7 16v-4M12 16V7M17 16v-6"/>`),
};

export function asTab(value: unknown): Tab {
  return (TABS as readonly unknown[]).includes(value) ? (value as Tab) : "console";
}

/** "Focus: … · Category: …" (#181): the two never stand in for each other. */
function goalLine(v: GoalView, label: string, extra = ""): string {
  return `<div>${label}: <strong>${esc(v.focus)}</strong> · <span class="muted">Category: ${esc(v.category)}${extra}</span></div>`;
}

function headerHtml(h: TesterHeader): string {
  const t = h.tester;
  const focus = h.goals.find((g) => g.goal.role === "focus");
  const maintenance = h.goals.filter((g) => g.goal.role === "maintenance");
  const paused = h.pause && `paused${h.pause.until ? ` until ${h.pause.until}` : ""}`;
  const status = [
    t.scenario && "synthetic",
    t.stoppedAt && "stopped",
    paused,
    t.autoTextsPausedAt && "automatic texts paused",
    t.clockOffsetMs && `⏩ test clock +${aheadBy(t.clockOffsetMs)}`,
  ].filter(Boolean);
  const stats = focus
    ? `<span class="minis"><span class="mini"><b>🔥 ${focus.current?.length ?? 0}</b> streak</span><span class="mini"><b>${esc(hitRatePct(focus))}</b> hit rate${focus.hitRate.closed ? ` (${focus.hitRate.done}/${focus.hitRate.closed})` : ""}</span></span>`
    : "";
  const more = [
    focus ? goalLine(focus, "Focus") : `<div class="muted">No focus goal yet</div>`,
    ...maintenance.map((m) => goalLine(m, "Also keeping up", ` · ${m.current?.length ?? 0} day streak (maintenance)`)),
    `<div class="muted">${esc(t.timeZone)} · quiet ${esc(t.quietHoursStart)} to ${esc(t.quietHoursEnd)} · ${esc(t.pushiness)}</div>`,
  ].join("");
  return `<details class="card hdr"><summary><span class="avatar">${esc(initials(t.name))}</span><h1>${esc(t.name ?? "Unnamed")}</h1>
<span class="chip">${esc(t.phase)}</span>${status.map((s) => `<span class="chip${s === "synthetic" ? "" : " warn"}">${esc(s)}</span>`).join("")}<span class="muted">${esc(maskNumber(t.phone))}</span>
${stats}<span class="more-label muted">More</span></summary><div class="hdr-more">${more}</div></details>`;
}

export function testerView(h: TesterHeader, tab: Tab, content: string, name: string, notice?: string): string {
  const t = h.tester;
  const waiting = h.alertsWaiting + h.suggestionsWaiting;
  const tabs = TABS.map(
    (k) =>
      `<a href="/console/testers/${esc(t.id)}?tab=${k}"${k === tab ? ` class="on" aria-current="page"` : ""} title="${TAB_LABELS[k]}">${TAB_ICONS[k]}<span class="tlabel">${TAB_LABELS[k]}</span>${k === "console" && waiting ? ` <span class="badge">${waiting}</span>` : ""}</a>`,
  ).join("");
  // Closed until the page script opens it (a founder's choice, kept per device), so it never flashes open.
  const rail = `<nav class="rail closed" aria-label="Tabs"><button type="button" class="rail-toggle" aria-label="Show tab names" aria-expanded="false" hidden>»</button>${tabs}</nav>`;
  const body = `<div class="tester-page" data-tester="${esc(t.id)}" data-tab="${tab}" data-tabs="${TABS.join(",")}">${rail}<div class="tester-main">${notice ? `<div class="card warn">${esc(notice)}</div>` : ""}
${headerHtml(h)}${content}</div></div>`;
  return layout(t.name ?? "Tester", body, { name, wide: true });
}
