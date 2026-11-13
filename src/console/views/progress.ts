import { describeDays } from "../../coach/state.js";
import { localDate } from "../../coach/state.js";
import type { Goal, MaintenanceCheckin, Pause, PauseEndReason, Plan, StepDay } from "../../db/schema.js";
import { evidenceText, type Learning } from "../../coach/week.js";
import type { GoalView, ProgressTab, StepDayView } from "../data.js";
import { dayAndTime, esc, hitRatePct, hitRateText, proofHtml, streakText, suggestionCard, when } from "./shared.js";

/**
 * The Progress tab (#63): each goal with big numbers, the step log as a strip of day dots that jump
 * to the day's detail, plan versions and past next steps.
 */

/** Dots shown in the strip: the most recent step days. */
export const DOTS_SHOWN = 28;

const STATUS_LABELS: Record<string, string> = { done: "done", done_reduced: "done (smaller)", missed: "missed", open: "open" };
/** A letter on each dot, so it reads without the color. */
const STATUS_MARKS: Record<string, string> = { done: "✓", done_reduced: "½", missed: "✕", open: "·" };

const status = (day: StepDay) => day.status ?? "open";
const dayAnchor = (date: string) => `day-${date}`;

function shortDay(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
}

/** #107: how a pause ended, in plain words. */
const PAUSE_ENDS: Record<PauseEndReason, string> = { tester: "they came back", end_date: "their return date", stop: "stopped", reset: "reset", restart: "restarted" };
const pauseAnchor = (p: Pause) => `pause-${p.id}`;

/** "Paused Wed, Oct 28 · said back Sun, Nov 1 · ended Sun, Nov 1, 9:00 AM (their return date) · “family trip”", in their zone. */
function pauseText(p: Pause, timeZone: string): string {
  return [
    `Paused ${shortDay(localDate(p.startedAt, timeZone))}`,
    p.until && `said back ${shortDay(p.until)}`,
    p.endedAt ? `ended ${dayAndTime(p.endedAt, timeZone)}${p.endedBy ? ` (${PAUSE_ENDS[p.endedBy]})` : ""}` : "ongoing",
    p.reason && `“${p.reason}”`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function goalCard(v: GoalView, checkins: MaintenanceCheckin[]): string {
  const g = v.goal;
  const settings = `nudges ${g.nudges ? "on" : "off"}, proof ${g.proof ? "on" : "off"}${g.role === "maintenance" ? `, ${g.checkinsPerWeek} check-ins a week` : ""}`;
  const best = Math.max(v.current?.length ?? 0, ...v.past.map((r) => r.length));
  const past = v.past.length
    ? `<details><summary class="muted">Past streaks (${v.past.length})</summary><div class="muted">${v.past.map((r) => `${r.length} (${r.from} to ${r.to}${r.endedBy ? `, ended by ${r.endedBy}` : ""})`).map(esc).join("; ")}</div></details>`
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
  return `<div class="card"><div class="row"><h3 style="margin:0">${esc(v.focus)}</h3><span class="chip">${esc(g.role)}</span><span class="muted">since ${esc(when(g.roleSince))}</span></div>
<div class="muted">Category: ${esc(v.category)}</div>
<div class="big-goal"><div class="stat"><b>🔥 ${v.current?.length ?? 0}</b><span>current streak</span></div><div class="stat"><b>${best}</b><span>best</span></div><div class="stat"><b>${esc(hitRatePct(v))}</b><span>hit rate${v.hitRate.closed ? ` (${v.hitRate.done}/${v.hitRate.closed})` : ""}</span></div></div>
<div class="muted">Streak ${esc(streakText(v.current))} · hit rate ${esc(hitRateText(v))}</div>${maintenance}${past}<div class="muted">${esc(settings)}</div></div>`;
}

function planCard(p: Plan, titles: Map<string, Goal>): string {
  const review = p.needsReview ? `<span class="chip warn">needs review</span>` : p.status === "locked" ? `<span class="chip">reviewed</span>` : "";
  const label = p.status === "draft" ? "Draft" : `v${p.version}`;
  return `<div class="card"><div class="row"><strong>${esc(label)}</strong><span class="chip">${esc(titles.get(p.goalSlug)?.title ?? p.goalSlug)}</span>${p.changeKind ? `<span class="chip">${esc(p.changeKind)}</span>` : ""}${review}<span class="muted">${esc(when(p.lockedAt ?? p.createdAt))}</span></div>
${p.destination ? `<div>Destination: ${esc(p.destination)}</div>` : ""}<div>${esc(p.step)}${p.place ? ` · ${esc(p.place)}` : ""} · ${esc(p.stepTime)}, ${esc(describeDays(p.days))}${p.minutes ? ` · ${p.minutes} min` : ""}</div>
<div class="muted">Proof: ${esc(p.proof)}${p.proofNote ? ` (${esc(p.proofNote)})` : ""}${p.setupStep ? ` · setup: ${esc(p.setupStep)}` : ""}${p.startDate ? ` · from ${esc(p.startDate)}` : ""}${p.endsOn ? ` · lighter, through ${esc(p.endsOn)}` : ""}</div>
<div class="muted">Why: ${esc(p.reason)}${p.commitment ? ` · They said: "${esc(p.commitment)}"` : ""}</div></div>`;
}

/**
 * Oldest to newest, left to right; each dot jumps to its day below. A pause (#107) is a ⏸ marker after
 * the days up to its start, not a dot of its own: the strip still counts step days only.
 */
function dotStrip(days: StepDayView[], tab: ProgressTab): string {
  const shown = days.slice(0, DOTS_SHOWN).reverse();
  const oldest = shown[0]?.day.date ?? "";
  const startOf = (p: Pause) => localDate(p.startedAt, tab.timeZone);
  const waiting = tab.pauses.filter((p) => !p.endedAt || localDate(p.endedAt, tab.timeZone) >= oldest);
  const marker = (p: Pause) => {
    const label = pauseText(p, tab.timeZone);
    return `<a class="dot pause" href="#${pauseAnchor(p)}" title="${esc(label)}" aria-label="${esc(label)}">⏸</a>`;
  };
  const before = (date?: string) => waiting.splice(0, waiting.filter((p) => date === undefined || startOf(p) < date).length).map(marker).join("");
  const dots = shown
    .map(({ day, proofs }) => {
      const s = status(day);
      const proof = proofs.length > 0 || Boolean(day.proofVerdict);
      const label = `${shortDay(day.date)}: ${STATUS_LABELS[s] ?? s}${proof ? ", with proof" : ""}`;
      return `${before(day.date)}<a class="dot ${esc(s)}${proof ? " proof" : ""}" href="#${dayAnchor(day.date)}" title="${esc(label)}" aria-label="${esc(label)}">${STATUS_MARKS[s] ?? "·"}</a>`;
    })
    .join("") + before();
  const legend = `<div class="legend"><span><span class="dot done"></span>done</span><span><span class="dot done_reduced"></span>smaller</span><span><span class="dot missed"></span>missed</span><span><span class="dot"></span>open</span><span><span class="dot done proof"></span>with proof</span>${tab.pauses.length ? `<span><span class="dot pause"></span>paused</span>` : ""}</div>`;
  return `<div class="card"><div class="row spread"><strong>Last ${shown.length} step day${shown.length === 1 ? "" : "s"}</strong><span class="muted">tap a day for detail</span></div><div class="dots">${dots}</div>${legend}</div>`;
}

/** Lessons (#78): understood (applied or recalled) with how they showed it, then the ones only explained so far. */
function learningsHtml(tab: ProgressTab): string {
  const { understood, explained } = tab.learnings;
  if (!understood.length && !explained.length) return `<p class="empty">No lessons yet.</p>`;
  const item = (l: Learning) => `<div class="card">${esc(l.text)}<div class="muted">${esc(evidenceText(l))}</div></div>`;
  return `<h3>Understood (applied or recalled)</h3>${understood.map(item).join("") || `<p class="empty">None yet.</p>`}
<h3>Explained only, starting to click</h3>${explained.map(item).join("") || `<p class="empty">None.</p>`}`;
}

/** The next later day in the log with a step: what ZOH proposed after this one (#93). */
function nextDayAfter(days: StepDayView[], date: string): StepDay | undefined {
  return days
    .map((v) => v.day)
    .filter((d) => d.date > date && d.step)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
}

/**
 * #93: the day's reflection in small labeled sections, below the proof. Days from before it was
 * recorded (how-it-went empty) say "not recorded", never a guess; recorded days with nothing say "None".
 */
export function stepLogSections(view: StepDayView, days: StepDayView[], testerId: string): string {
  const { day } = view;
  const empty = day.howItWentSaid === null ? "not recorded" : "None";
  const none = `<span class="muted">${empty}</span>`;
  const chat = `<a href="/console/testers/${esc(testerId)}?tab=texts&amp;day=${esc(day.date)}">see in chat</a>`;
  const line = (label: string, body: string) => `<div><span class="muted">${label}:</span> ${body}</div>`;
  const s = status(day);
  const offDay = s === "missed" || s === "done_reduced" || day.stepKind === "easier";
  const next = nextDayAfter(days, day.date);
  const nextHtml = next
    ? `${esc(next.step!)}${next.nextReason ? ` <span class="muted">· ${esc(next.nextReason)}</span>` : ""} <span class="chip">${next.agreedAt ? "agreed" : "proposed"}</span>`
    : none;
  return `<div class="day-log">${[
    line("Reflection", day.reflection ? `${esc(day.reflection)} · ${chat}` : none),
    line("Learned", view.learned?.length ? `${view.learned.map(esc).join("; ")} · ${chat}` : none),
    offDay ? line("What got in the way", day.inTheWay ? esc(day.inTheWay) : none) : "",
    line("ZOH's take", day.coachTake ? esc(day.coachTake) : none),
    line("Next step", nextHtml),
  ].join("")}</div>`;
}

export function progressTabHtml(goals: GoalView[], tab: ProgressTab, testerId: string, titles: Map<string, Goal>): string {
  const goalsHtml = goals.map((v) => goalCard(v, tab.checkins)).join("") || `<p class="empty">No goals yet.</p>`;
  const switches = tab.switches.length
    ? `<h3>Goal switches</h3>${tab.switches.map((s) => `<div class="card">${esc(s.pair)} <span class="muted">${esc(when(s.at))}</span><div>${esc(s.reason)}</div></div>`).join("")}`
    : "";
  const dayCards = tab.stepDays.map((view) => {
      const { day, proofs } = view;
      const s = status(day);
      // The day's own step (#76): length and proof only when they differ from the plan's.
      const extras = [day.stepMinutes != null && `${day.stepMinutes} min`, day.stepProof && `proof: ${day.stepProof}`].filter(Boolean).join(" · ");
      const step = day.step ? `<div class="day-step">Step: ${esc(day.step)}${extras ? ` <span class="muted">· ${esc(extras)}</span>` : ""}</div>` : "";
      const verdict = day.proofVerdict ? `<div class="muted">proof ${esc(day.proofVerdict)}${day.proofSeen ? `: ${esc(day.proofSeen)}` : ""}</div>` : "";
      const html = `<div class="card day-row" id="${dayAnchor(day.date)}"><div class="row"><span class="dot ${esc(s)}" aria-hidden="true">${STATUS_MARKS[s] ?? "·"}</span><strong>${esc(shortDay(day.date))}</strong><span class="muted">${esc(day.date)} · ${esc(STATUS_LABELS[s] ?? s)} · kind: ${esc(day.stepKind ?? "–")}</span></div>
${step}${day.note ? `<div>${esc(day.note)}</div>` : ""}${verdict}${proofs.length ? `<div class="row" style="margin-top:6px">${proofs.map(proofHtml).join("")}</div>` : ""}${stepLogSections(view, tab.stepDays, testerId)}</div>`;
    return { date: day.date, rank: 0, html };
  });
  // #107: each pause between the days around it, newest first; on a day that also has a step day, above it.
  const pauseCards = tab.pauses.map((p) => ({
    date: localDate(p.startedAt, tab.timeZone),
    rank: 1,
    html: `<div class="card pause-row" id="${pauseAnchor(p)}"><div class="row"><span class="dot pause" aria-hidden="true">⏸</span><span>${esc(pauseText(p, tab.timeZone))}</span></div></div>`,
  }));
  const dayRows = [...dayCards, ...pauseCards]
    .sort((a, b) => b.date.localeCompare(a.date) || b.rank - a.rank)
    .map((r) => r.html)
    .join("");
  const decided = tab.suggestions.filter((s) => s.decision !== "waiting");
  return `<h2 id="goals">Goals</h2>${goalsHtml}${switches}
<h2 id="learnings">Learnings</h2>${learningsHtml(tab)}
<h2 id="steps">Step log</h2>${tab.stepDays.length ? `${dotStrip(tab.stepDays, tab)}<details><summary class="muted">Every day (${tab.stepDays.length})</summary>${dayRows}</details>` : `<p class="empty">No step days yet.</p>`}
<h2 id="plans">Plan versions</h2>${tab.plans.map((p) => planCard(p, titles)).join("") || `<p class="empty">No plan yet.</p>`}
<h2 id="suggestions">Past next steps</h2>${decided.map((s) => suggestionCard(s, testerId, titles)).join("") || `<p class="empty">None decided yet.</p>`}`;
}
