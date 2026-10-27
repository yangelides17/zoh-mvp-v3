# ZOH MVP v3

Text-based coach for the ZOH beta. Testers text an iMessage number (Sendblue); ZOH, a Claude-powered
coach, onboards them and helps them start one small daily habit and stick with it.

- **How we work (start here):** `docs/workflow.md`: setup, the flow and the commands.
- **Rules for Claude and agents:** `CLAUDE.md`.
- **Where things stand:** `docs/project-state.md`.
- **How ZOH talks:** `docs/coach-voice.md`.

## How a text flows

1. Sendblue POSTs to `/webhooks/sendblue`; the app checks the secret, skips retries and our own
   outgoing messages, stores the text and answers right away.
2. In the background: find or create the tester, handle "stop" and dev-account "reset", show the
   typing bubble, copy photos to the private bucket and transcribe voice notes (Speaches).
3. The coach (Claude with tools) replies from the conversation and the tester's saved state, saving
   what it learns; the reply is sent and stored with timings. If Claude fails, the reply is "Got it".

Only numbers in `ALLOWED_NUMBERS` get replies until launch.

## Stack

Node 22 · TypeScript · Fastify · Postgres with Drizzle · Zod · Claude SDK (`claude-sonnet-5-5`) ·
S3 client for the Railway bucket · Speaches (faster-whisper) · Vitest + PGlite.

## Development

```bash
npm install
npm run check                    # type check + tests (no outside services needed)
npm run dev                      # local server; needs .env (copy .env.example)
npm run eval -- onboarding       # judgment eval; needs ANTHROPIC_API_KEY in .env, $2 budget per branch
```

## Deploy (Railway)

Project `zoh-mvp-v3`: **app** (this repo, deploys `main`), **Postgres**, **Speaches** and the
**zoh-media** bucket, in US East. Each build runs the type check and tests; migrations run at
startup; deploys gate on `GET /health` (`?deep=1` also pings Claude, and it lists missing settings
by name).

App variables: `DATABASE_URL`, `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_KEY_SECRET`, `SENDBLUE_NUMBER`,
`SENDBLUE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `ALLOWED_NUMBERS`, `DEV_NUMBERS`, `BUCKET_*`,
`SPEACHES_URL`, `SPEACHES_API_KEY`, `LOG_LEVEL`. Real phone numbers and secrets live only there,
never in the repo.
