# Coach judgment harness

Plays simulated testers (and replayed regression cases) against the **real app** and has a
separate Claude grade every ZOH text against the feature page's rules and the voice page.

```bash
# once: put your key in .env (gitignored)
ANTHROPIC_API_KEY=sk-ant-...

npm run eval -- onboarding                    # every scenario once + every regression case
npm run eval -- onboarding --persona terse    # only terse scenarios (cases still run)
npm run eval -- onboarding --runs 3           # each scenario three times
npm run eval -- onboarding --dry-run          # what would run and the cost estimate; no Claude calls
```

In a Claude Code cloud environment, add the key as `EVAL_ANTHROPIC_API_KEY` instead (Claude Code
reserves `ANTHROPIC_API_KEY` for its own login there), and run with `env -u ANTHROPIC_BASE_URL npm run
eval -- onboarding` so calls go to the Anthropic API rather than the session's own proxy.

Other flags: `--max-turns <n>` (tester texts before a conversation is cut off, default 20),
`--concurrency <n>` (conversations at once, default 3). `EVAL_MODEL` sets the simulator and
grader model; it defaults to the coach's `CLAUDE_MODEL`. Not part of `npm run check`: tests never
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
   area code), section 4 of the feature page and the whole voice page, read from `docs/features/`
   at run time. It scores each ZOH text per rule and the conversation as a whole, as structured
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
  tester answers from; `directions` are stage directions ("midway, text: no emojis pls").
- **A rule:** the grader applies the page text, but pass rates are tracked by the ids in
  `eval/features.ts`. Add an id there when a page gains a rule that none of the ids covers.
- **A regression case:** see `eval/cases/README.md`.
- **A feature:** add an entry to `FEATURES` in `eval/features.ts` and a scenarios file.
