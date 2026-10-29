import { describeDays } from "../../coach/state.js";
import type { Goal, MaintenanceCheckin, Plan } from "../../db/schema.js";
import type { GoalView, ProgressTab } from "../data.js";
import { esc, hitRateText, proofHtml, streakText, suggestionCard, when } from "./shared.js";

/** The Progress tab: goals and their streaks, plan versions, the step log and past next steps. */

function goalCard(v: GoalView, checkins: MaintenanceCheckin[]): string {
  const g = v.goal;
  const settings = `nudges ${g.nudges ? "on" : "off"}, proof ${g.proof ? "on" : "off"}${g.role === "maintenance" ? `, ${g.checkinsPerWeek} check-ins a week` : ""}`;
  const past = v.past.length
    ? `<div class="muted">Past streaks: ${v.past.map((r) => `${r.length} (${r.from} to ${r.to}${r.endedBy ? `, ended by ${r.endedBy}` : ""})`).map(esc).join("; ")}</div>`
    : "";
  const maintenance =
    g.role === "maintenance"
      ? `<div>${v.provenThrough ? `Proven through ${esc(v.provenThrough)}, self-reported since` : "Self-reported"} · last confirmed ${esc(v.lastConfirmed ?? "never")}</div>
<div class="muted">Check-ins: ${
          checkins
            .filter((c) => c.goalSlug === g.goalSlug)
            .slice(-8)
            .map((c) => `${c.date} ${c.answer ?? "no answer"}`)
            .map(esc)
            .join(", ") || "none yet"
        }</div>`
      : "";
  return `<div class="card"><div class="row"><strong>${esc(v.title)}</strong><span class="chip">${esc(g.role)}</span><span class="muted">since ${esc(when(g.roleSince))}</span></div>
<div>Streak ${esc(streakText(v.current))} · hit rate ${esc(hitRateText(v))}</div>${maintenance}${past}<div class="muted">${esc(settings)}</div></div>`;
}

function planCard(p: Plan, titles: Map<string, Goal>): string {
  const review = p.needsReview ? `<span class="chip warn">needs review</span>` : p.status === "locked" ? `<span class="chip">reviewed</span>` : "";
  const label = p.status === "draft" ? "Draft" : `v${p.version}`;
  return `<div class="card"><div class="row"><strong>${esc(label)}</strong><span class="chip">${esc(titles.get(p.goalSlug)?.title ?? p.goalSlug)}</span>${p.changeKind ? `<span class="chip">${esc(p.changeKind)}</span>` : ""}${review}<span class="muted">${esc(when(p.lockedAt ?? p.createdAt))}</span></div>
<div>${esc(p.step)}${p.place ? ` · ${esc(p.place)}` : ""} · ${esc(p.stepTime)}, ${esc(describeDays(p.days))}${p.minutes ? ` · ${p.minutes} min` : ""}</div>
<div class="muted">Proof: ${esc(p.proof)}${p.proofNote ? ` (${esc(p.proofNote)})` : ""}${p.setupStep ? ` · setup: ${esc(p.setupStep)}` : ""}${p.startDate ? ` · from ${esc(p.startDate)}` : ""}${p.endsOn ? ` · lighter, through ${esc(p.endsOn)}` : ""}</div>
<div class="muted">Why: ${esc(p.reason)}${p.commitment ? ` · They said: "${esc(p.commitment)}"` : ""}</div></div>`;
}

export function progressTabHtml(goals: GoalView[], tab: ProgressTab, testerId: string, titles: Map<string, Goal>): string {
  const goalsHtml = goals.map((v) => goalCard(v, tab.checkins)).join("") || `<p class="empty">No goals yet.</p>`;
  const switches = tab.switches.length
    ? `<h3>Goal switches</h3>${tab.switches.map((s) => `<div class="card">${esc(s.pair)} <span class="muted">${esc(when(s.at))}</span><div>${esc(s.reason)}</div></div>`).join("")}`
    : "";
  const stepRows = tab.stepDays
    .map(({ day, proofs }) => {
      const verdict = day.proofVerdict ? `<div class="muted">proof ${esc(day.proofVerdict)}${day.proofSeen ? `: ${esc(day.proofSeen)}` : ""}</div>` : "";
      return `<tr><td>${esc(day.date)}</td><td>${esc(day.status ?? "open")}${day.note ? `<div class="muted">${esc(day.note)}</div>` : ""}${verdict}</td><td>${proofs.map(proofHtml).join("")}</td></tr>`;
    })
    .join("");
  const decided = tab.suggestions.filter((s) => s.decision !== "waiting");
  return `<h2 id="goals">Goals</h2>${goalsHtml}${switches}
<h2 id="steps">Step log</h2>${stepRows ? `<div class="card"><table><tr><th>Day</th><th>How it went</th><th>Proof</th></tr>${stepRows}</table></div>` : `<p class="empty">No step days yet.</p>`}
<h2 id="plans">Plan versions</h2>${tab.plans.map((p) => planCard(p, titles)).join("") || `<p class="empty">No plan yet.</p>`}
<h2 id="suggestions">Past next steps</h2>${decided.map((s) => suggestionCard(s, testerId, titles)).join("") || `<p class="empty">None decided yet.</p>`}`;
}
