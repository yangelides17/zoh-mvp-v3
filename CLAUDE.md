# ZOH MVP v3: working agreement for Claude and coding agents

ZOH is a text-based coach: testers text an iMessage number (Sendblue), Claude replies, and the
app nudges them through small daily steps. This repo is the server: one Node/TypeScript app on
Railway with Postgres, a private bucket and a Speaches (Whisper) transcription service.

Yanni and his brother run Claude Code from the terminal. Claude does all the git and GitHub work;
they approve specs and plans, say "merge", and test on their phones.

## How we build
GitHub Issues hold every feature, bug and idea. A label says where it stands:
`idea` → `spec-approved` → `plan-approved` → `building` → `in-review` → `live-check` → `done`
(plus `decide` for Yes / Later / No questions and `bug`).

One feature, one flow, using the commands in `.claude/commands/`:
1. `/spec <idea>`: shape it with Yanni; the approved spec becomes the issue. **Gate 1.**
2. `/plan <n>`: read the code, propose the build; the approved plan is posted on the issue. **Gate 2.**
3. `/build <n>`: build on `feature/<n>-<slug>`, tests first, draft PR early, eval if ZOH's words change.
4. `/review <n>`: a fresh session checks the PR against the spec and plan; merges when Yanni says so.
5. Live check on Yanni's phone; problems become `bug` issues. `/status` shows the board anytime.

Run at most 2 or 3 builds at once, each in its own git worktree under `../zoh-worktrees/` (never switch
branches in the main folder; `/build` and `/review` set this up and `/review` cleans up after merging). The issue is the record: spec in the body, plan and `Decision:`
notes as comments, PR linked with `Closes #n`. Don't copy specs into the repo.

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
- `npm run eval -- <feature> [--persona <name>]`: simulated testers against the real coach, graded by
  a separate Claude. Costs money: **$2 per branch**, enforced (see `eval/README.md`).

## Layout
- `src/index.ts`: startup. `src/wiring.ts`: builds every dependency (production and the eval share it).
  `src/app.ts`: Fastify app built from injected dependencies.
- `src/routes/`: HTTP routes (`/health`, `/webhooks/sendblue`).
- `src/pipeline/inbound.ts`: what happens to each inbound text (tester, commands, media, coach, send).
- `src/testers/`: testers, goals, "stop" and dev-account "reset". `src/coach/`: the coach's prompt,
  state and tools.
- `src/db/`: Drizzle schema, queries, migration runner.
- `src/sendblue/`, `src/claude/`, `src/media/`, `src/transcription/`: one small client each.
- `test/`: Vitest with an in-memory Postgres (PGlite) and fakes for every outside service.
- `eval/`: the judgment harness. `docs/coach-voice.md`: how ZOH talks (applies to every feature).
- `docs/project-state.md`: where things stand, decisions to carry forward and known issues (read once).
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
- Keep changes to the issue's spec and plan. Product questions go to Yanni; ideas beyond scope
  become `idea` issues, not code.

## Changing what ZOH says
- `docs/coach-voice.md` is the source for ZOH's voice; `src/coach/prompt.ts` is its condensed form.
  Change both together, and flag voice changes that affect every feature for Yanni.
- Keep instructions lean: sharpen an existing line before adding one, fix the cause rather than the
  instance, keep examples in `eval/cases/` rather than the prompt, and stay within the prompt budgets.
- When the coach gets something wrong (eval, live or beta): save the exchange as a regression case in
  `eval/cases/<feature>/`, fix it at the source, and rerun the eval within the budget.

## Commits
End commit messages with the co-author and session lines the session asks for.
