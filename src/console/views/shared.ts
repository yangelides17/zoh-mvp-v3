import type { ConsoleMessage, Goal, Message, Suggestion } from "../../db/schema.js";
import { SUGGESTION_KINDS } from "../../db/schema.js";
import { mediaKind } from "../../media/storage.js";
import type { StreakRun } from "../../nudges/streak.js";
import type { GoalView } from "../data.js";
import { decided } from "../suggestions.js";

/** Pieces every console page uses. Every value is escaped. */

/** Times show in the founders' zone. */
export const FOUNDER_ZONE = "America/New_York";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function when(at: Date | null | undefined): string {
  if (!at) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: FOUNDER_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(at);
}

/** Just the time of day, under a bubble (the day is in the divider above). */
export function clock(at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: FOUNDER_ZONE, hour: "numeric", minute: "2-digit" }).format(at);
}

/** The founders' calendar day, for dividers: "2026-11-10". */
export function founderDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FOUNDER_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** A divider's label: Today, Yesterday, or "Mon, Nov 9". */
export function dayLabel(day: string, now: Date): string {
  const today = founderDay(now);
  if (day === today) return "Today";
  if (day === founderDay(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function ago(at: Date, now: Date): string {
  const s = Math.max(0, (now.getTime() - at.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Intl.DateTimeFormat("en-US", { timeZone: FOUNDER_ZONE, month: "short", day: "numeric" }).format(at);
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return (parts.length ? parts.slice(0, 2).map((p) => [...p][0]!.toUpperCase()).join("") : "?") || "?";
}

export function streakText(run: StreakRun | undefined): string {
  return run ? `${run.length} (since ${run.from})` : "0";
}

export function hitRateText(v: GoalView): string {
  const { done, closed } = v.hitRate;
  return closed ? `${Math.round((done / closed) * 100)}% (${done}/${closed})` : "no days yet";
}

export function hitRatePct(v: GoalView): string {
  const { done, closed } = v.hitRate;
  return closed ? `${Math.round((done / closed) * 100)}%` : "–";
}

export function proofHtml(m: Message): string {
  const kind = mediaKind(m.mediaContentType ?? undefined, m.mediaUrl ?? "");
  const src = `/console/media/${esc(m.id)}`;
  const available = m.mediaKey && !m.mediaDeletedAt;
  const media = !available
    ? `<span class="muted">(${kind === "audio" ? "audio deleted after 30 days" : "not in our bucket"})</span>`
    : kind === "image"
      ? `<a href="${src}"><img class="proof" src="${src}" alt="proof photo" loading="lazy"></a>`
      : kind === "audio"
        ? `<audio controls preload="none" src="${src}"></audio>`
        : `<a href="${src}">${esc(kind)} file</a>`;
  const words = [m.description, m.transcript && `"${m.transcript}"`, m.content].filter(Boolean).map(esc).join(" · ");
  return `<div>${media}${words ? `<div class="muted">${words}</div>` : ""}</div>`;
}

export function alertCard(a: ConsoleMessage, testerId: string, testerName?: string): string {
  const seen = a.seenAt
    ? `<span class="muted">seen by ${esc(a.seenBy)} ${esc(when(a.seenAt))}</span>`
    : `<form class="inline" method="post" action="/console/testers/${esc(testerId)}/alerts/${esc(a.id)}/seen"><button class="small">Seen</button></form>`;
  return `<div class="card"><div class="row spread"><div class="row"><span class="chip${a.seenAt ? "" : " warn"}">${esc((a.topic ?? "alert").replaceAll("_", " "))}</span>${testerName ? `<a href="/console/testers/${esc(testerId)}?tab=console">${esc(testerName)}</a>` : ""}<span class="muted">${esc(when(a.createdAt))}</span></div>${seen}</div>
<div style="margin-top:6px">${esc(a.body)}</div>${a.why ? `<div class="muted">Why: ${esc(a.why)}</div>` : ""}</div>`;
}

/** A next step, with Approve / Change / Reject while it waits. The same card sits in the chat and under Pending. */
export function suggestionCard(s: Suggestion, testerId: string, titles: Map<string, Goal>, opts: { id?: boolean } = {}): string {
  const goal = (slug: string | null) => (slug ? esc(titles.get(slug)?.title ?? slug) : "");
  const base = `/console/testers/${esc(testerId)}/suggestions/${esc(s.id)}/decide`;
  const final = decided(s);
  const history = [
    `Raised by ${esc(s.raisedByName ?? s.raisedBy)} ${esc(when(s.createdAt))}`,
    s.decision !== "waiting" && `${esc(s.decision)} by ${esc(s.decidedBy)} ${esc(when(s.decidedAt))}${s.decisionReason ? `: ${esc(s.decisionReason)}` : ""}`,
    s.decision === "changed" && `Now: ${esc(final.kind)}, "${esc(final.proposal)}"`,
    s.outcome && `${esc(s.outcome)} ${esc(when(s.outcomeAt ?? s.deliveredAt))}`,
  ].filter(Boolean);
  const kinds = SUGGESTION_KINDS.map((k) => `<option value="${k}"${k === s.kind ? " selected" : ""}>${k}</option>`).join("");
  const decide =
    s.decision === "waiting"
      ? `<form method="post" action="${base}"><input name="reason" placeholder="Why (optional)" style="width:100%;margin:8px 0 6px">
<div class="row"><button class="primary small" name="decision" value="approved">Approve</button><button class="small" name="decision" value="rejected">Reject</button></div></form>
<details style="margin-top:6px"><summary class="muted">Change it</summary><form method="post" action="${base}"><input type="hidden" name="decision" value="changed">
<p><label>Kind <select name="kind">${kinds}</select></label></p><p><textarea name="proposal" required>${esc(s.proposal)}</textarea></p>
<p><input name="reason" placeholder="Why" style="width:100%"></p><button class="primary small">Approve the change</button></form></details>`
      : "";
  return `<div class="event idea${s.decision === "waiting" ? " waiting" : ""}"${opts.id ? ` data-id="${esc(s.id)}"` : ""}><div class="head"><span class="chip">next step · ${esc(s.kind.replace("_", " "))}</span><span class="chip">${goal(s.goalSlug)}${s.newGoalSlug ? ` → ${goal(s.newGoalSlug)}` : ""}</span><span class="chip${s.decision === "waiting" ? " warn" : ""}">${esc(s.decision)}</span></div>
<div>${esc(s.proposal)}</div>${s.reasoning ? `<div class="muted">Reasoning: ${esc(s.reasoning)}</div>` : ""}<div class="muted">${history.join(" · ")}</div>${decide}</div>`;
}
