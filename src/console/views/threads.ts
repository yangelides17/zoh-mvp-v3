import type { ConsoleMessage, Goal, Message, Tester } from "../../db/schema.js";
import { messageTime } from "../../memory/store.js";
import type { ConsoleTab, ThreadItem } from "../data.js";
import { APP_AUTHOR, awaitingAnswer } from "../requests.js";
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

const REQUEST_STATUS_LABELS: Record<string, string> = { pending: "pending", sent: "sent", done: "done", cancelled: "cancelled" };

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
      const how = m.exact ? "send exactly this" : m.delivery === "own_text" ? "its own text" : m.delivery === "morning" ? "with the morning text" : "for the coach to bring up";
      const chips = [how, m.sendNow && "send now", REQUEST_STATUS_LABELS[status]].filter(Boolean);
      const timing = [m.dueAt && `${m.delivery === "own_text" ? "at" : "not before"} ${when(m.dueAt)}`, m.expiresAt && `dropped if not out by ${when(m.expiresAt)}`].filter(Boolean);
      return `<div class="event" ${id}><div class="head">${chips.map((c) => `<span class="chip${c === "pending" ? " warn" : ""}">${esc(c)}</span>`).join("")}<span class="muted">from ${esc(m.author)} · ${time}</span></div>
<div>${esc(m.body)}</div>${timing.length ? `<div class="muted">${timing.map(esc).join(" · ")}</div>` : ""}${m.doneAt && status !== "pending" ? `<div class="muted">${esc(status)} ${esc(when(m.doneAt))}</div>` : ""}${cancel}</div>`;
    }
    case "summary":
      return `<div class="event" ${id}><div class="head"><span class="chip">Weekly summary</span><span class="muted">${time}</span></div><pre>${esc(m.body)}</pre></div>`;
    case "alert":
      // Alerts have their own section; never in the chat.
      return "";
  }
}

export function threadItemsHtml(items: ThreadItem[], ctx: ThreadContext): string {
  return withDividers(
    items,
    (i) => i.at,
    (i) => (i.type === "line" ? lineHtml(i.line, ctx) : suggestionCard(i.suggestion, ctx.testerId, ctx.titles, { id: true })),
    ctx.now,
  );
}

export function textItemsHtml(texts: Message[], now: Date): string {
  return withDividers(
    texts,
    messageTime,
    (m) => {
      const who = m.direction === "inbound" ? "them" : "me";
      const body = m.mediaUrl ? proofHtml(m) : esc(m.content ?? "");
      const status = m.status && who === "me" ? ` · ${esc(m.status.toLowerCase())}` : "";
      return `<div class="msg ${who}" data-id="${esc(m.id)}"><div class="bubble">${body}</div><div class="meta">${esc(clock(messageTime(m)))}${status}</div></div>`;
    },
    now,
  );
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

/** Under the chat: alerts (unseen first, older folded away) and next steps waiting for a decision. */
export function sideHtml(side: Pick<ConsoleTab, "alerts" | "pending">, ctx: ThreadContext, sig: string): string {
  const { unseen, earlier } = side.alerts;
  const alerts = unseen.map((a) => alertCard(a, ctx.testerId)).join("") || `<p class="muted">Nothing waiting.</p>`;
  const older = earlier.length ? `<details><summary class="muted">Earlier (${earlier.length})</summary>${earlier.map((a) => alertCard(a, ctx.testerId)).join("")}</details>` : "";
  const pending = side.pending.length
    ? side.pending.map((s) => suggestionCard(s, ctx.testerId, ctx.titles)).join("")
    : `<p class="muted">None waiting. To suggest one, tell ZOH in the chat.</p>`;
  return `<div id="side" data-sig="${esc(sig)}"><h2 id="alerts">Alerts${unseen.length ? ` <span class="badge">${unseen.length}</span>` : ""}</h2>${alerts}${older}
<h2 id="pending">Pending suggestions${side.pending.length ? ` <span class="badge">${side.pending.length}</span>` : ""}</h2>${pending}</div>`;
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
<div class="composer"><textarea id="chat-text" name="text" maxlength="2000" rows="1" required placeholder="Ask ZOH, give context, or ask it to bring something up"></textarea><button class="primary">Send</button></div>
<details class="options"><summary>Send options</summary><div class="row" style="margin-top:6px"><label><input type="checkbox" name="exact"> Send exactly this</label><label><input type="checkbox" name="sendNow"> Send now (skip quiet hours)</label></div>
<p class="muted">Exact texts go out word for word, as ZOH: never after a stop or past 3 unanswered; "send now" skips only quiet hours.</p></details></form></section>
${side}`;
}

export function textsTabHtml(texts: Message[], tester: Tester, now: Date, chunk: number): string {
  const before = texts.length >= chunk ? texts[0]!.createdAt : undefined;
  const after = newest(texts.map((m) => m.createdAt), tester.createdAt);
  return `<section id="texts">${scroller("texts", textItemsHtml(texts, now), { before, after, empty: "No texts yet." })}
<p class="muted" style="margin:8px 4px">Their texts on the left, ZOH's on the right. Times are Eastern.</p></section>`;
}
