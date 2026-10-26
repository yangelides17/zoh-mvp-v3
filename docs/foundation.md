# Foundation: acceptance tests

Bare-bones scope agreed October 26, 2026. No coach, onboarding, goals or memory design yet.

## Automated (run on every build and in CI)
- [x] Type check, tests and build pass; migrations match the schema.
- [x] Wrong or missing webhook secret → 401; no secret configured → 503.
- [x] A retried delivery is processed once.
- [x] Our own outgoing status events update the stored reply and never trigger a reply.
- [x] Numbers outside `ALLOWED_NUMBERS` are stored without a reply.
- [x] Typing indicator goes out before the reply.
- [x] Claude failure → "Got it" fallback, error recorded.
- [x] Failed send is recorded and the typing bubble is stopped.
- [x] Photo copied to the bucket and shown to Claude; voice note transcribed and passed to Claude.
- [x] Health reports database, bucket, transcription and Claude status.

## Live (passed October 26, 2026)
- [x] `GET /health?deep=1` → database, bucket, transcription and Claude all `ok`.
- [x] Text the line → Claude reply; both stored with timings (~2–4 s from Sendblue receiving
      the text to our reply being sent; Claude ~1.3–3 s of that).
- [x] Follow-up remembers the earlier conversation.
- [x] Photo → private copy in `zoh-media`; Claude responds to what's in it (after the HEIC/format fix).
- [x] Messages voice note → reaches the webhook, transcribed by Speaches; Claude responds to it.
      (Answers the open question: Sendblue does deliver inbound voice notes.)
- [x] Recorded audio file (Voice Memos) → transcribed the same way.
- [ ] Text from a number not on the allowlist → stored, no reply (covered by automated tests).

## Findings during live testing
- Typing indicator is accepted by Sendblue but rarely visible: replies arrive ~1.5 s after it.
  Expect it to show once coach replies take longer.
- Production database was missing its table after Postgres was redeployed; migrations now also
  run at app startup.
- Photos were stored but not shown to Claude (format detection by label; HEIC). Fixed by
  detecting format from bytes, converting HEIC, and sending base64.

