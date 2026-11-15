# Coach judgment harness

Plays simulated testers (and replayed regression cases) against the **real app** and has a
separate Claude grade every ZOH text against the feature's approved checks and the voice page.

```bash
# once: put your key in .env (gitignored)
ANTHROPIC_API_KEY=sk-ant-...

npm run eval -- onboarding --case recap-invents-details   # only that case: the usual, cheap run (Haiku grades)
npm run eval -- onboarding --case recap-invents-details --runs 3 --compare   # 3 runs, compared with the stored baseline
npm run eval -- onboarding                    # every scenario once + every regression case
npm run eval -- onboarding --persona terse    # only terse scenarios (cases still run)
npm run eval -- plan --scenario bedtime-late  # only that scenario: cheap while iterating
npm run eval -- onboarding --runs 3           # each scenario and case three times
npm run eval -- onboarding --dry-run          # what would run and the cost estimate; no Claude calls
npm run eval -- onboarding --regrade eval/reports/<report>.json   # grade a saved report again with the current checks
npm run eval -- all --runs 3 --compare --store-baseline        # the release's full run: every feature's cases
```

## How to test a change to ZOH's words

1. **Pick the cases it touches** (`--case <id>`, repeatable). Add one in `eval/cases/<feature>/` when none covers
   it. A new behavior's cases are `"suite": "capability"`; they start low and that's expected.
2. **Iterate cheaply:** one run, `npm run eval -- <feature> --case <id>`, reading the transcripts.
3. **Compare once it looks right:** `npm run eval -- <feature> --case <id>... --runs 3 --compare --store-baseline`.
   The cases run 3 times, the report is compared with the stored baseline case by case, and their runs become
   the branch's baseline for them (commit `eval/baselines/` with the branch; it replaces those cases on merge).
4. **Read the report's "Compared with the baseline":** it names any group or regression case that got worse
   beyond noise, in plain words. A change within noise isn't a regression, and isn't proof of a win either.
   Read the transcripts too: numbers that look good on something that feels off don't ship.
5. **If it stops before running** because the baseline was graded with different checks, voice page or grader
   (your change edited them), run the `--regrade-baseline` command it prints first (grader only, a few cents).

**Scores by group.** Every check in `eval/features.ts` has a group: `conversation` (how ZOH talks with them),
`goal` (the case's own `regression` check), `flow` (steps and facts) and `style` (format and tone). A conversation
passes a group only if every check in it passed, so formatting can't sink conversation quality. A case's runs are
averaged first and the ± is a 95% margin across cases (Student's t), so 3 runs of one case don't count as 3
pieces of evidence. Style is shown but never decides.

**Beyond noise.** A group got worse only when the per-case differences' 95% range is wholly below zero *and* a
Fisher test on the pooled runs agrees (5%), which keeps a few identical cases from looking certain. A regression
case is flagged on a one-sided Fisher test at 5%: 3/3 → 0/3 runs is flagged, 3/3 → 1/3 isn't. With 1 or 2 cases
there's no useful margin, and the report says so.

**Suites.** Each case has a `suite`: `regression` (the default: established behavior; a drop is flagged),
`capability` (a new feature's cases: listed "ready to graduate" once they pass every run in the baseline and
again in a comparison; then set `"suite": "regression"`) or `replay` (a real tester conversation: reported apart,
never tuned against). Simulated scenarios count as regression.

**Checking the grader** (`npm run grader-check -- <feature | all> [--runs 3] [--report <report.json> --sample 4]`):
- *Rules, against known answers:* each file in `eval/known/<feature>/` is a short conversation written to
  follow or break one rule (`expect: pass | fail`). Graded as usual, they give each rule's catch rate (breaks
  failed) and pass rate (follows passed). There are two per key rule to start; add one whenever the grader and a
  person disagree on a real conversation. About $0.09 for all of them × 3 runs.
- *Feel, against a stronger model:* with `--report`, a stronger, separate model (Opus; `EVAL_STRONG_MODEL`
  overrides) grades the conversation checks on a spread-out sample of that report, and the report shows how often
  the regular grader failed what it failed and passed what it passed. About $0.30 a conversation, so keep the
  sample small. It's a stand-in for a person's judgment, not the real thing.
- `not-leading` and `not-dragging` (the checks that misfired most) are graded in their own call (`alone` in
  `eval/features.ts`); one question per text is counted in code (`code`), never asked of the grader.

**Real replays** (`npm run real -- ...`, read-only against production with `DATABASE_URL`, Railway's public
Postgres URL): `list [--days 14]` shows real conversations worth a look, picked by signals ("stop", silence after a
question, a correction like "I already said", a sudden short reply), with numbers masked; possibly sensitive ones
(health, personal crises) are left out. `replay <last 4> <ZOH text id> <feature>` turns one moment into a
`replay` case, cut just before ZOH's text, with names (theirs and the people they mention) and numbers masked;
it's refused if anything number-like is left. Read the case before using it. Signals choose what to look at,
never targets to optimize, and replays are never tuned against.

**Baselines** are committed, one file per case in `eval/baselines/<feature>/`: its graded runs and what produced
them (grader model, checks, voice page, grader instructions, the case's script). A comparison needs the same
grader, checks and voice page on both sides; a mismatch is caught before anything is spent. A case whose script
changed counts as new. The release refreshes every case (`all`, cases only, about $8 estimated for 3 runs).

In a Claude Code cloud environment, add the key as `EVAL_ANTHROPIC_API_KEY` instead (Claude Code
reserves `ANTHROPIC_API_KEY` for its own login there), and run with `env -u ANTHROPIC_BASE_URL npm run
eval -- onboarding` so calls go to the Anthropic API rather than the session's own proxy.

Other flags: `--max-turns <n>` (tester texts before a conversation is cut off, default 20),
`--concurrency <n>` (conversations at once, default 3), `--over-budget` (only with Yanni's OK).
The grader runs on Haiku (`claude-haiku-5-5`), the same on both sides of a comparison and in the stored
baselines; `--final` grades with the coach's `CLAUDE_MODEL` instead (a comparison then needs a baseline
re-graded with it), and `EVAL_MODEL` overrides both. `EVAL_SIM_MODEL` sets the simulated tester (default Haiku).
In an 8-case calibration (#174) Haiku caught every planted past mistake and agreed with Sonnet on 97% of checks
at about 1/14 of the grading cost, but named fewer secondary problems.

**Budget:** $1 of eval spend per issue the branch builds, counted from its name
(`feature/41-42-48-...` is $3), up to $3 (`EVAL_BUDGET_USD` overrides), tracked in `eval/reports/spend.json`;
the release's full run (`all`) has its own $4.50 (#197). A run that would likely go past it refuses to start.
Run only the cases a change touches (`--case <id>`, repeatable). Measured Nov 13 on short cases: about $0.015 a
case run graded by Haiku (so about $0.05 for 3 runs) and $0.04 with `--final`; longer cases and memory cases cost
more. A full run is only for changes that affect every conversation, with Yanni's OK. Not part of
`npm run check`: tests never call Claude.

## What happens

1. **Plan.** Scenarios from `eval/scenarios/<feature>.ts`, then every case in `eval/cases/<feature>/` in
   file-name order, each × `--runs`. It prints the count and a rough token/cost range, and with `--compare`
   checks the stored baseline matches before spending anything.
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
5. **Report.** `eval/reports/<timestamp>-<feature>.md` and `.json` (gitignored): scores by group, the
   comparison with the baseline (with `--compare`), pass rate per rule and per persona, the three worst
   replies, what changed since the previous report, 3 to 5 live checks for Yanni, each transcript and the
   tester's saved state read back from the database. `--store-baseline` also writes the run's cases to
   `eval/baselines/`.

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
  `eval/features.ts`. Add an id there, with its `group`, when a page gains a rule that none of the ids covers.
  Changing a label (or `alone` / `code`) changes the checks, so the next comparison asks for `--regrade-baseline` first.
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
