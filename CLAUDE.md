# ZOH MVP v3: working agreement for Claude and coding agents

ZOH is a text-based coach: testers text an iMessage number (Sendblue), Claude replies, and the
app nudges them through small daily steps. This repo is the server: one Node/TypeScript app on
Railway with Postgres, a private bucket and a Speaches (Whisper) transcription service.

Yanni and his brother run Claude Code from the terminal. Claude does all the git and GitHub work;
they approve specs and plans, say "merge", and test on their phones.

## How we build
GitHub Issues hold every feature, bug and idea. A label says where it stands:
`idea` → `spec-approved` → `plan-approved` → `building` → `in-review` → `done` (on merge)
(plus `decide` for Yes / Later / No questions and `bug`). Phone checks don't hold anything up: on merge, the PR's
Watch list is left as a "Live checks" comment on the issue, to come back to.

One feature, one flow, using the commands in `.claude/commands/`:
1. `/spec <idea>`: shape it with Yanni; the approved spec becomes the issue. **Gate 1.**
2. `/plan <n>`: read the code, propose the build; the approved plan is posted on the issue. **Gate 2.**
3. `/build <n>`: build on `feature/<n>-<slug>`, tests first, draft PR early, eval if ZOH's words change.
4. `/review <n>`: a fresh session checks the PR against the spec and plan; merges when Yanni says so.
5. Live checks on Yanni's phone whenever he gets to them (from the issue's "Live checks" comment); problems become `bug` issues. `/status` shows the board anytime;
   `/idea` files a new idea or bug to spec later; `/quick` makes a small change on `main` with a record.

Run at most 2 or 3 builds at once, each in its own git worktree under `../zoh-worktrees/` (never switch
branches in the main folder; `/build` and `/review` set this up and `/review` cleans up after merging). The issue is the record: spec in the body, plan and `Decision:`
notes as comments, PR linked with `Closes #n`. Don't copy specs into the repo.

**Groups and parallel builds are optional.** The commands can take several issues at once (related, dependent, or
just small) through one spec conversation, one plan and usually one PR, and `/build` can run up to 3 branches as
parallel agents. Neither is ever required: use them when Claude judges it safe and quicker, and when Claude has
concerns (too big, a database change, shared prompt files, an open question), it says so and splits the issue out
or builds one at a time. The details are in each command.

**When a request skips the flow.** If someone asks for a change directly (not through a command), first judge
its size. Small (docs, wording, config, a few-line fix): do it the `/quick` way, tests and a record included.
Bigger (a new feature, a behavior change testers would notice, anything in the database or the coach's voice):
say in one or two sentences that this is feature-sized and offer `/idea` to file it or `/spec` to shape it now.
If they still want it done directly, do it, but on a branch with a PR, and record it on an issue. Never refuse,
never lecture, never skip the tests.

**Naming issues and PRs.** When talking to Yanni, never use a bare number: always pair it with the
title or a few words saying what it is, e.g. "#21 (note a possible non-Eastern time zone)" or
"plan agreement (#5)". Nobody memorizes the numbers.

**Branches and PRs.** Feature work (anything from an issue, anything testers would notice, any
database change) goes through a PR so the tests run on the exact code before it reaches `main`,
which Railway deploys to the live line. Small things (docs, wording, eval checks, config cleanup,
one-line fixes) go straight to `main` once `npm run check` passes. A live breakage during the beta
can be fixed straight on `main`; open an issue afterward. No required approvals: the tests, the
`/review` session and Yanni's "merge" are the check.

## Commands
- `npm run check`: type check + tests. Must pass before any commit.
- `npm run build`: compile to `dist/`.
- `npm run db:generate`: after editing `src/db/schema.ts`, generate a migration in `drizzle/`. Commit both.
- `npm run dev`: run locally with `tsx` (needs a `.env`, see `.env.example`).
- `npm run eval -- <feature> --case <id>`: replays only the regression cases a change touches against the
  real coach, graded by a separate Claude (about $0.10–0.20 a case). Costs money: **$1 per issue on the branch, up to $3**, enforced
  (see `eval/README.md`). A full run (no `--case`, $1.30–1.90) only for changes that affect every
  conversation, and only with Yanni's OK. `npm run check` is free: tests never call Claude.

## Layout
- `src/index.ts`: startup. `src/wiring.ts`: builds every dependency (production and the eval share it).
  `src/app.ts`: Fastify app built from injected dependencies.
- `src/routes/`: HTTP routes (`/health`, `/webhooks/sendblue`).
- `src/pipeline/inbound.ts`: what happens to each inbound text (tester, commands, media, coach, send).
- `src/testers/`: testers, goals, "stop", dev-account "reset" and test-mode "jump" (#14). `src/coach/`: the coach's prompt,
  state and tools.
- `src/memory/`: coach memory (#8): the store (pages, facts, links, search), the 3 am pass that
  files each day, photo descriptions, and `npm run memory -- <last 4>` to read a tester's pages.
- `src/db/`: Drizzle schema, queries, migration runner.
- `src/sendblue/`, `src/claude/`, `src/media/`, `src/transcription/`: one small client each.
- `test/`: Vitest with an in-memory Postgres (PGlite) and fakes for every outside service.
- `eval/`: the judgment harness. `docs/coach-voice.md`: how ZOH talks (applies to every feature).
- `docs/reference.md`: infrastructure, decisions to carry forward and outside limits (read once). Where things
  stand is the issue board (`/status`).
- `docs/workflow.md`: the same flow written for people (setup, commands, habits). Keep it in sync when
  the commands change.

## Rules
- TypeScript strict. No `any` without a comment saying why.
- Every outside service sits behind an interface with a fake in `test/helpers.ts`. Tests never call
  Sendblue, Claude, the bucket or Speaches.
- Schema changes only through `src/db/schema.ts` + a generated migration. Never edit applied migrations.
- Never log or commit secrets, API keys or full phone numbers (use `maskNumber`).
- Webhook handler stays fast: store, answer 2xx, then do slow work in the `TaskQueue`.
- Replies only go to `ALLOWED_NUMBERS` until launch.
- A change that adds a service or Railway variable, reverses a recorded decision or hits a new outside limit updates
  `docs/reference.md` in the same commit or PR.
- Keep changes to the issue's spec and plan. Product questions go to Yanni; ideas beyond scope
  become `idea` issues, not code.

## Changing what ZOH says
- Two files are live prompts, so edit them with care: **`docs/coach-voice.md`** is read word for word by
  the coach after onboarding (minus `<!-- people only -->` parts, loaded at startup), and
  **`src/coach/prompt.ts`** holds the condensed voice and rules for onboarding plus the rules for every
  phase. Any edit to either changes the live coach: flag it for Yanni, keep the condensed voice in sync
  with the page, stay within the prompt budgets, and run the eval cases it touches. Mark sections for
  features that aren't built yet "Not active yet" (the coach is told not to act on them).
- Keep instructions lean: sharpen an existing line before adding one, fix the cause rather than the
  instance, keep examples in `eval/cases/` rather than the prompt, and stay within the prompt budgets.
- When the coach gets something wrong (eval, live or beta): save the exchange as a regression case in
  `eval/cases/<feature>/`, fix it at the source, and rerun the eval within the budget.

## Commits
End commit messages with the co-author and session lines the session asks for.
