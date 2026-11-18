import { createHash } from "node:crypto";
import type { ConsoleMessage, Goal, Message, Tester } from "../../db/schema.js";
import { stillOpen } from "../../coach/next-steps.js";
import { messageTime } from "../../memory/store.js";
import type { ConsoleTab, SideSection, ThreadItem } from "../data.js";
import { draftRef } from "../drafts.js";
import { APP_AUTHOR, awaitingAnswer, LISTEN_DAYS } from "../requests.js";
import { alertCard, clock, dayLabel, esc, founderDay, proofHtml, suggestionCard, when } from "./shared.js";

/**
 * The console chat and the texts thread (#63), iMessage-style: newest at the bottom, a divider per
 * day, older chunks loaded on scroll-up and new items appended live. Every item carries its id so
 * the page can drop one it already shows.
 */

export interface ThreadContext {
  testerId: string;
  titles: Map<string, Goal>;
  now: Date;
}

const REQUEST_STATUS_LABELS: Record<string, string> = { pending: "pending", sending: "going out now", sent: "sent", done: "done", cancelled: "cancelled" };
const DRAFT_STATUS_LABELS: Record<string, string> = { draft: "draft: nothing happens until you confirm", confirmed: "done", cancelled: "cancelled", failed: "not done" };

/** Day dividers in front of the first item and wherever the day changes; the page drops repeats at chunk edges. */
function withDividers<T>(list: T[], at: (item: T) => Date, render: (item: T) => string, now: Date): string {
  let day = "";
  return list
    .map((item) => {
      const d = founderDay(at(item));
      const divider = d === day ? "" : `<div class="divider" data-day="${d}">${esc(dayLabel(d, now))}</div>`;
      day = d;
      return divider + render(item);
    })
    .join("");
}

function lineHtml(m: ConsoleMessage, ctx: ThreadContext): string {
  const id = `data-id="${esc(m.id)}"`;
  const time = esc(clock(m.createdAt));
  switch (m.kind) {
    case "founder":
      return `<div class="msg me" ${id}><div class="bubble">${esc(m.body)}</div><div class="meta">${esc(m.author)} · ${time}</div></div>`;
    case "coach":
      if (m.author === APP_AUTHOR) return `<div class="event app" ${id}>${esc(m.body)} · ${time}</div>`;
      return `<div class="msg them" ${id}><div class="bubble">${esc(m.body)}</div><div class="meta">ZOH · ${time}</div></div>`;
    case "note":
      return `<div class="event" ${id}><div class="head"><span class="chip">note for the coach</span><span class="muted">from ${esc(m.author)} · ${time}</span></div><div>${esc(m.body)}</div></div>`;
    case "request": {
      const status = m.requestStatus ?? "pending";
      const cancel =
        status === "pending"
          ? `<form class="inline" method="post" action="/console/testers/${esc(ctx.testerId)}/requests/${esc(m.id)}/cancel"><button class="small">Cancel</button></form>`
          : "";
      const how = m.exact ? "word for word" : m.delivery === "own_text" ? "its own text" : m.delivery === "morning" ? "with the morning text" : "for the coach to bring up";
      const chips = [m.question && (m.alertOnAnswer ? "question · alert on answer" : "question"), how, m.sendNow && "even in quiet hours", REQUEST_STATUS_LABELS[status]].filter(Boolean);
      // #169: what came of the question.
      const answer =
        m.answerStatus === "answered" ? `<div><b>Answer:</b> ${esc(m.answer ?? "")}</div>` : m.answerStatus === "dodged" ? `<div class="muted">They talked past it; ZOH won't ask again.</div>` : "";
      const timing = [m.dueAt && `${m.delivery === "own_text" ? "at" : "not before"} ${when(m.dueAt)}`, m.expiresAt && `dropped if not out by ${when(m.expiresAt)}`].filter(Boolean);
      return `<div class="event" ${id}><div class="head">${chips.map((c) => `<span class="chip${c === "pending" ? " warn" : ""}">${esc(c)}</span>`).join("")}<span class="muted">from ${esc(m.author)} · ${time}</span></div>
<div>${esc(m.body)}</div>${timing.length ? `<div class="muted">${timing.map(esc).join(" · ")}</div>` : ""}${m.doneAt && status !== "pending" ? `<div class="muted">${esc(status)} ${esc(when(m.doneAt))}</div>` : ""}${answer}${cancel}</div>`;
    }
    case "draft": {
      // #155: what the console chat would do, until a founder confirms it.
      const status = m.draftStatus ?? "draft";
      const base = `/console/testers/${esc(ctx.testerId)}/drafts/${esc(m.id)}`;
      // #169: a question's answer alert, switched before Do it.
      const input = (m.draftInput ?? {}) as { question?: boolean; alert_on_answer?: boolean };
      const alertOn = input.alert_on_answer !== false;
      const answerAlert =
        m.draftAction === "plan_request" && input.question
          ? `<form class="inline" method="post" action="${base}/answer-alert"><input type="hidden" name="on" value="${alertOn ? "false" : "true"}"><button class="small" title="Switch the alert for their answer">${alertOn ? "Alert me when they answer: on" : "Alert me when they answer: off"}</button></form>`
          : "";
      const actions =
        status === "draft"
          ? `<div class="row" style="margin-top:6px"><form class="inline" method="post" action="${base}/confirm"><button class="primary small">Do it</button></form><label class="small link" for="chat-text" title="Tell ZOH what to change">Change</label><form class="inline" method="post" action="${base}/cancel"><button class="small">Cancel</button></form>${answerAlert}</div>`
          : "";
      const result = m.draftResult && status !== "draft" ? `<div class="muted">${esc(m.draftResult)}</div>` : "";
      // #214: named by its own ref ("draft [ab12cd34]"), apart from the request or next step it makes once done.
      return `<div class="event draft" ${id}><div class="head"><span class="chip${status === "draft" ? " warn" : ""}">${esc(DRAFT_STATUS_LABELS[status] ?? status)}</span><span class="muted">draft [${esc(draftRef(m.id))}] · for ${esc(m.author)} · ${time}</span></div>
<div>${esc(m.body)}</div>${result}${actions}</div>`;
    }
    case "summary":
      return `<div class="event" ${id}><div class="head"><span class="chip">Weekly summary</span><span class="muted">${time}</span></div><pre>${esc(m.body)}</pre></div>`;
    case "alert":
      // Alerts have their own section; never in the chat.
      return "";
  }
}

/** Whether a chat card can still change (#105): the page asks for these again on every poll. */
function isLive(i: ThreadItem): boolean {
  if (i.type === "suggestion") return stillOpen(i.suggestion);
  if (i.line.kind === "draft") return i.line.draftStatus === "draft";
  if (i.line.kind !== "request") return false;
  if (i.line.requestStatus === "pending" || i.line.requestStatus === "sending") return true;
  // #169/#168: once it's out, its answer and delivery still come in (as long as ZOH listens for an answer).
  return !!i.line.doneAt && Date.now() - i.line.doneAt.getTime() < LISTEN_DAYS * 86_400_000;
}

/**
 * One chat item. Cards that can change carry a signature of how they look now, and the live ones
 * say so: the page swaps a card in place when its signature changes (#105).
 */
export function itemHtml(i: ThreadItem, ctx: ThreadContext): string {
  const html = i.type === "line" ? lineHtml(i.line, ctx) : suggestionCard(i.suggestion, ctx.testerId, ctx.titles, { id: true });
  if (i.type === "line" && i.line.kind !== "request" && i.line.kind !== "draft") return html;
  return html.replace("<div ", `<div data-sig="${cardSig(html)}"${isLive(i) ? " data-live" : ""} `);
}

export const cardSig = (html: string) => createHash("sha256").update(html).digest("hex").slice(0, 16);

export function threadItemsHtml(items: ThreadItem[], ctx: ThreadContext): string {
  return withDividers(items, (i) => i.at, (i) => itemHtml(i, ctx), ctx.now);
}

/** `target`: the text "See in chat" opened at (#218), marked so the page scrolls to it. */
export function textItemsHtml(texts: Message[], now: Date, target?: string): string {
  return withDividers(
    texts,
    messageTime,
    (m) => {
      const who = m.direction === "inbound" ? "them" : "me";
      const body = m.mediaUrl ? proofHtml(m) : esc(m.content ?? "");
      const status = m.status && who === "me" ? ` · ${esc(m.status.toLowerCase())}` : "";
      const lookups = who === "me" ? lookupLine(m.timings) : "";
      return `<div class="msg ${who}${m.id === target ? " target" : ""}" data-id="${esc(m.id)}"><div class="bubble">${body}</div><div class="meta">${esc(clock(messageTime(m)))}${status}${lookups ? ` · ${esc(lookups)}` : ""}</div></div>`;
    },
    now,
  );
}

/**
 * #162: rough cents per lookup, beyond the reply's own tokens: a search ($10 per 1,000), a page (up to 8k tokens read
 * by the coach, ~$2 per million), a video (Gemini at full resolution, about 10 minutes, if Google bills it: free in
 * preview). Rough on purpose: it's there to spot a reply that looked up far more than it needed.
 */
export const LOOKUP_CENTS = { web_searches: 1, web_pages: 1.6, video_watches: 5 } as const;

/** #162: "🔎 2 · 📖 1 · ~4¢" under a reply that looked things up; empty for one that didn't. */
export function lookupLine(timings: unknown): string {
  const t = (timings ?? {}) as Record<string, unknown>;
  const n = (k: keyof typeof LOOKUP_CENTS) => Number(t[k] ?? 0) || 0;
  const parts = ([["🔎", "web_searches"], ["📖", "web_pages"], ["👀", "video_watches"]] as const).filter(([, k]) => n(k)).map(([icon, k]) => `${icon} ${n(k)}`);
  if (!parts.length) return "";
  const cents = (Object.keys(LOOKUP_CENTS) as (keyof typeof LOOKUP_CENTS)[]).reduce((sum, k) => sum + n(k) * LOOKUP_CENTS[k], 0);
  return `${parts.join(" · ")} · ~${Math.max(1, Math.round(cents))}¢`;
}

/** A scrolling thread box. `before`: where "load older" starts (absent when this is everything); `after`: the live cursor. */
function scroller(kind: "thread" | "texts", html: string, opts: { before?: Date; after: Date; empty: string }): string {
  const before = opts.before ? ` data-before="${opts.before.getTime()}"` : "";
  const start = opts.before ? `<div class="start muted">Scroll up for older</div>` : html ? `<div class="start muted">The beginning</div>` : "";
  return `<div class="scroller" data-kind="${kind}"${before} data-after="${opts.after.getTime()}">${start}<div class="items">${html || `<p class="empty">${esc(opts.empty)}</p>`}</div></div>`;
}

/** The newest item's time, or the tester's start, for the live cursor. */
export function newest(times: Date[], fallback: Date): Date {
  return times.reduce((a, b) => (b > a ? b : a), fallback);
}

/** The coach is still answering: the founder's latest line has no answer after it yet (and is recent). */
export function coachThinking(recent: ConsoleMessage[], now: Date): boolean {
  const lastFounder = awaitingAnswer(recent);
  return Boolean(lastFounder && now.getTime() - lastFounder.createdAt.getTime() < THINKING_FOR_MS);
}

/** The line under the chat while ZOH answers; empty otherwise. */
export const thinkingLabel = (thinking: boolean) => (thinking ? "ZOH is thinking…" : "");

/** How long the page shows "thinking" for an unanswered line. */
const THINKING_FOR_MS = 2 * 60_000;

/** Under the chat: alerts (unseen first, older folded away), then Pending: what needs you and what waits on the tester (#105). */
export function sideHtml(side: SideSection, ctx: ThreadContext, sig: string): string {
  const { unseen, earlier } = side.alerts;
  const waitingIds = new Set(side.pending.map((s) => s.id));
  const card = (a: ConsoleMessage) => alertCard(a, ctx.testerId, { decisionWaiting: Boolean(a.suggestionId && waitingIds.has(a.suggestionId)) });
  const alerts = unseen.map(card).join("") || `<p class="muted">Nothing waiting.</p>`;
  const older = earlier.length ? `<details><summary class="muted">Earlier (${earlier.length})</summary>${earlier.map(card).join("")}</details>` : "";
  // #214: drafts waiting for a Do it sit here too, the same card as in the chat.
  const needs = side.drafts.length + side.pending.length;
  const pending = needs
    ? [...side.drafts.map((d) => lineHtml(d, ctx)), ...side.pending.map((s) => suggestionCard(s, ctx.testerId, ctx.titles))].join("")
    : `<p class="muted">Nothing needs you. To suggest a next step, tell ZOH in the chat.</p>`;
  const { requests, suggestions } = side.waiting;
  const waiting =
    [...suggestions.map((s) => suggestionCard(s, ctx.testerId, ctx.titles)), ...requests.map((r) => lineHtml(r, ctx))].join("") ||
    `<p class="muted">Nothing waiting on them.</p>`;
  const waitingCount = requests.length + suggestions.length;
  return `<div id="side" data-sig="${esc(sig)}"><h2 id="alerts">Alerts${unseen.length ? ` <span class="badge">${unseen.length}</span>` : ""}</h2>${alerts}${older}
<h2 id="pending">Pending</h2>
<h3 id="needs-you">Needs you${needs ? ` <span class="badge">${needs}</span>` : ""}</h3>${pending}
<h3 id="waiting-on-tester">Waiting on the tester${waitingCount ? ` <span class="chip">${waitingCount}</span>` : ""}</h3>${waiting}</div>`;
}

/** `side`: the signed Alerts and Pending section from `sideHtml`. */
export function consoleTabHtml(tab: ConsoleTab, tester: Tester, ctx: ThreadContext, side: string, chunk: number): string {
  const before = tab.items.length >= chunk ? tab.items[0]!.at : undefined;
  const after = newest(tab.items.map((i) => i.at), tester.createdAt);
  const thinking = coachThinking(tab.recent, ctx.now);
  const stopped = tester.stoppedAt ? `<p class="muted warn">They texted stop: you can still ask about them, but nothing is sent.</p>` : "";
  return `<section id="chat">${scroller("thread", threadItemsHtml(tab.items, ctx), { before, after, empty: "Nothing yet: ask ZOH about them below." })}
<div class="typing" id="thinking">${thinkingLabel(thinking)}</div>
<form method="post" action="/console/testers/${esc(tester.id)}/chat">${stopped}
<div class="composer"><textarea id="chat-text" name="text" maxlength="2000" rows="1" required placeholder="Ask ZOH, give context, or tell it what to do: it drafts, you confirm"></textarea><button class="primary">Send</button></div></form></section>
${side}`;
}

/**
 * #218: `target` opens at that text (`texts` then run from just before it to the newest, and older may remain);
 * `missing` says "See in chat" couldn't find its text, above the latest texts.
 */
export function textsTabHtml(texts: Message[], tester: Tester, now: Date, chunk: number, opts: { target?: string; missing?: boolean } = {}): string {
  const before = texts.length >= chunk || (opts.target && texts.length) ? texts[0]!.createdAt : undefined;
  const after = newest(texts.map((m) => m.createdAt), tester.createdAt);
  const missing = opts.missing ? `<p class="muted warn" style="margin:8px 4px">Couldn't find that text in the chat.</p>` : "";
  return `<section id="texts">${missing}${scroller("texts", textItemsHtml(texts, now, opts.target), { before, after, empty: "No texts yet." })}
<p class="muted" style="margin:8px 4px">Their texts on the left, ZOH's on the right. Times are Eastern.</p></section>`;
}
