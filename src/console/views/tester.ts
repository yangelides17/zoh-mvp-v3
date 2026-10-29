import { aheadBy } from "../../testers/clock.js";
import { maskNumber } from "../../pipeline/inbound.js";
import type { TesterHeader } from "../data.js";
import { layout } from "./layout.js";
import { esc, hitRatePct, initials } from "./shared.js";

/** A tester's page (#63): a header card, then one tab at a time. */

export const TABS = ["console", "texts", "memory", "progress"] as const;
export type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { console: "Console", texts: "Texts", memory: "Memory", progress: "Progress" };

export function asTab(value: unknown): Tab {
  return (TABS as readonly unknown[]).includes(value) ? (value as Tab) : "console";
}

function headerHtml(h: TesterHeader): string {
  const t = h.tester;
  const focus = h.goals.find((g) => g.goal.role === "focus");
  const maintenance = h.goals.filter((g) => g.goal.role === "maintenance");
  const paused = h.pause && `paused${h.pause.until ? ` until ${h.pause.until}` : ""}`;
  const status = [
    t.stoppedAt && "stopped",
    paused,
    t.autoTextsPausedAt && "automatic texts paused",
    t.clockOffsetMs && `⏩ test clock +${aheadBy(t.clockOffsetMs)}`,
  ].filter(Boolean);
  const stats = focus
    ? `<div class="stats"><div class="stat"><b>🔥 ${focus.current?.length ?? 0}</b><span>day streak</span></div><div class="stat"><b>${esc(hitRatePct(focus))}</b><span>hit rate${focus.hitRate.closed ? ` (${focus.hitRate.done}/${focus.hitRate.closed})` : ""}</span></div>${maintenance
        .map((m) => `<div class="stat"><b>${m.current?.length ?? 0}</b><span>${esc(m.title)} (maintenance)</span></div>`)
        .join("")}</div>`
    : "";
  return `<div class="card"><div class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:14px"><div class="avatar big">${esc(initials(t.name))}</div><div style="flex:1;min-width:0">
<h1>${esc(t.name ?? "Unnamed")}</h1>
<div class="row" style="margin-top:6px"><span class="chip">${esc(t.phase)}</span>${status.map((s) => `<span class="chip warn">${esc(s)}</span>`).join("")}<span class="muted">${esc(maskNumber(t.phone))}</span></div>
<div style="margin-top:6px">${focus ? `Focus: <strong>${esc(focus.title)}</strong>` : `<span class="muted">No focus goal yet</span>`}</div>
<div class="muted">${esc(t.timeZone)} · quiet ${esc(t.quietHoursStart)} to ${esc(t.quietHoursEnd)} · ${esc(t.pushiness)}</div></div></div>${stats}</div>`;
}

export function testerView(h: TesterHeader, tab: Tab, content: string, name: string, notice?: string): string {
  const t = h.tester;
  const waiting = h.alertsWaiting + h.suggestionsWaiting;
  const tabs = TABS.map(
    (k) =>
      `<a href="/console/testers/${esc(t.id)}?tab=${k}"${k === tab ? ` class="on" aria-current="page"` : ""}>${TAB_LABELS[k]}${k === "console" && waiting ? ` <span class="badge">${waiting}</span>` : ""}</a>`,
  ).join("");
  const body = `<div data-tester="${esc(t.id)}" data-tab="${tab}" data-tabs="${TABS.join(",")}">${notice ? `<div class="card warn">${esc(notice)}</div>` : ""}
${headerHtml(h)}<nav class="tabs">${tabs}</nav>${content}</div>`;
  return layout(t.name ?? "Tester", body, { name });
}
