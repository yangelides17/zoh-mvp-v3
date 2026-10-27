# Where ZOH stands (October 27, 2026)

The handoff from the first two build days to the issue-based workflow in `CLAUDE.md`. Read this once
to get up to speed; GitHub Issues are the live record from here. Update the "Timeline" and "Known
issues" sections only when something big changes.

## Timeline (from Yanni's launch plan)
- **Build:** Mon Oct 26 to Wed Oct 28. Monday's goal (text the coach and get through onboarding)
  is done. Tuesday: plan agreement is done (#5); nudges (#6) are being built; photo and voice
  verification and coach memory haven't started. Wednesday: step log and next step, founder console, commands, metrics,
  test mode (memes only if there's time).
- **Internal testing:** Thu Oct 29 to Sat Oct 31, with go/no-go Saturday evening.
- **Beta:** recruiting texts early Sun Nov 1, about 10 iPhone testers, four weeks, review every Sunday.
  If the build slips, start as soon as it's built and tested (or Nov 8 if that's close).

## What's live
- **Texts in and out** through Sendblue (AI Agent plan, line +1 917 741 2162). Webhooks for received
  and outbound status point at the Railway app's `/webhooks/sendblue`. Replies about 2 to 4 seconds
  after a text arrives (measured live Oct 27, after the coach shipped: 1.8 to 4.3 s).
- **Photos** (iPhone HEIC included) copied to the private bucket and shown to Claude. **Voice notes**
  and recorded audio transcribed by Speaches and passed to Claude.
- **Testers, goals, "stop" and "reset"** (PR #1): a tester row on the first text, time zone from the
  area code (Eastern assumed; elsewhere noted as possibly outside Eastern, and the city is asked at plan agreement, #5), quiet hours 10 pm to 9 am. "stop" and
  similar opt-outs get "Thank you very much. Noted. We will stop sending you messages." with no
  founder notification yet. A stopped tester who texts again is un-stopped. "reset" from a dev
  number starts onboarding from scratch.
- **The coach and onboarding** (PR #3): Claude with tools that save name, goal and plan answers; the
  app (not the model) decides when onboarding is done, then ZOH carries straight on into the plan.
  The coach sees the whole conversation since the
  tester started (a stopgap until coach memory). Its voice: during onboarding, the condensed
  version in `src/coach/prompt.ts`; after onboarding, `docs/coach-voice.md` itself (issue #26). The spec is the closed GitHub issue "Onboarding by text".
- **Plan agreement** (PR #31, issue #5): ZOH asks what the plan still needs, shows it as a short
  list, and locks it only on a clear "I'm in". Locked plans are versioned in the `plans` table and
  flagged for founder review; goal switches need a reason. Live-checked by Yanni Oct 27.
- **The eval** (PR #2): `npm run eval -- onboarding`. Last full run before the rubric fix: 85 to 89%
  of checks passed. Not rerun since the rubric was corrected and softened.

## Infrastructure
- **Railway project `zoh-mvp-v3`** (region us-east4): `app` (deploys `main`; build runs type check,
  tests and build; migrations run at startup; health check `/health`, `?deep=1` pings Claude),
  `Postgres`, `Speaches` (Whisper, CPU), bucket `zoh-media`.
- **App variables** (names only): `DATABASE_URL`, `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_KEY_SECRET`,
  `SENDBLUE_NUMBER`, `SENDBLUE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `ALLOWED_NUMBERS` and
  `DEV_NUMBERS` (both: Yanni's and Stamati's numbers), `BUCKET_*`, `SPEACHES_URL`,
  `SPEACHES_API_KEY`, `LOG_LEVEL`. Model: `claude-sonnet-5-5`.
- **Eval key:** locally `ANTHROPIC_API_KEY` in `.env` (gitignored). In Claude Code cloud
  environments use `EVAL_ANTHROPIC_API_KEY` and run with `env -u ANTHROPIC_BASE_URL` (see
  `eval/README.md`). Use a separate key with a low spending limit.

## Decisions to carry forward (beyond `docs/coach-voice.md`)
- Starting goals: daily reading, exercise, nutrition (calorie or protein target), reflection and
  planning, deep work target, same bedtime every night (no wake-time goal), and a strict
  "something else" (only if close to a listed goal and ZOH can coach and check it).
- Onboarding asks name and goal together in the first text; no "why" question; no wake, sleep or
  pushiness questions; asks whether they already track the goal where it applies.
- How a tester proves each day's step is **not** fixed per goal: the plan suggests it, using what
  onboarding learned about how they already track it.
- Quiet hours: ZOH never starts a text between 10 pm and 9 am (changeable on request) but always
  replies. After 3 days of silence ZOH stops automatic texts and the founders decide.
- No founder notifications of any kind yet; flags (like declined goals) are only saved. How we get
  notified is decided with the founder console and commands.
- Plans start right away and get founder review in the background; if we'd change something, the
  coach texts "I'd suggest a couple of changes — yes or no?". Moving someone to a harder goal waits
  for our OK.
- Eval: $1 per branch, targeted runs (`--case`) by default, full runs only with Yanni's OK; graded against the checks Yanni approves in each spec, judged reasonably.

## Known issues and adjustments
Filed as GitHub issues (label `decide`, `bug` or `idea`):
- Optional onboarding questions often go unasked.
- Back-to-back texts each get their own reply, photo plus caption included (#16).
- A goal named in the first text skips the list (agent decision to confirm).

Not yet filed, worth knowing:
- **Audio is kept.** Voice notes are stored in the bucket; the launch plan says to keep the
  transcript and delete the audio. Handle with photo and voice verification.
- **Typing indicator** rarely shows because replies are fast.
- The coach voice page in Yanni's Business Ideas doc is an older copy; `docs/coach-voice.md` is the
  real one. The launch plan doc stays the source for timeline and strategy.
- Sendblue limits: replies within 24 hours of a tester's last text are unlimited; after that the
  coach can still text first, up to 200 contacts per line per day; 150 outbound texts in a row with
  no reply is the only other cap. Photo links expire after 30 days (we keep our own copy).
