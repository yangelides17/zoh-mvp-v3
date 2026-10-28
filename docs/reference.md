# ZOH reference

Facts and decisions that aren't on any GitHub issue. Where things stand (what's live, what's being
built, known bugs) is the issue board: `/status`. Update this page in the same change that alters
anything here (a new service or variable, a reversed decision, a new outside limit).

## Infrastructure
- **Railway project `zoh-mvp-v3`** (region us-east4): `app` (deploys `main`; build runs type check,
  tests and build; migrations run at startup; health check `/health`, `?deep=1` pings Claude),
  `Postgres`, `Speaches` (Whisper, CPU), bucket `zoh-media`.
- **App variables** (names only): `DATABASE_URL`, `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_KEY_SECRET`,
  `SENDBLUE_NUMBER`, `SENDBLUE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `ALLOWED_NUMBERS` and
  `DEV_NUMBERS` (both: Yanni's and Stamati's numbers), `BUCKET_*`, `SPEACHES_URL`,
  `SPEACHES_API_KEY`, `LOG_LEVEL`, `CONSOLE_PASSWORD` (the founders' shared console password),
  `CONSOLE_SESSION_SECRET` (signs console cookies; a long random string), optional `CONSOLE_NAMES`
  (default `Yanni,Stamati`). Model: `claude-sonnet-5-5`.
- **Founder console:** https://app-production-354a.up.railway.app/console (same app, no separate
  service). One shared password, a 30-day cookie, your name picked once per device; "Add to Home
  Screen" gives it the ZOH Console name and icon.
- **Sendblue:** AI Agent plan, line +1 917 741 2162. Webhooks for received and outbound status point
  at the app's `/webhooks/sendblue`.
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
- Nothing is texted or emailed to the founders: flags (declined goals, goal switches, proof gaming,
  went quiet) and each locked plan version to review are saved as console alerts, one per event
  (`raiseAlert`), which the founder console (#10) shows.
- Everything for the founders lives in the console, inside the same app: server-rendered pages,
  masked numbers, proofs streamed from the bucket behind the login. Each alert gets a one-line why
  from a low-effort Claude call (alerts under 2 days old); seeing a plan-to-review alert clears that
  version's needs review. Weekly summaries are written Sunday from 8 am Eastern, once per tester
  with a locked plan. The texting coach only ever sees approved or changed suggestions
  (`suggestionsForCoach`); a founder's own suggestion is saved as approved by them.
- Goals (#9): `tester_goals` holds every goal with its role (focus, maintenance, dropped);
  `testers.goal_slug` stays the focus. Each goal has its own streak from its own step days: a plan
  version's `change_kind` says deepen or other (streak goes on) or upgrade (a new streak starts).
- Plans start right away and get founder review in the background; if we'd change something, the
  coach texts "I'd suggest a couple of changes — yes or no?". Moving someone to a harder goal waits
  for our OK.
- Eval: $1 per branch, targeted runs (`--case`) by default, full runs only with Yanni's OK; graded
  against the checks Yanni approves in each spec, judged reasonably.
- Coach memory (#8) is a small wiki per tester in Postgres (no outside search service): pages of
  facts that each cite the text they came from, written by one pass per tester at 3 am their time
  (first run reads back up to 14 days). Photos get a one-line description as they arrive. Search
  is Postgres full-text. Learned preferences need 3 observations on 3 different days, checked in
  code. `npm run memory -- <last 4 digits>` prints a tester's pages (needs `DATABASE_URL`).
  Once a plan is locked, replies and nudges read a cached memory block plus only today's and
  yesterday's texts (at least 30), instead of the last 200; up to 5 lookups a reply (2 searches).
  Each reply's tokens are logged in the message's `timings`.
- Photo and voice verification (#7): the coach judges proof in its reply (no second Claude call)
  and saves a verdict and a line on what it saw on the day. No proof, no done. Photos stay in the
  bucket; voice-note audio is deleted 30 days after it arrived (hourly job), transcripts stay.
  Proof-gaming flags are saved only.
- The launch plan doc is the source for timeline and strategy. The coach voice page in Yanni's
  Business Ideas doc is an older copy; `docs/coach-voice.md` is the real one.

## Outside limits
- **Sendblue:** replies within 24 hours of a tester's last text are unlimited; after that the coach
  can still text first, up to 200 contacts per line per day; 150 outbound texts in a row with no
  reply is the only other cap. Photo links expire after 30 days (we keep our own copy).
- **Reply speed:** about 2 to 4 seconds after a text arrives (measured live Oct 27: 1.8 to 4.3 s).
