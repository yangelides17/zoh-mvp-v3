# Memory lab: testing memory on synthetic testers

Status: in progress (Stamati, 2026-11-05). Goal: confirm memory is well behaved before changing it
(`docs/memory-design.md`). First measure today's memory as a baseline, then the new design, on the same
data.

## Principles

- **Synthetic data only.** No real beta conversations, not even the founders'.
- **Realistic data matters most.** People don't share everything, don't text every day, answer questions
  badly, contradict themselves, joke, vent and go quiet. The fake ZOH must follow the real product's rules
  and voice, or the data stops being realistic.
- **Write once, freeze, replay.** Conversations are written once and never regenerated, so an A/B
  comparison measures memory, not random text.
- **Real rows.** Fixtures load as ordinary testers, messages and tracker rows through the normal schema,
  labeled as synthetic. Whatever memory version wins reads them exactly like real data: nothing to port.
- **Keep a close eye on cost.** The conversations are written in a Claude chat, not by an API generator.
  Grading uses free code checks every night and the Claude grader only on chosen nights. Any run that
  spends money has a cap and refuses to start past it.

## Parts (one spec each)

1. **Synthetic testers + loader** (part 1): the scenario label, fictional numbers, everything that texts
   or spends Claude calls skips synthetic testers, and `npm run load-scenario`.
2. **Replay + scoring** (part 2): replay a scenario night by night into a throwaway database with any
   memory version, snapshot memory after each night, score it.
3. **Viewer** (part 3): a day slider over the tree, each night's changes highlighted, entry → source
   text, A/B side by side, metrics over time.

## Synthetic testers

- A non-null `scenario` on the tester row marks it synthetic ("sam").
- Phone numbers are fictional: +1, any area code, then 555-01xx (`^\+1\d{3}55501\d{2}$`). They are never
  in `ALLOWED_NUMBERS`.
- Everything that texts or calls Claude skips them explicitly by `scenario`, not only via the allowlist
  (the console's weekly summaries and alert whys loop over all active testers).
- Metrics exclude them; the console shows them with a "synthetic" chip.
- The loader refuses any database holding a tester who is neither a dev account nor synthetic
  (production has real testers; staging and throwaway databases don't). No override.

## Fixture format (version 1)

One file per scenario per week: `eval/memory-lab/fixtures/<scenario>.week<n>.json`. The loader loads all
of a scenario's weeks together; reloading deletes the synthetic tester (rows and memory cascade) and
reinserts.

```json
{
  "scenario": "sam", "week": 1, "format": 1, "notes": "...",
  "tester": { "phone": "+15555550101", "time_zone": "America/New_York",
              "time_zone_status": "assumed_eastern", "first_text": { "day": 1, "time": "21:40" } },
  "events": [ { "day": 2, "time": "16:20", "kind": "plan_locked", "plan": { "...": "..." } } ],
  "messages": [ { "day": 4, "time": "17:20", "from": "tester", "text": "almost died lol",
                  "media": { "kind": "image", "content_type": "image/png", "description": "Strava screenshot: ..." },
                  "tests": "fixture-only note" } ]
}
```

- Days are relative (day 1 = a Monday); times are the tester's local time. `--start <YYYY-MM-DD>` picks
  the real Monday. Each message's sent and created time come from its day and time.
- `from`: `tester` (inbound) or `zoh` (outbound). Media carries the stored description or transcript; no
  files.
- Event kinds: `tester_update`, `phase`, `goal_chosen` (with role), `goal_role` (focus / maintenance /
  dropped; optional `checkins_per_week` when becoming maintenance), `goal_switch` (writes the same
  goal-switch flag the app writes; memory builds goal pages from it), `plan_locked` (any version,
  change kind deepen / upgrade / other, optional end date), `step_day`, `takeaway`, `checkin`
  (maintenance check-in: goal, optional answer and answered_at; links to the ZOH message at that
  day+time when one matches), `suggestion` (raised by, `suggestion_kind` for the suggestion's own
  kind — `suggestion_kind` not `kind`, because `kind` is the event discriminator — proposal,
  founders' decision, outcome), `went_quiet` (auto-texts paused + founder alert via `saveFlag`),
  `stated_preference` (a coaching-style preference: `preference` string, optional `replaces` array of
  f: refs to drop), `forget` (a forget request: `request` string describing what to forget).
  Unknown kinds are rejected.
- **`stated_preference` and `forget` are replay-only.** `load-scenario` parses them and returns them in
  `liveWrites` but does NOT execute them. Only the replay runner (`npm run lab:replay`) applies them at the
  right time, because they need memory to exist first.
- `notes` and `tests` are fixture-only and are never written to the database (memory must never see the
  answer key).

## Testers

Five testers, four weeks each, built from a skeleton first (hidden truth, texting style, threads with
lifespans from hours to the full month, the coached goal's path, planned test moments, answer key).

| # | Scenario | Who | Style | Coached goal | Other threads |
| --- | --- | --- | --- | --- | --- |
| 1 | `sam` | ER nurse, 28, nights | Chatty but terse texts | Get fitter (running), 4 weeks, plan v1 → v2 (time) → v3 (deepen) | Sister's wedding, running buddy, sore knee, 3-day silence, wants friends (new-focus request), maybe a day-shift job, car trouble (hours) |
| 2 | (todo) | College junior, 20 | Terse, late nights | Reading 2 weeks, then switches to focus | Midterms, café job, roommate fight |
| 3 | (todo) | Working parent, 38 | All at once | Sleep better, 4 weeks | School play, side project from week 3, partner away a week |
| 4 | (todo) | Freelance designer, 31 | Joking | Put AI to work, plan upgraded midway | Moving apartments, client crunch, dating someone new |
| 5 | (todo) | Sales manager, 45 | Resistant | Eat better, misses and a lighter plan | Doctor visit (sensitive), daughter's college visits, a forget request |

Sam's skeleton and answer key: Claude Doc "Memory Lab Skeleton 1: Sam". Week 1 fixture: `sam.week1.json`.

## Scenario library (what the five testers cover)

Steady growth and placement · a fact that changes (replace, not duplicate) · a correction (in place,
alias kept) · a future event then silence about it (follow-up after the date) · a want ZOH can't coach
(page, no coaching) · passing mentions (nothing) · jokes and hypotheticals (not facts) · facts about other
people (their page) · sensitive details (not stored) · forget then nearby topics (gone, never refiled) ·
goal switch (old page past, new page linked) · a long silence then a burst (no gaps, nothing invented) ·
a very busy day (nothing dropped).

## Scoring (part 2)

Free code checks, every night: structure rules held; forget leaks (any = fail); churn (pages and entries
created, replaced, closed); duplicates; memory block size.

Claude grader against the answer key, on chosen nights only (end of each week, nights after test
moments): recall, accuracy (each entry supported by its cited text), placement, staleness, About rule.

Usefulness: probe questions answered from memory alone ("who's Ana?", "what's coming this week?") and
graded.

A/B: same frozen fixtures, different memory versions, 3 runs each (Claude varies; stability across runs
is itself measured). Baseline today's memory first.

## Replay (`npm run lab:replay`)

The replay runner creates a throwaway PGlite database, loads a scenario's fixtures, then steps through
each day calling the real `writeDay` (and any `stated_preference` / `forget` fixture events) at their
simulated 3 am time. After each night it snapshots all memory rows to JSON, renders the memory block to
text, and runs free structure checks. After all nights, it grades checkpoint nights against the answer key.

```
npm run lab:replay -- <scenario> --start <YYYY-MM-DD> [options]
```

Options:
- `--start <YYYY-MM-DD>`: the Monday that day 1 maps to (required).
- `--through-day <N>`: replay only through day N (default: last day with inbound texts).
- `--runs <N>`: run N times for stability analysis (default: 1).
- `--memory <version>`: memory version to test (default: "current").
- `--dry-run`: print cost estimate and exit without calling Claude.

Output: `eval/memory-lab/runs/<run-id>/` with `night-NN.json`, `night-NN.txt`, `spend.json` and
`report.json`. The runs directory is gitignored.

Cost: $8 per-run cap, $25 per-command (all runs combined) hard cap, checked before each run starts.
`--dry-run` shows the estimate.

Answer keys: `eval/memory-lab/keys/<scenario>.json` (format 1). Checkpoints say what memory should and
should not hold after a given day, plus probe questions. The grader sees only stripped memory (no message
text); probes see the rendered memory block.

## Before freezing a fixture

Every skeleton beat appears on its day; no ZOH text breaks a product rule (quiet hours, nudge timing, one
question, voice); no tester text reveals a fact early; fake ZOH never says anything the tester hasn't
revealed; a human reads week 1 and two random days from each later week.
