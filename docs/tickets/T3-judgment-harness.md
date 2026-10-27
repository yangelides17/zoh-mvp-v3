# T3 · Coach judgment harness (simulate, grade, report)

**Feature:** the "Checking the coach's judgment" section every feature page has (template section 7).
**Starts after:** nothing. **Runs alongside:** T1. **Used by:** T2 and every coach ticket after it.

## Prompt (paste this into a new Claude Code session)

> You're building ticket T3 for ZOH. Read `CLAUDE.md`, `docs/runbook.md`, this ticket
> (`docs/tickets/T3-judgment-harness.md`), `docs/features/template.md` (sections 7 and "When the
> coach goes off the rails") and `docs/features/04-onboarding.md` (sections 3, 4 and 7) first.
> Work on branch `ticket/T3-judgment-harness`. Unit-test the parts that don't need Claude, keep to
> the files this ticket owns, get `npm run check` green, run the harness once for real against
> the current app, and open a PR with that report. If anything needs a product decision, stop and
> ask me instead of choosing.

## Why

Normal tests can't tell whether ZOH sounds right, asks the right next question or stays short.
This harness plays testers against the real coach and has a separate Claude grade every ZOH
text against the written rules, so each coach change comes with evidence, and every mistake we
fix stays fixed.

## Build

1. **`npm run eval -- <feature> [--persona <name>] [--runs <n>]`** (in `eval/`, run with `tsx`).
   Reads `ANTHROPIC_API_KEY` from `.env`; says so clearly and exits if it's missing. Not part of
   `npm run check` (tests never call Claude).
2. **Runs the real app, not a copy of the prompt:** builds the app the same way production does,
   with an in-memory database (PGlite), a fake Sendblue that records outgoing texts, a fake media
   fetcher and an injectable clock, and the real Claude-backed coach. Do this by moving the startup
   wiring from `src/index.ts` into a small `src/wiring.ts` that both use, so whatever coach T2
   builds is what the eval runs. Read the tester's saved state from the database at the end of
   each conversation and include it in the report.
3. **Simulator:** a Claude playing the tester from a scenario: persona (terse, chatty, joking,
   confused, answers-everything-at-once; resistant where a page asks for it), goal, and hidden
   facts it answers from (name, schedule, time available, equipment, area code). Texts like a real
   person (short, lowercase when the persona would), never reveals it's a simulator, and stops
   when ZOH has wrapped up onboarding or after a turn cap (default 20).
4. **Scenarios for onboarding** (`eval/scenarios/onboarding.ts`): the page's example
   conversations (Alex at the gym, Maya answering everything at once, Sam's reality check, Sam's
   off-topic book question) plus the five personas across at least four different starting goals,
   one non-Eastern area code, one off-list goal that should be declined and one close enough to
   accept, one style request mid-way ("no emojis pls"), and one text sent at 11 pm.
5. **Grader:** a separate Claude call that sees only the transcript, the feature page's rules and
   the voice page (read from `docs/features/` at run time, so page updates flow in). It scores
   every ZOH text pass/fail per applicable rule with a one-line reason, plus whole-conversation
   checks (first text has ZOH + stop + goal list + name-and-goal question; nothing asked twice;
   reality check when needed; finishes with recap and plan-is-coming line; length and one
   question per text). Structured JSON output; retry once on malformed output.
6. **Report** (`eval/reports/<timestamp>-<feature>.md` + `.json`, gitignored): pass rate per rule
   and per persona, the three worst replies quoted with reasons, what changed since the previous
   run, saved state per conversation, and 3 to 5 suggested live checks for Yanni drawn from
   borderline and failed cases. Print a short summary to the console.
7. **Regression cases** (`eval/cases/<feature>/*.json`): a fixed exchange that once went wrong
   (tester lines scripted, ZOH replies generated fresh) plus what should have happened. The runner
   replays every case for the feature on every run and grades it alongside the scenarios. Start
   with a README describing the format and one example case built from the page's "Avoid: a form
   in disguise" example.
8. **Cost guard:** print the number of conversations and a rough token/cost estimate before
   starting; models configurable (`EVAL_MODEL`, default the coach's model).

## Owns

`eval/**` (new), `src/wiring.ts` (new) and the matching slimming of `src/index.ts`,
`package.json` scripts, `.gitignore` (`eval/reports/`), `tsconfig` includes if needed, new
`test/eval*.test.ts`. T1 also touches `src/index.ts` wiring; whichever merges second rebases.

## Not in this ticket

Changing what ZOH says (T2), scenarios for features other than onboarding, CI integration of the
eval.

## Done means

- [ ] Unit tests (no Claude): scenario loading, case replay order, grade aggregation into pass
      rates, worst-reply selection and the "changed since last run" diff, using fake grader output.
- [ ] `npm run eval -- onboarding` runs end to end against today's app and writes a report. Today's
      generic coach is expected to fail most onboarding rules; that's the baseline T2 improves on.
- [ ] Missing `ANTHROPIC_API_KEY` gives a clear message, not a stack trace.
- [ ] Nothing in the harness can reach Sendblue or text a real number.
- [ ] `npm run check` green.

## Hand-off

PR with the template, including the baseline report summary and how to run it (one line for
Yanni: add `ANTHROPIC_API_KEY` to `.env`, then `npm run eval -- onboarding`).
