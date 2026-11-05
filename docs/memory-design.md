# Coach memory: design v1 (proposed)

Status: proposed design, agreed by Stamati on 2026-11-01. Not built yet. Specs that build it say
"follows docs/memory-design.md" and live in their issues as usual. The testing plan that comes first
is `docs/memory-lab.md`.

## Summary

Memory becomes one tree per tester, shaped by their actual life, built by **extending** today's memory
(#8) and switched on **one tester at a time**. The goal tracker, nudges, plans and streaks don't change.
Memory keeps plugging into the same three places it does today.

## Principles

| Principle | In practice |
| --- | --- |
| Memory describes the person; the coach decides scope | Pages follow the tester's life. The goal menu only decides what ZOH coaches. "Help me socialize" gets a page even before ZOH can coach it. |
| The tree is the only structure code walks | Each page has exactly one parent. "Context of X" = the path to the root, computed by code. Cross-links are hints shown to the model, never followed by code. |
| Up is mechanical, down is guided | Code builds the path up. Going down, the model picks branches from one-line summaries. |
| Write once | A fact lives in one place. Order, status, parent views and the tracker's numbers are computed when read. |
| Summaries hold only permanent facts | An About must still be true after the page is finished. Dates, prices, progress are entries. Abouts almost never change, so nothing propagates. |
| Changes add, they don't overwrite | A changed fact is a new entry that replaces the old one; the old one becomes history. Only genuine errors are corrected in place. Forget is the only true delete. |
| Rules live in code where possible | Citations, evidence thresholds, depth, entry types are checked by code, not just asked for in the prompt. |
| Two ways in: tree and type | Every entry has a place in the tree and a type with status and date. |
| Fields hold only what was said or clearly shown | Guesses become Unsure entries. Inferences need evidence on 3+ days and stay labeled as inferred. |
| Remembering is not agreeing to coach | The coach stays honest that it can't help with something yet. |
| No breaking changes | Everything new is additive and behind a per-tester switch. |

## The tree

At most three tiers. Nothing below tier 2; anything more specific is an entry on a tier-2 page.

| Tier | What | Made by |
| --- | --- | --- |
| 0 Root | The person as a whole | Code, at signup |
| 1 Required | Coaching (how to coach them, how they text), People (everyone, pets too), Places | Code, at signup |
| 1 Parts of life | An ongoing part of life they spend time on or want (Work, Running, Socializing) | Nightly pass |
| 2 Subpages | A specific project, goal or recurring thing; one page per person or place | Nightly pass; goal pages by code from the tracker |

Rules:
- One parent per page, enforced by the database.
- People and places always live under People and Places (never under an area like Family), so they are
  shared connection points.
- A coached goal is always a tier-2 page under the part of life it belongs to; the area is created first
  if needed. It links to the tracker goal.
- Areas are named for the part of life, not the goal ("Running", not "Run a 5K"), in the tester's words.
- No limits on page or entry counts. The weekly pass splits long pages and merges duplicates.

## Pages

| Part | Holds | Stored |
| --- | --- | --- |
| Label | Title, other names (Ana / Anna), parent, kind (root, area, project, person, place, coaching, people, places), status (active, paused, done, past), hint links | On the page row, once |
| About | 1 to 3 sentences on what the page is | On the page row, once |
| Entries | Everything else, typed rows | Entry rows pointing to the page |
| Children | Pages under this one | Not stored; found by their parent |
| History | Replaced, expired, done, dropped entries | Entry rows, hidden unless asked |

**About rule:** one About, written by the page itself, shown up (to the parent) and down (to children).
Test: would it still be true after the page is finished? Never restate children. Rewrites are
corrections only.

**Root page:** facts about the whole person that aren't about any one part of life (name, age with
as-of, where they live, cross-cutting facts, character and values, why they're here). Test: if you can
name a page the fact is about, it goes there. How they text and preferences go on Coaching.

**Rendering order** (computed, no stored positions): label line; parent's About; About; coaching
section (goal pages only, computed live from the tracker); Facts, Notes, Unsure; open To-dos, Events,
Follow-ups soonest first; children's Abouts; hint links; history only on request.

**Debrief:** any page renders as a complete briefing in one read (above, the page, below). Any entry
found by a query can be wrapped the same way.

## Entries

Six types, allowed on any page:

| Type | Holds | Date | Statuses |
| --- | --- | --- | --- |
| Fact | Anything true, lasting or changing | none | current, expired |
| Note | Scratch pad: ideas, plans, what's been tried | none | current, expired |
| Unsure | Half-known; confirmed when it comes up naturally | none | current, expired |
| To-do | Something to do | due date, required | open, done, dropped |
| Event | Something that happens | when, required | open, done, dropped |
| Follow-up | Something to check on later | when to ask, required | open, done, dropped |

No "current state" type: a changing value is a Fact that gets replaced; a page status summary would be a
hand-kept copy. If wanted, generate it when read.

Fields: text, type, status, date, as of, source (the tester's own text, required), replaces (older entry),
people (person page links), origin (stated or inferred), detail (optional longer note).

Placement: on the page it is about; people involved are linked, never the location; a fact touching two
areas goes on the main one with a hint link; dated types always get a date (ZOH proposes one if none).

| Situation | Action |
| --- | --- |
| The entry was wrong ("Anna, not Ana") | Correct in place |
| The world changed ("now 3 miles") | Replace: new entry pointing to the old |
| The thing is finished | Close: done or dropped |
| They asked to forget | Delete and record the forget |

## Writing: three writers

| | During a text | Nightly, 3 am local | Weekly, Sunday night |
| --- | --- | --- | --- |
| Who | Coach, live | Filing pass (today's keeper, extended) | Pattern pass (new) |
| Reads | Conversation + memory | One day's texts + that day's tracker records | Last few weeks of texts + older daily summaries |
| Writes | Reminders/to-dos due before the next pass; done/dropped; forget; stated preferences | Facts, notes, unsure, events, follow-ups, pages, corrections, replacements, daily summary | Inferred traits and coaching patterns (3+ days of cited evidence, counted by code), settled Unsure items, splits, merges, renames |
| Never | General facts or new pages | Writes to the tracker; infers character from one day | Writes without cited evidence |

Live writes only when something must act before the next nightly pass. Every model reads the same filed
memory plus the same unfiled texts from one database, so nothing drifts.

**Page creation (nightly), first match wins:** existing page (title or other name) → an entry (default)
→ a tier-2 subpage if it will keep coming up (about 3+ entries or its own to-dos) → a tier-1 page if it is
a new part of their life they describe. Passing mentions never create pages. Merges and renames only in
the weekly pass; old names kept as other names.

**Weekly pass:** replaces today's one-observation-a-day counting. Inferences shape tone and explanations,
are never said back early ("doesn't pretend to know you"), and are replaced when the tester says
otherwise or later evidence contradicts them.

## Reading

| Block | Contents | Rebuilt |
| --- | --- | --- |
| Fixed instructions | Voice page + feature rules | Cached |
| Memory block | Root rendered (its entries + every tier-1 About); Coaching; focus goal's page with parent About and live coaching section; last 7 daily summaries | Overnight or after a live write |
| Live summary (state block) | As today, plus today's and this week's open to-dos, events, follow-ups | Every call |
| Texts | Every text since the last filed day (cap, never fewer than 30) | Every call |

Lookups stay as today (open pages, search; 5 a reply, 2 searches). Open pages is the guided walk down the
tree; search finds things the tree can't route to.

## Memory and the goal tracker

The tracker stays as it is. Memory never writes into it. Test: does code need it to run the daily loop?
Tracker. Is it understanding of the person? Memory.

1. **One goal, one page:** each tracker goal links to one tier-2 page.
2. **Live summary unchanged:** today's step, streak, week, lessons, next steps on every text.
3. **History computed:** opening a goal page adds plan versions, recent days, reflections, lessons from
   the tracker. Page status comes from the goal's role. Today's step stays in the live summary only.
4. **Memory informs, coach acts:** context leads the coach to use the tracker's own tools (move today's
   step, set today's step).
5. **Meaning from the day's records:** the nightly pass reads each day's record and files only durable
   meaning ("missed because of a double shift" → Work); never the counts.
6. **Lifecycle:** goal chosen → page created; plan versions and role changes → nothing written
   (computed); goal switched → old page past, new page, "leads to" link with the switch reason.

## Privacy and forget

Today's rules carry over: no sensitive health, mental-health, legal or financial detail beyond what the
step needs; no phone numbers, emails or addresses. The weekly pass never infers health, mental state,
sexuality, religion or money trouble. Forget deletes outright (a fact and what it replaced; a page with
its entries and links; or everything), marks source texts forgotten, and leaves a neutral note on
Coaching so nothing is refiled. Root, Coaching, People and Places can't be deleted; their entries can.

## Integration: three plugs and a switch

| Plug | Code | Change |
| --- | --- | --- |
| Writing (3 am pass) | `src/memory/keeper.ts` | Pages with parents, typed entries, replace not overwrite, reads tracker day records |
| Reading (prompt building) | `src/memory/context.ts`, `src/memory/render.ts`, `src/coach/prompt.ts` | New memory block, open items in the state block, all unfiled texts |
| Tools (coach) | `src/memory/coach-tools.ts` | Add reminder/to-do, close done/dropped |

A per-tester memory version setting is read at these three plugs only. Testers on the old version run
today's code untouched.

Database changes, all additive: pages get parent, other names, tier, new kinds and statuses; facts become
entries (type, status, date, as of, replaces, people links, origin, detail); testers get a memory version.
The database enforces one parent, depth ≤ tier 2, valid type/status pairs, dates on dated types, one root
and one each of Coaching, People, Places.

Conversion when a tester is switched: own page → root (texting style → Coaching); preferences →
Coaching; observations kept as history; person pages → under People; subject pages → under an area or
Places (one-time Claude pass); goal pages → under their area, goal path kept; daily summaries, forgotten
texts and forget notes unchanged.

Also fixed: stated preferences live only on Coaching (today they are also copied into `styleNotes`, so a
forget leaves a copy); the coach reads all unfiled texts so a failed night leaves no gap.

## Rollout

Before any of this: the memory lab (`docs/memory-lab.md`) baselines today's memory and then tests the new
design on synthetic testers.

1. Spec 1, the tree: parents and typed entries, new nightly pass, conversion, the switch. Gate: founders'
   numbers switched, trees look right.
2. Spec 2, live use: reminders, done/dropped, forget on entries, new memory block, open items, unfiled
   texts, prompt rewrite with evals. Gate: a few testers switched, memory evals pass.
3. Spec 3, weekly pass. Gate: everyone switched, no regressions.
4. Spec 4, console: tree view, open items, count of wants ZOH can't coach yet (can run alongside).
5. Retire the old code after a few stable weeks.

## Deferred

Embedding search for cross-branch hints; offline connection discovery across tier-1 Abouts; hints
computed when read; a deeper tree if one life outgrows two tiers.
