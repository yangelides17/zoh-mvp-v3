import type { Rollup, TesterMetrics } from "../metrics.js";
import { layout } from "./layout.js";
import { esc } from "./shared.js";

/** The Metrics page (spec: GitHub issue "Metrics"). */

const DASH = "–";
const one = (n: number | undefined, digits = 1) => (n === undefined ? DASH : String(Math.round(n * 10 ** digits) / 10 ** digits));
const pct = (n: number | undefined) => (n === undefined ? DASH : `${Math.round(n * 100)}%`);
const day = (at: Date | undefined, timeZone: string) =>
  at ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(at) : "";

function metricsRow(m: TesterMetrics): string {
  const t = m.tester;
  const r = m.retention;
  const e = m.engagement;
  const p = m.progression;
  const steps = [p.deepened && `deepened ${day(p.deepened, t.timeZone)}`, p.upgraded && `upgraded ${day(p.upgraded, t.timeZone)}`, p.addedGoal && `added a goal ${day(p.addedGoal, t.timeZone)}`].filter(Boolean);
  const hit = m.hitRate?.closed ? `${m.hitRate.done} / ${m.hitRate.closed} (${pct(m.hitRate.done / m.hitRate.closed)})` : DASH;
  const cells = [
    `<a href="/console/testers/${esc(t.id)}">${esc(t.name ?? "Unnamed")}</a>${t.isTestUser ? ` <span class="chip">test</span>` : ""}`,
    m.start ?? DASH,
    r ? (r.current ? `${r.current.days}` : `ended ${r.runs.at(-1)!.to}`) : DASH,
    r ? `${r.total}` : DASH,
    r ? `${r.comebacks}` : DASH,
    e ? `${e.activeDays} / ${e.ofDays}` : DASH,
    e?.activeDays ? one(e.touchPoints / e.activeDays) : DASH,
    e?.activeDays ? one(e.messages / e.activeDays) : DASH,
    m.focusTitle ? `${m.streak?.length ?? 0}` : DASH,
    hit,
    m.verified ? `${m.verified.thisWeek} · ${one(m.verified.perWeek)}` : DASH,
    steps.length ? steps.join(", ") : "no",
    `${m.backOff.pauses + m.backOff.flags}${m.backOff.pauses ? ` (${m.backOff.pauses} paused)` : ""}`,
    `${m.stops}`,
  ];
  return `<tr>${cells.map((c) => `<td>${c.startsWith("<a") ? c : esc(c)}</td>`).join("")}</tr>`;
}

/** The Metrics page (spec: GitHub issue "Metrics"): beta totals, then one row per tester. */
export function metricsView(data: { rows: TesterMetrics[]; rollup: Rollup }, name: string, includeTest: boolean): string {
  const u = data.rollup;
  const toggle = includeTest
    ? `<a href="/console/metrics">Hide test accounts</a>`
    : `<a href="/console/metrics?test=1">Show test accounts</a>`;
  const totals = u.testers
    ? `<div class="card"><div class="row"><strong>${u.testers} tester${u.testers === 1 ? "" : "s"}</strong><span class="muted">averages per tester; progressed, back-off and stops are totals</span></div>
<table><tbody>
<tr><td>Days retained</td><td>${esc(one(u.retainedDays))}</td></tr>
<tr><td>Active days</td><td>${esc(pct(u.activeShare))}</td></tr>
<tr><td>Touch points a day <span class="muted">(days they texted only)</span></td><td>${esc(one(u.touchPointsPerDay))}</td></tr>
<tr><td>Messages a day <span class="muted">(days they texted only)</span></td><td>${esc(one(u.messagesPerDay))}</td></tr>
<tr><td>Verified steps a week</td><td>${esc(one(u.verifiedPerWeek))}</td></tr>
<tr><td>Hit rate</td><td>${esc(pct(u.hitRate))}</td></tr>
<tr><td>Current streak</td><td>${esc(one(u.streak))}</td></tr>
<tr><td>Progressed</td><td>${u.progressed} of ${u.testers}</td></tr>
<tr><td>Back-off requests</td><td>${u.backOff}</td></tr>
<tr><td>Stops</td><td>${u.stops}</td></tr>
</tbody></table></div>`
    : `<p class="muted">No testers yet.</p>`;
  const head = [
    "Tester",
    "Start",
    "Current run",
    "Days retained",
    "Comebacks",
    "Active days",
    'Touch points a day <span class="muted">(days they texted only)</span>',
    'Messages a day <span class="muted">(days they texted only)</span>',
    "Streak",
    "Hit rate",
    'Verified steps <span class="muted">(this week · a week)</span>',
    "Progression",
    "Back-off",
    "Stops",
  ];
  const table = data.rows.length
    ? `<div style="overflow-x:auto"><table style="min-width:1100px"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${data.rows.map(metricsRow).join("")}</tbody></table></div>`
    : "";
  const notes = `<p class="muted">Days are each tester's local days. A run ends after 3 days without a text from them; paused days are left out of runs and active days. A touch point is a text 30+ minutes after their last one. Verified steps have clear or plausible proof. Streak and hit rate are the focus goal's, as on the tester page.${includeTest ? "" : " Test accounts are left out."}</p>`;
  return layout("Metrics", `<div class="row" style="justify-content:space-between"><h1>Metrics</h1>${toggle}</div>${totals}${table}${notes}`, { name });
}
