# Coach judgment harness

Plays simulated testers (and replayed regression cases) against the **real app** and has a
separate Claude grade every ZOH text against the feature's approved checks and the voice page.

```bash
# once: put your key in .env (gitignored)
ANTHROPIC_API_KEY=sk-ant-...

npm run eval -- onboarding --case recap-invents-details   # only that case: the usual, cheap run (Haiku grades)
npm run eval -- onboarding --case recap-invents-details --final   # once at the end: graded by the coach's model
npm run eval -- onboarding                    # every scenario once + every regression case
npm run eval -- onboarding --persona terse    # only terse scenarios (cases still run)
npm run eval -- plan --scenario bedtime-late  # only that scenario: cheap while iterating
npm run eval -- onboarding --runs 3           # each scenario three times
npm run eval -- onboarding --dry-run          # what would run and the cost estimate; no Claude calls
```

In a Claude Code cloud environment, add the key as `EVAL_ANTHROPIC_API_KEY` instead (Claude Code
reserves `ANTHROPIC_API_KEY` for its own login there), and run with `env -u ANTHROPIC_BASE_URL npm run
eval -- onboarding` so calls go to the Anthropic API rather than the session's own proxy.

Other flags: `--max-turns <n>` (tester texts before a conversation is cut off, default 20),
`--concurrency <n>` (conversations at once, default 3), `--over-budget` (only with Yanni's OK).
The grader runs on Haiku (`claude-haiku-5-5`) while a build iterates and on the coach's `CLAUDE_MODEL`
with `--final`; `EVAL_MODEL` overrides both. `EVAL_SIM_MODEL` sets the simulated tester (default Haiku).
Why the split: in an 8-case calibration (#174) Haiku caught every planted past mistake and agreed with
Sonnet on 97% of checks at about 1/14 of the grading cost, but named fewer secondary problems, so the
results in the PR come from one `--final` run.

**Budget:** $0.50 of eval spend per issue the branch builds, counted from its name
(`feature/41-42-48-...` is $1.50), up to $1.50 (`EVAL_BUDGET_USD` overrides), tracked in `eval/reports/spend.json`.
A run that would likely go past it refuses to start. Run only the cases a change touches (`--case <id>`,
repeatable). Measured Nov 13 on short cases: about $0.015 a case graded by Haiku and $0.04 with `--final`
(longer cases and memory cases cost more). A full run is only for changes that affect every conversation,
with Yanni's OK. Not part of `npm run check`: tests never
call Claude.

## What happens

1. **Plan.** Scenarios from `eval/scenarios/<feature>.ts` (× `--runs`), then every case in
   `eval/cases/<feature>/` in file-name order. It prints the count and a rough token/cost range.
2. **Run.** Each conversation gets a fresh app built through `src/wiring.ts`, exactly as
   production builds it, except: an in-memory Postgres (PGlite), a recording fake instead of
   Sendblue, no bucket or Speaches, a fake media fetcher and a clock that starts at the scenario's
   local time. Every tester text goes in through the real `/webhooks/sendblue` route. The coach is
   whatever `src/wiring.ts` builds, so a new coach is evaluated without touching the eval.
3. **Simulate.** For scenarios, a Claude plays the tester from the persona, goal and hidden facts
   and stops when ZOH wraps up (or at the turn cap). Cases send their scripted lines instead.
4. **Grade.** A separate Claude call sees only the transcript (with local times and the tester's
   area code), the feature's approved checks (the rubric in `eval/features.ts`, copied from the
   spec's "Should" list) and the whole voice page (`docs/coach-voice.md`), read at run time. It scores each ZOH text per rule and the conversation as a whole, as structured
   JSON, retrying once if the output is unusable.
5. **Report.** `eval/reports/<timestamp>-<feature>.md` and `.json` (gitignored): pass rate per rule
   and per persona, the three worst replies, what changed since the previous report, 3 to 5 live
   checks for Yanni, each transcript and the tester's saved state read back from the database.

## Safety

Nothing here can text a real person: the app's Sendblue client is replaced by a recorder that only
accepts the conversation's own fake number (`+1 <area code> 555-01xx`), the eval's config never
reads Sendblue settings, and any `fetch` to a Sendblue host is blocked for the whole run.

## Adding things

- **A scenario:** add it to `eval/scenarios/<feature>.ts`. Hidden facts are what the simulated
  tester answers from; `directions` are stage directions ("midway, text: no emojis pls"). A `seed`
  starts it partway in (saved answers, the conversation so far, optionally a locked plan), so a
  later feature's run skips onboarding; the seeded lines are context for the simulator and grader,
  never graded. Cases take a `seed` too.
- **A rule:** the grader applies the page text, but pass rates are tracked by the ids in
  `eval/features.ts`. Add an id there when a page gains a rule that none of the ids covers.
- **A regression case:** see `eval/cases/README.md`.
- **Memory** (`memory` feature only): when an `advance to` line passes 3 am, the real overnight memory
  pass runs (about $0.08 a day, in the estimate), and the grader sees the tester's memory at the start and at
  the end, with their step days. A seed's `memory` files weeks of earlier memory (pages and facts with
  `days_ago`, daily docs, earlier plan versions and goals), so a case can start two weeks in.
- **Nudges** (texts ZOH starts itself): a case line `advance to HH:MM` isn't a text: the clock moves
  to the next such local time, running the production nudge tick each minute, and any nudges join the
  transcript marked as started by ZOH. A seed's `history_hours_ago` puts the seeded conversation
  earlier (e.g. the evening before); its plan's `started_days_ago` and `minutes` set day 1 and how
  long the step takes. See `eval/cases/nudges/`.
- **Console** (founders' chat): a case line `console Yanni: ...` goes through the real console chat as
  that founder; ZOH's console answer and any draft card it makes join the transcript marked as console.
  `console Yanni (do it)` clicks Do it on the newest draft (#155), and a text it queues goes out on the next
  minute's tick. The
  estimate counts the coach's console calls loosely. See `eval/cases/console/`.
- **Texts sent together** (#16): a case line with ` +++ ` between texts posts them a second apart
  without waiting for ZOH in between (`[photo x.jpg: …] +++ Not bad!`); the grader reads the line as
  written and sees every reply ZOH sent. See `eval/cases/batch/`.
- **A feature:** add an entry to `FEATURES` in `eval/features.ts` and a scenarios file.
