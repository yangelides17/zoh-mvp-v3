# T2 · Coach engine and onboarding conversation

**Features:** 3 (coach brain) and 4 (onboarding), with today's minimal memory.
**Starts after:** T1 is merged. **Uses:** T3's `npm run eval` once merged.

## Prompt (paste this into a new Claude Code session)

> You're building ticket T2 for ZOH. Read `CLAUDE.md`, `docs/runbook.md`, this ticket
> (`docs/tickets/T2-coach-onboarding.md`), `docs/features/coach-voice.md`,
> `docs/features/04-onboarding.md` and `docs/features/template.md` (the parts about checking the
> coach's judgment and keeping instructions lean) first. Pull `main` (T1 is merged) and work on
> branch `ticket/T2-coach-onboarding`. Write the "Done means" tests first or alongside, keep to the
> files this ticket owns, get `npm run check` green, then run `npm run eval -- onboarding` and
> improve the coach until it passes, and open a PR with the report summary. If anything conflicts
> with the pages or needs a product decision, stop and ask me instead of choosing.

## Why

This is the Monday bar: a tester texts the ZOH line, gets a warm introduction with the goal list,
and in a natural 6 to 12 text conversation ZOH learns everything the plan will need, saves it, and
ends with a recap and a fun "your plan is coming" line. It replaces the generic Claude reply.

## Build

1. **Coach engine** (`src/coach/`, plus changes in `src/claude/`): a Claude call with tools and a
   short tool loop (cap the rounds), returning the text to send. Prompt caching on the fixed
   instructions. Keep the `Replier`-style seam so tests can fake it, and keep the "Got it"
   fallback when Claude fails.
2. **Instructions, lean and in one place** (`src/coach/prompt*.ts` or `.md` files it loads):
   - Core voice: a condensed version of `coach-voice.md` (who ZOH is, how it texts, what it never
     does). Set a length budget and note it in the code. Leave out what doesn't apply yet
     (slipping ladder, pushiness levels beyond "Pushy by default").
   - Onboarding block: the page's sections 2 and 4, briefly.
   - State block, rebuilt every call: what's saved so far (name, goal, each plan input, tracks
     with, time zone status, quiet hours, style notes), which questions are still open for this
     goal, the goal list, the tester's local time, and whether this is their first text.
   - A handful of model exchanges at most; the rest of the examples belong in the eval suite.
3. **Tools** the coach uses to save what it learns (names up to you): save name; choose goal
   (slug, or `something_else` with a description and whether ZOH accepts it; a declined one
   saves a flag `off_list_goal`); save plan inputs (any of what, where, when, how long, tracks
   with; several at once); set time zone from a city (only when status is `needs_city`); set quiet
   hours (only when the tester asks); save style note ("no emojis", "chill out"); opt out (calls
   T1's function, for "leave me alone" and similar). Tools validate input and return the updated
   state so the next round sees it.
4. **The app decides when onboarding is done**, not the model: when the goal and every required
   plan question for it are saved, phase moves `onboarding → planning`, and that turn's reply is
   the one-line recap plus the excited plan-is-coming line (e.g. "Your plan is buffering… this is
   a great start. Ready shortly 🔥"). After that, until feature 5 ships, ZOH answers normally
   and says the plan is on its way if asked; it doesn't start new onboarding questions.
5. **Memory for now:** during onboarding and planning, the coach gets the whole conversation since
   the tester's context started (T1's since filter), not the last 12 messages, with a high safety
   cap (e.g. 200 messages), plus the state block. Photos and voice-note transcripts keep working.
6. **First text:** a brand-new tester (or one just reset) gets the introduction from the page:
   it's ZOH, it'll text every day to help them start one thing and stick with it, "stop" works
   anytime, the goal list one per line with •, and "What's your name, and what are you looking to
   work on?" If their first text already says their name or goal (Maya's example), ZOH uses it
   and skips ahead. Whatever they send first, the intro still says it's ZOH and that "stop" works.
7. **Eval:** run `npm run eval -- onboarding` (from T3). Iterate on the instructions, not on special
   cases, until every rule passes on every persona, or explain in the PR what's still failing and
   why. Report: pass rates, three worst replies, suggested live checks, and the before/after of
   your last instruction changes.

## Owns

`src/coach/**` (new), `src/claude/**`, the reply step of `src/pipeline/inbound.ts`, coach wiring in
`src/wiring.ts`/`src/index.ts`, `test/helpers.ts` (a fake coach that can return tool calls),
new `test/coach*.test.ts`, and new regression cases under `eval/cases/onboarding/` for any mistake
you fix. Don't change T1's schema unless you have to; if you do, it's one new migration.

## Not in this ticket

Writing or proposing the plan (feature 5), nudges of any kind, founder notifications, the full
memory system (feature 8), pause/gentler/pushier commands (feature 12), console.

## Done means (automated, with a fake coach where the model would be)

- [ ] A first text creates the tester and the reply path asks the coach with first-text state;
      the real prompt includes the intro requirements and the goal list.
- [ ] Each tool saves exactly what it should and rejects bad input (unknown goal slug, time zone
      change when status isn't `needs_city`, etc.).
- [ ] Several answers in one tool call are all saved; nothing saved is shown as "still open".
- [ ] When the last required answer is saved, phase becomes `planning` and that reply is the recap
      plus plan-is-coming turn; later texts don't restart onboarding questions.
- [ ] Required questions follow the goal (T1's `goals.plan_questions`): `tracks_with` only for
      exercise, nutrition, bedtime and deep work, and "I don't track it" is a valid answer that
      completes it.
- [ ] A declined "something else" saves an `off_list_goal` flag; an accepted one is stored with
      its description.
- [ ] The coach sees the whole conversation since context start (more than 12 messages) and
      nothing from before a reset.
- [ ] "stop" still never reaches the coach; "leave me alone" reaches it and the opt-out tool stops
      the tester with the exact confirmation text.
- [ ] Claude failing still sends "Got it" and records the error.
- [ ] `npm run eval -- onboarding` report attached in the PR (judgment rules from page section 7).

## Hand-off

PR with the template, including the eval summary and the page's live checklist (section 6) as
"How to check it live". Flag for Yanni any change to how ZOH sounds beyond onboarding.
