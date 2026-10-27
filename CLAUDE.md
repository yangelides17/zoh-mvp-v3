# ZOH MVP v3: working agreement for Claude and coding agents

ZOH is a text-based coach: testers text an iMessage number (Sendblue), Claude replies, and the
app nudges them through small daily steps. This repo is the server: one Node/TypeScript app on
Railway with Postgres, a private bucket and a Speaches (Whisper) transcription service.

## Commands
- `npm run check`: type check + tests. Must pass before any commit.
- `npm run build`: compile to `dist/`.
- `npm run db:generate`: after editing `src/db/schema.ts`, generate a migration in `drizzle/`. Commit both.
- `npm run dev`: run locally with `tsx` (needs a `.env`, see `.env.example`).

## Layout
- `src/index.ts`: startup and wiring. `src/app.ts`: Fastify app built from injected dependencies.
- `src/routes/`: HTTP routes (`/health`, `/webhooks/sendblue`).
- `src/pipeline/inbound.ts`: what happens to each inbound text (typing, media, Claude, send).
- `src/db/`: Drizzle schema, queries (`messages.ts`), migration runner.
- `src/sendblue/`, `src/claude/`, `src/media/`, `src/transcription/`: one small client each.
- `test/`: Vitest with an in-memory Postgres (PGlite) and fakes for every outside service.

## Specs and tickets
- `docs/runbook.md`: how tickets are picked, built, reviewed and merged by parallel agents.
- `docs/tickets/`: one file per ticket, with the prompt to start it.
- `docs/features/`: the feature pages (copies of Yanni's launch-plan pages; read, don't edit).

## Rules
- TypeScript strict. No `any` without a comment saying why.
- Every outside service sits behind an interface with a fake in `test/helpers.ts`. Tests never call
  Sendblue, Claude, the bucket or Speaches.
- Schema changes only through `src/db/schema.ts` + a generated migration. Never edit applied migrations.
- Never log or commit secrets, API keys or full phone numbers (use `maskNumber`).
- Webhook handler stays fast: store, answer 2xx, then do slow work in the `TaskQueue`.
- Replies only go to `ALLOWED_NUMBERS` until launch.
- Each ticket: its own branch, acceptance tests written first or alongside, `npm run check` green,
  then a PR. Railway deploys `main` only, so nothing reaches the live line until merged.
- Keep changes scoped to the ticket. Note follow-ups in the PR description rather than doing them.

## Commits
End commit messages with the co-author and session lines the session asks for.
