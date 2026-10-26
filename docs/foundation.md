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

## Live (after secrets are added)
- [ ] `GET /health?deep=1` → database, bucket, transcription and Claude all `ok`.
- [ ] Text the line → typing bubble → Claude reply; both stored with timings.
- [ ] Photo → private copy in `zoh-media`; Claude responds to what's in it.
- [ ] Voice note → reaches the webhook, gets transcribed; Claude responds to what was said.
      (Open question this answers: does Sendblue deliver inbound voice notes?)
- [ ] Text from a number not on the allowlist → stored, no reply.
- [ ] Latency: median and slowest time from Sendblue receiving a text to our reply being sent.
