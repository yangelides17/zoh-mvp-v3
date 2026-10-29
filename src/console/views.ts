import type { ConsoleMessage, Goal, Message, Plan, Suggestion } from "../db/schema.js";
import { SUGGESTION_KINDS } from "../db/schema.js";
import { describeDays } from "../coach/state.js";
import { mediaKind } from "../media/storage.js";
import { messageTime } from "../memory/store.js";
import { maskNumber } from "../pipeline/inbound.js";
import type { StreakRun } from "../nudges/streak.js";
import type { GoalView, TesterPage, TesterRow } from "./data.js";
import type { Rollup, TesterMetrics } from "./metrics.js";
import { APP_AUTHOR, awaitingAnswer } from "./requests.js";
import { decided } from "./suggestions.js";

/** The founder console's pages: server-rendered HTML that reads on a phone. Every value is escaped. */

/** Times show in the founders' zone. */
const FOUNDER_ZONE = "America/New_York";

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

const STYLE = `
:root { --bg: #fafaf8; --fg: #1d1d1b; --muted: #6b6b66; --line: #e3e2dc; --card: #fff; --accent: #2f6f4f; --warn: #a3421b; --chip: #eef3ee; }
@media (prefers-color-scheme: dark) { :root { --bg: #161614; --fg: #ecebe6; --muted: #a09f98; --line: #34332f; --card: #1f1f1c; --accent: #7cc59d; --warn: #f0926a; --chip: #24302a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 16px; }
a { color: var(--accent); }
h1 { font-size: 22px; margin: 4px 0 12px; } h2 { font-size: 17px; margin: 24px 0 8px; } h3 { font-size: 15px; margin: 12px 0 4px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 8px 0; overflow-wrap: anywhere; }
.muted { color: var(--muted); font-size: 13px; } .warn { color: var(--warn); }
.chip { display: inline-block; background: var(--chip); border-radius: 999px; padding: 1px 8px; font-size: 12px; margin-right: 4px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
nav.top { display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); padding: 8px 16px; background: var(--card); }
nav.jump a { margin-right: 10px; font-size: 13px; white-space: nowrap; }
input, select, textarea, button { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; max-width: 100%; }
textarea { width: 100%; min-height: 60px; } button { cursor: pointer; } button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
form.inline { display: inline; } details summary { cursor: pointer; }
pre { white-space: pre-wrap; margin: 0; font: 13px/1.45 ui-monospace, Menlo, monospace; }
.text { margin: 6px 0; } .text.in { margin-right: 20%; } .text.out { margin-left: 20%; text-align: right; }
.bubble { display: inline-block; text-align: left; padding: 6px 10px; border-radius: 12px; background: var(--chip); max-width: 100%; }
.out .bubble { background: var(--accent); color: var(--bg); }
img.proof { max-width: 160px; max-height: 160px; border-radius: 8px; display: block; margin: 4px 0; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
`;

export function layout(title: string, body: string, opts: { name?: string } = {}): string {
  const top = opts.name
    ? `<nav class="top"><a href="/console"><strong>ZOH console</strong></a><span class="muted">${esc(opts.name)} · <form class="inline" method="post" action="/console/logout"><button>Log out</button></form></span></nav>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta name="apple-mobile-web-app-title" content="ZOH Console"><meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/console/manifest.webmanifest"><link rel="icon" href="/console/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/console/icon.png">
<style>${STYLE}</style></head>
<body>${top}<main>${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return layout(
    "ZOH console",
    `<h1>ZOH console</h1>
<form method="post" action="/console/login" class="card">
<label>Password<br><input type="password" name="password" autocomplete="current-password" autofocus required></label>
<p><button class="primary">Log in</button></p>${error ? `<p class="warn">${esc(error)}</p>` : ""}</form>`,
  );
}

export function namePage(names: string[]): string {
  const buttons = names.map((n) => `<button class="primary" name="name" value="${esc(n)}">${esc(n)}</button>`).join(" ");
  return layout("Who's this?", `<h1>Who's this?</h1><p class="muted">Picked once on this device; your decisions are saved with your name.</p><form method="post" action="/console/name" class="card row">${buttons}</form>`);
}

export function notConfiguredPage(): string {
  return layout("ZOH console", `<h1>ZOH console</h1><p>The console isn't set up yet: set CONSOLE_PASSWORD and CONSOLE_SESSION_SECRET.</p>`);
}

function streakText(run: StreakRun | undefined): string {
  return run ? `${run.length} (since ${run.from})` : "0";
}

function hitRateText(v: GoalView): string {
  const { done, closed } = v.hitRate;
  return closed ? `${Math.round((done / closed) * 100)}% (${done}/${closed})` : "no days yet";
}

function alertCard(a: ConsoleMessage, testerId: string, testerName?: string): string {
  const seen = a.seenAt
    ? `<span class="muted">seen by ${esc(a.seenBy)} ${esc(when(a.seenAt))}</span>`
    : `<form class="inline" method="post" action="/console/testers/${esc(testerId)}/alerts/${esc(a.id)}/seen"><button>Seen</button></form>`;
  return `<div class="card"><div class="row"><span class="chip">${esc(a.topic ?? "alert")}</span>${testerName ? `<a href="/console/testers/${esc(testerId)}">${esc(testerName)}</a>` : ""}<span class="muted">${esc(when(a.createdAt))}</span></div>
<div>${esc(a.body)}</div>${a.why ? `<div class="muted">Why: ${esc(a.why)}</div>` : ""}<div>${seen}</div></div>`;
}

export function listPage(rows: TesterRow[], alerts: ConsoleMessage[], name: string): string {
  const byId = new Map(rows.map((r) => [r.tester.id, r.tester]));
  const testersHtml = rows
    .map((r) => {
      const t = r.tester;
      const maint = r.maintenance.map((m) => `<span class="chip">${esc(m.title)} · ${m.current?.length ?? 0}</span>`).join("");
      const last = r.lastText
        ? `${r.lastText.direction === "inbound" ? "Them" : "ZOH"}, ${esc(when(messageTime(r.lastText)))}: ${esc((r.lastText.content ?? "(media)").slice(0, 80))}`
        : "no texts yet";
      return `<a href="/console/testers/${esc(t.id)}" style="text-decoration:none;color:inherit"><div class="card">
<div class="row"><strong>${esc(t.name ?? "Unnamed")}</strong><span class="muted">${esc(maskNumber(t.phone))}</span><span class="chip">${esc(t.phase)}</span>${t.stoppedAt ? `<span class="chip warn">stopped</span>` : ""}${r.alertsWaiting ? `<span class="chip warn">${r.alertsWaiting} alert${r.alertsWaiting === 1 ? "" : "s"}</span>` : ""}</div>
<div>${r.focus ? `Focus: ${esc(r.focus.title)} · streak ${esc(streakText(r.focus.current))} · hit rate ${esc(hitRateText(r.focus))}` : `<span class="muted">No focus goal yet</span>`}</div>
${maint ? `<div>Maintenance: ${maint}</div>` : ""}<div class="muted">${last}</div></div></a>`;
    })
    .join("");
  const alertsHtml = alerts.length
    ? alerts.map((a) => alertCard(a, a.testerId, byId.get(a.testerId)?.name ?? "Unnamed")).join("")
    : `<p class="muted">Nothing waiting.</p>`;
  return layout("ZOH console", `<div class="row" style="justify-content:space-between"><h1>Testers</h1><a href="/console/metrics">Metrics</a></div>${testersHtml || `<p class="muted">No testers yet.</p>`}<h2>Alerts waiting</h2>${alertsHtml}`, { name });
}

function goalCard(v: GoalView, page: TesterPage): string {
  const g = v.goal;
  const settings = `nudges ${g.nudges ? "on" : "off"}, proof ${g.proof ? "on" : "off"}${g.role === "maintenance" ? `, ${g.checkinsPerWeek} check-ins a week` : ""}`;
  const past = v.past.length
    ? `<div class="muted">Past streaks: ${v.past.map((r) => `${r.length} (${r.from} to ${r.to}${r.endedBy ? `, ended by ${r.endedBy}` : ""})`).map(esc).join("; ")}</div>`
    : "";
  const maintenance =
    g.role === "maintenance"
      ? `<div>${v.provenThrough ? `Proven through ${esc(v.provenThrough)}, self-reported since` : "Self-reported"} · last confirmed ${esc(v.lastConfirmed ?? "never")}</div>
<div class="muted">Check-ins: ${
          page.checkins
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

function planCard(p: Plan, page: TesterPage): string {
  const review = p.needsReview ? `<span class="chip warn">needs review</span>` : p.status === "locked" ? `<span class="chip">reviewed</span>` : "";
  const label = p.status === "draft" ? "Draft" : `v${p.version}`;
  return `<div class="card"><div class="row"><strong>${esc(label)}</strong><span class="chip">${esc(page.titles.get(p.goalSlug)?.title ?? p.goalSlug)}</span>${p.changeKind ? `<span class="chip">${esc(p.changeKind)}</span>` : ""}${review}<span class="muted">${esc(when(p.lockedAt ?? p.createdAt))}</span></div>
<div>${esc(p.step)}${p.place ? ` · ${esc(p.place)}` : ""} · ${esc(p.stepTime)}, ${esc(describeDays(p.days))}${p.minutes ? ` · ${p.minutes} min` : ""}</div>
<div class="muted">Proof: ${esc(p.proof)}${p.proofNote ? ` (${esc(p.proofNote)})` : ""}${p.setupStep ? ` · setup: ${esc(p.setupStep)}` : ""}${p.startDate ? ` · from ${esc(p.startDate)}` : ""}${p.endsOn ? ` · lighter, through ${esc(p.endsOn)}` : ""}</div>
<div class="muted">Why: ${esc(p.reason)}${p.commitment ? ` · They said: "${esc(p.commitment)}"` : ""}</div></div>`;
}

function proofHtml(m: Message): string {
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

function suggestionCard(s: Suggestion, page: TesterPage): string {
  const goal = (slug: string | null) => (slug ? esc(page.titles.get(slug)?.title ?? slug) : "");
  const base = `/console/testers/${esc(page.tester.id)}/suggestions/${esc(s.id)}/decide`;
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
      ? `<form method="post" action="${base}"><input name="reason" placeholder="Why (optional)" style="width:100%;margin:6px 0">
<div class="row"><button class="primary" name="decision" value="approved">Approve</button><button name="decision" value="rejected">Reject</button></div></form>
<details><summary>Change it</summary><form method="post" action="${base}"><input type="hidden" name="decision" value="changed">
<p><label>Kind <select name="kind">${kinds}</select></label></p><p><textarea name="proposal" required>${esc(s.proposal)}</textarea></p>
<p><input name="reason" placeholder="Why" style="width:100%"></p><button class="primary">Approve the change</button></form></details>`
      : "";
  return `<div class="card"><div class="row"><span class="chip">${esc(s.kind)}</span><span class="chip">${goal(s.goalSlug)}${s.newGoalSlug ? ` → ${goal(s.newGoalSlug)}` : ""}</span><span class="chip${s.decision === "waiting" ? " warn" : ""}">${esc(s.decision)}</span></div>
<div>${esc(s.proposal)}</div>${s.reasoning ? `<div class="muted">Reasoning: ${esc(s.reasoning)}</div>` : ""}<div class="muted">${history.join(" · ")}</div>${decide}</div>`;
}

function newSuggestionForm(page: TesterPage): string {
  const goalOptions = (selected?: string | null) =>
    [...page.titles.values()].map((g: Goal) => `<option value="${esc(g.slug)}"${g.slug === selected ? " selected" : ""}>${esc(g.title)}</option>`).join("");
  return `<details class="card"><summary>Suggest a next step yourself</summary>
<form method="post" action="/console/testers/${esc(page.tester.id)}/suggestions">
<p><label>Goal <select name="goal">${goalOptions(page.tester.goalSlug)}</select></label>
<label>Kind <select name="kind">${SUGGESTION_KINDS.map((k) => `<option value="${k}">${k}</option>`).join("")}</select></label></p>
<p><label>New goal (new focus only) <select name="newGoal"><option value="">—</option>${goalOptions()}</select></label></p>
<p><textarea name="proposal" placeholder="What to propose" required></textarea></p>
<p><input name="reasoning" placeholder="Why (optional)" style="width:100%"></p>
<p class="muted">Saved as approved by you; the coach brings it up as its own idea.</p>
<button class="primary">Save suggestion</button></form></details>`;
}

const REQUEST_STATUS_LABELS: Record<string, string> = { pending: "pending", sent: "sent", done: "done", cancelled: "cancelled" };

function threadItem(m: ConsoleMessage, page: TesterPage): string {
  const time = `<span class="muted">${esc(when(m.createdAt))}</span>`;
  switch (m.kind) {
    case "alert":
      return alertCard(m, page.tester.id);
    case "founder":
      return `<div class="text out"><div class="bubble">${esc(m.body)}</div><div class="muted">${esc(m.author)} · ${esc(when(m.createdAt))}</div></div>`;
    case "coach":
      if (m.author === APP_AUTHOR) return `<div class="muted" style="margin:6px 0">${esc(m.body)} · ${esc(when(m.createdAt))}</div>`;
      return `<div class="text in"><div class="bubble">${esc(m.body)}</div><div class="muted">ZOH · ${esc(when(m.createdAt))}</div></div>`;
    case "note":
      return `<div class="card"><div class="row"><span class="chip">note for the coach</span><span class="muted">from ${esc(m.author)}</span>${time}</div><div>${esc(m.body)}</div></div>`;
    case "request": {
      const status = m.requestStatus ?? "pending";
      const cancel =
        status === "pending"
          ? `<form class="inline" method="post" action="/console/testers/${esc(page.tester.id)}/requests/${esc(m.id)}/cancel"><button>Cancel</button></form>`
          : "";
      const how = m.exact ? "send exactly this" : m.delivery === "own_text" ? "its own text" : m.delivery === "morning" ? "with the morning text" : "for the coach to bring up";
      const chips = [how, m.sendNow && "send now", REQUEST_STATUS_LABELS[status]].filter(Boolean);
      const timing = [m.dueAt && `${m.delivery === "own_text" ? "at" : "not before"} ${when(m.dueAt)}`, m.expiresAt && `dropped if not out by ${when(m.expiresAt)}`].filter(Boolean);
      return `<div class="card"><div class="row">${chips.map((c) => `<span class="chip${c === "pending" ? " warn" : ""}">${esc(c)}</span>`).join("")}<span class="muted">from ${esc(m.author)}</span>${time}${timing.map((x) => `<span class="muted">${esc(x)}</span>`).join("")}</div>
<div>${esc(m.body)}</div>${m.doneAt && status !== "pending" ? `<div class="muted">${esc(status)} ${esc(when(m.doneAt))}</div>` : ""}${cancel}</div>`;
    }
    case "summary":
      return `<div class="card"><div class="row"><span class="chip">Weekly summary</span>${time}</div><pre>${esc(m.body)}</pre></div>`;
  }
}

/** The coach is still answering: the founder's latest line has no answer after it yet (and is recent). */
export function coachThinking(thread: ConsoleMessage[], now: Date): boolean {
  const lastFounder = awaitingAnswer(thread);
  return Boolean(lastFounder && now.getTime() - lastFounder.createdAt.getTime() < THINKING_FOR_MS);
}

/** How long the page keeps checking for the coach's answer. */
const THINKING_FOR_MS = 2 * 60_000;

function chatBox(page: TesterPage, thinking: boolean): string {
  const stopped = page.tester.stoppedAt ? `<p class="muted warn">They texted stop: you can still ask about them, but nothing is sent.</p>` : "";
  // While the coach answers, reload every few seconds, but never over something being typed.
  const poll = thinking
    ? `<p class="muted" id="thinking">ZOH is thinking…</p><script>setInterval(function(){var t=document.getElementById("chat-text");if(!t||!t.value)location.reload()},3000)</script>`
    : "";
  return `${poll}<form method="post" action="/console/testers/${esc(page.tester.id)}/chat" class="card" id="chat">${stopped}
<textarea id="chat-text" name="text" maxlength="2000" required placeholder="Ask about them, give context, or ask ZOH to bring something up"></textarea>
<div class="row" style="margin-top:6px"><label><input type="checkbox" name="exact"> Send exactly this</label><label><input type="checkbox" name="sendNow"> Send now (skip quiet hours)</label></div>
<p class="muted">Exact texts go out word for word, as ZOH: never after a stop or past 3 unanswered; "send now" skips only quiet hours.</p>
<button class="primary">Send</button></form>`;
}

export function testerView(page: TesterPage, name: string, now = new Date(), notice?: string): string {
  const t = page.tester;
  const goalsHtml = page.goals.map((v) => goalCard(v, page)).join("") || `<p class="muted">No goals yet.</p>`;
  const switches = page.switches.length
    ? `<h3>Goal switches</h3>${page.switches.map((s) => `<div class="card">${esc(s.pair)} <span class="muted">${esc(when(s.at))}</span><div>${esc(s.reason)}</div></div>`).join("")}`
    : "";
  const stepRows = page.stepDays
    .map(({ day, proofs }) => {
      const verdict = day.proofVerdict ? `<div class="muted">proof ${esc(day.proofVerdict)}${day.proofSeen ? `: ${esc(day.proofSeen)}` : ""}</div>` : "";
      return `<tr><td>${esc(day.date)}</td><td>${esc(day.status ?? "open")}${day.note ? `<div class="muted">${esc(day.note)}</div>` : ""}${verdict}</td><td>${proofs.map(proofHtml).join("")}</td></tr>`;
    })
    .join("");
  const texts = page.texts
    .map((m) => {
      const dir = m.direction === "inbound" ? "in" : "out";
      const body = m.mediaUrl ? proofHtml(m) : esc(m.content ?? "");
      return `<div class="text ${dir}"><div class="bubble">${body}</div><div class="muted">${esc(when(messageTime(m)))}${m.status && dir === "out" ? ` · ${esc(m.status.toLowerCase())}` : ""}</div></div>`;
    })
    .join("");
  const memory = page.memory
    .map(({ page: p, text }) => `<details class="card"><summary>${esc(p.title)} <span class="muted">${esc(p.kind)}</span></summary><pre>${esc(text)}</pre></details>`)
    .join("");
  const waiting = page.thread.filter((m) => m.kind === "alert" && !m.seenAt).length;
  const paused = page.pause && `paused${page.pause.until ? ` until ${page.pause.until}` : ""}`;
  const status = [t.stoppedAt && "stopped", paused, t.autoTextsPausedAt && "automatic texts paused"].filter(Boolean);
  const body = `${notice ? `<div class="card warn">${esc(notice)}</div>` : ""}
<h1>${esc(t.name ?? "Unnamed")}</h1>
<div class="row"><span class="muted">${esc(maskNumber(t.phone))}</span><span class="chip">${esc(t.phase)}</span>${status.map((s) => `<span class="chip warn">${esc(s)}</span>`).join("")}<span class="muted">${esc(t.timeZone)} · quiet ${esc(t.quietHoursStart)} to ${esc(t.quietHoursEnd)} · ${esc(t.pushiness)}</span></div>
<nav class="jump" style="margin:10px 0"><a href="#console">Console${waiting ? ` (${waiting})` : ""}</a><a href="#goals">Goals</a><a href="#suggestions">Suggestions</a><a href="#plans">Plans</a><a href="#steps">Step log</a><a href="#memory">Memory</a><a href="#texts">Texts</a></nav>
<h2 id="console">Console</h2>${page.thread.map((m) => threadItem(m, page)).join("") || `<p class="muted">Nothing yet: ask ZOH about them below.</p>`}${chatBox(page, coachThinking(page.thread, now))}
<h2 id="goals">Goals</h2>${goalsHtml}${switches}
<h2 id="suggestions">Suggestions</h2>${page.suggestions.map((s) => suggestionCard(s, page)).join("") || `<p class="muted">None yet.</p>`}${newSuggestionForm(page)}
<h2 id="plans">Plan versions</h2>${page.plans.map((p) => planCard(p, page)).join("") || `<p class="muted">No plan yet.</p>`}
<h2 id="steps">Step log</h2>${stepRows ? `<table><tr><th>Day</th><th>How it went</th><th>Proof</th></tr>${stepRows}</table>` : `<p class="muted">No step days yet.</p>`}
<h2 id="memory">Memory</h2>${memory || `<p class="muted">Nothing in memory yet.</p>`}
<h2 id="texts">Texts</h2>${texts || `<p class="muted">No texts yet.</p>`}`;
  return layout(t.name ?? "Tester", body, { name });
}

export const MANIFEST = JSON.stringify({
  name: "ZOH Console",
  short_name: "ZOH",
  start_url: "/console",
  scope: "/console",
  display: "standalone",
  background_color: "#fafaf8",
  theme_color: "#2f6f4f",
  icons: [
    { src: "/console/icon.png", sizes: "180x180", type: "image/png" },
    { src: "/console/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="#2f6f4f"/><text x="90" y="118" font-family="Helvetica, Arial, sans-serif" font-size="78" font-weight="700" fill="#fafaf8" text-anchor="middle">ZOH</text></svg>`;

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
    ? `<div class="card"><div class="row"><strong>${u.testers} tester${u.testers === 1 ? "" : "s"}</strong><span class="muted">averages per tester</span></div>
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
