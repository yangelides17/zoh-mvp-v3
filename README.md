# ZOH MVP v3

Text-based coach for the ZOH MVP beta. Testers text an iMessage number (Sendblue); the app stores
every message and replies with Claude. This is the bare-bones foundation: the coach, onboarding,
plans and memory come next.

## How a text flows

1. Sendblue POSTs to `/webhooks/sendblue` with the `sb-signing-secret` header.
2. The app checks the secret, skips retries (same message handle) and our own outgoing messages,
   stores the text, and answers Sendblue immediately.
3. In the background: typing bubble → photo copied to the private bucket / voice note transcribed
   by Speaches → Claude writes a reply from the recent conversation → reply sent and stored.
4. Each stage's time is saved in `messages.timings`. If Claude fails, the reply is "Got it".

Only numbers in `ALLOWED_NUMBERS` get replies; everyone else is stored without an answer.

## Stack

Node 22 · TypeScript · Fastify · Postgres with Drizzle · Zod · Claude SDK (`claude-sonnet-5-5`) ·
S3 client for the Railway bucket · Speaches (faster-whisper) · Vitest + PGlite.

## Development

```bash
npm install
npm run check        # type check + tests (no outside services needed)
npm run dev          # local server; needs .env (copy .env.example)
```

## Deploy (Railway)

Project `zoh-mvp-v3`: services **app** (this repo, `main`), **Postgres**, **Speaches**, and the
**zoh-media** bucket, all in US East (Virginia). `railway.json` makes each build run the type check
and tests, runs migrations before deploy, and gates on `GET /health`.

### Railway variables (app service)

Set by Claude (references, not secrets): `DATABASE_URL`, `BUCKET_*`, `SPEACHES_URL`,
`SPEACHES_API_KEY`, `SENDBLUE_NUMBER`, `ALLOWED_NUMBERS`.

Added by Yanni in the Railway dashboard (secrets):

| Variable | Where it comes from |
|---|---|
| `SENDBLUE_API_KEY_ID` | Sendblue dashboard → API keys (or `sendblue show-keys`) |
| `SENDBLUE_API_KEY_SECRET` | Same place |
| `SENDBLUE_WEBHOOK_SECRET` | A random string you generate; the same value goes in Sendblue's webhook settings |
| `ANTHROPIC_API_KEY` | Claude Console → API keys (set a monthly spend limit) |

`GET /health` lists any setting still missing (names only).
