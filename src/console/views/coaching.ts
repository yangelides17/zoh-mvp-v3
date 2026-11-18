import { GUIDANCE_MAX_CHARS, GUIDANCE_MAX_LINES } from "../../coaching/guidance.js";
import type { CoachingChange } from "../../db/schema.js";
import type { CoachingCard } from "../coaching-card.js";
import { esc, when } from "./shared.js";

/**
 * #158: the Coaching card, first on the Memory tab: the team's guidance, their own style requests, what ZOH
 * has learned, the notes it reads now, their saved plan settings and every change, with who made it.
 */

const AREA: Record<CoachingChange["area"], string> = { guidance: "Guidance", style: "Style request", learned: "Learned" };

function change(c: CoachingChange): string {
  const what =
    c.action === "clear"
      ? `Cleared (${esc(c.to ?? "")})`
      : c.action === "add"
        ? `${AREA[c.area]} added: "${esc(c.to)}"`
        : c.action === "remove"
          ? `${AREA[c.area]} removed: "${esc(c.from)}"`
          : `${AREA[c.area]} edited: "${esc(c.from)}" → "${esc(c.to)}"`;
  return `<li>${what} <span class="muted">· ${esc(c.by)} · ${esc(when(c.at))}</span></li>`;
}

export function coachingCardHtml(card: CoachingCard, testerId: string): string {
  const base = `/console/testers/${esc(testerId)}/coaching`;
  const room = card.guidance.length < GUIDANCE_MAX_LINES;
  const guidance = card.guidance
    .map(
      (g) => `<li${g.overriddenBy ? ` class="warn"` : ""}><form method="post" action="${base}/guidance/${esc(g.id)}" class="row">
<input name="text" value="${esc(g.text)}" maxlength="${GUIDANCE_MAX_CHARS}" required style="flex:1"><button class="small">Save</button></form>
<form class="inline" method="post" action="${base}/guidance/${esc(g.id)}/remove"><button class="small">Remove</button></form>
<span class="muted">${esc(g.author)} · ${esc(when(g.updatedAt))}</span>${
        g.overriddenBy ? `<div class="chip warn">Clashes with their request "${esc(g.overriddenBy)}": ZOH follows them. Edit or remove this line.</div>` : ""
      }</li>`,
    )
    .join("");
  const add = room
    ? `<form method="post" action="${base}/guidance" class="row"><input name="text" placeholder="How to coach them, e.g. more curious with her" maxlength="${GUIDANCE_MAX_CHARS}" required style="flex:1"><button class="primary small">Add</button></form>`
    : `<p class="muted">${GUIDANCE_MAX_LINES} lines is the most: edit or remove one to add another.</p>`;
  const style = card.style.length
    ? `<ul>${card.style
        .map(
          ({ fact, texted }) =>
            `<li>${esc(fact.text)} <span class="muted">· ${texted ? "texted" : "from what they said"}</span> <form class="inline" method="post" action="${base}/facts/${esc(fact.id)}/remove"><button class="small">Remove</button></form></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">None yet.</p>`;
  const learned = card.learned.length
    ? `<ul>${card.learned
        .map((f) => `<li>${esc(f.text)} <form class="inline" method="post" action="${base}/facts/${esc(f.id)}/remove"><button class="small">Delete</button></form></li>`)
        .join("")}</ul>`
    : `<p class="muted">Nothing learned yet.</p>`;
  const notes = card.notes.length
    ? `<ul>${card.notes
        .map(
          ({ note, dropsOff }) => `<li>${esc(note.body)} <span class="muted">· ${esc(note.author ?? "")} · drops off by ${esc(when(dropsOff))}, or sooner once 10 newer notes come in</span>
<details><summary class="muted">Make it lasting</summary><form method="post" action="${base}/notes/${esc(note.id)}/lasting"><textarea name="text" required>${esc(note.body)}</textarea>
<p class="muted">${note.body.length} characters; a guidance line is at most ${GUIDANCE_MAX_CHARS}.</p><button class="primary small">Save as guidance</button></form></details></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">No recent notes.</p>`;
  const p = card.plan;
  const plan = p
    ? `<div>${esc(p.step)}</div><div class="muted">${esc(p.days.join(" "))} at ${esc(p.stepTime)}${p.place ? `, ${esc(p.place)}` : ""} · proof: ${esc(p.proof)}${p.proofNote ? ` (${esc(p.proofNote)})` : ""} · v${esc(p.version)}</div>`
    : `<div class="muted">No plan locked yet.</div>`;
  const quiet = `<div class="muted">Quiet hours ${esc(card.quiet.start)} to ${esc(card.quiet.end)} (${card.quiet.chosen ? "they chose these" : "default"})</div>`;
  const history = card.history.length ? `<ul>${card.history.map(change).join("")}</ul>` : `<p class="muted">No changes yet.</p>`;
  return `<section id="coaching" class="card coaching"><h2>Coaching</h2>
<h3>Team guidance</h3><p class="muted">Lasting. ZOH follows it where it applies and never mentions it; their own requests win.</p><ul>${guidance}</ul>${add}
<h3>Their style requests</h3>${style}
<h3>Learned preferences</h3>${learned}
<h3>Recent notes</h3>${notes}
<h3>Saved plan settings</h3>${plan}${quiet}<p class="muted"><a href="/console/testers/${esc(testerId)}?tab=progress#plans">Plan versions</a> · to change them, ask in console chat (the tester agrees first).</p>
<details><summary><h3 style="display:inline">History</h3></summary>${history}</details></section>`;
}
