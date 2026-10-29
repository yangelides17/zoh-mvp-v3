import type { ConsoleMessage } from "../../db/schema.js";
import { messageTime } from "../../memory/store.js";
import { maskNumber } from "../../pipeline/inbound.js";
import type { TesterRow } from "../data.js";
import { layout } from "./layout.js";
import { ago, alertCard, esc, hitRateText, initials, streakText } from "./shared.js";

/** The home page (#63): a card per tester, the ones needing a look first, then alerts across everyone. */
export function listPage(rows: TesterRow[], alerts: ConsoleMessage[], name: string, now = new Date()): string {
  const byId = new Map(rows.map((r) => [r.tester.id, r.tester]));
  const testersHtml = rows
    .map((r) => {
      const t = r.tester;
      const badge = r.alertsWaiting + r.suggestionsWaiting;
      const maint = r.maintenance.map((m) => `<span class="chip">${esc(m.title)} · ${m.current?.length ?? 0}</span>`).join(" ");
      const last = r.lastText
        ? `<span>${r.lastText.direction === "inbound" ? "" : "ZOH: "}${esc((r.lastText.content || "(photo or voice note)").slice(0, 120))}</span>`
        : `<span>No texts yet</span>`;
      const status = [t.stoppedAt && "stopped", t.autoTextsPausedAt && "auto texts paused"].filter(Boolean).map((s) => `<span class="chip warn">${esc(s)}</span>`).join("");
      return `<a class="tester" href="/console/testers/${esc(t.id)}"><div class="card"><div class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:12px">
<div class="avatar">${esc(initials(t.name))}</div>
<div style="flex:1;min-width:0">
<div class="row spread"><div class="row"><strong style="font-size:16px">${esc(t.name ?? "Unnamed")}</strong><span class="chip">${esc(t.phase)}</span>${status}</div><div class="row">${r.lastText ? `<span class="muted">${esc(ago(messageTime(r.lastText), now))}</span>` : ""}${badge ? `<span class="badge" title="${r.alertsWaiting} alert${r.alertsWaiting === 1 ? "" : "s"}, ${r.suggestionsWaiting} more next step${r.suggestionsWaiting === 1 ? "" : "s"} waiting">${badge}</span>` : ""}</div></div>
<div style="margin:2px 0">${r.focus ? `${esc(r.focus.title)} · 🔥 ${r.focus.current?.length ?? 0} · <span class="muted">streak ${esc(streakText(r.focus.current))} · hit rate ${esc(hitRateText(r.focus))}</span>` : `<span class="muted">No focus goal yet</span>`}</div>
${maint ? `<div class="row" style="margin:4px 0">${maint}</div>` : ""}<div class="preview">${last}</div>
<div class="muted">${esc(maskNumber(t.phone))}${r.alertsWaiting ? ` · ${r.alertsWaiting} alert${r.alertsWaiting === 1 ? "" : "s"}` : ""}</div></div></div></div></a>`;
    })
    .join("");
  const alertsHtml = alerts.length
    ? alerts.map((a) => alertCard(a, a.testerId, byId.get(a.testerId)?.name ?? "Unnamed")).join("")
    : `<p class="empty">Nothing waiting.</p>`;
  return layout(
    "ZOH console",
    `<h1>Testers</h1>${testersHtml || `<p class="empty">No testers yet.</p>`}<h2>Alerts waiting</h2>${alertsHtml}`,
    { name },
  );
}
