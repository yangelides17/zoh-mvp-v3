# T1 · Testers, goals, stop and reset

**Feature:** 4 (onboarding) groundwork, plus the bits of 12 (commands) needed today.
**Starts after:** nothing. **Runs alongside:** T3. **Blocks:** T2.

## Prompt (paste this into a new Claude Code session)

> You're building ticket T1 for ZOH. Read `CLAUDE.md`, `docs/runbook.md`, this ticket
> (`docs/tickets/T1-testers-stop-reset.md`) and `docs/features/04-onboarding.md` (sections 4, 5, 6
> and 11) first. Work on branch `ticket/T1-testers-stop-reset`. Write the tests in "Done means"
> first or alongside the code, keep to the files this ticket owns, get `npm run check` green, then
> open a PR using the repo's template. If anything here conflicts with the feature page or is
> missing a product decision, stop and ask me instead of choosing.

## Why

Today the app only stores messages. Onboarding needs to know who each tester is, what they've told
ZOH so far and whether they've opted out, and Yanni and Stamati need a way to start over while
testing. This ticket adds that state and the two commands that must not depend on the model:
"stop" and "reset". It does **not** change what ZOH says otherwise (that's T2).

## Build

1. **Schema** (one migration, `npm run db:generate`). Everything onboarding needs today, so T2 can
   build without its own migration:
   - `testers`: phone (unique, E.164), name (nullable), phase (`onboarding`, `planning`; more come
     later), goal slug (nullable), time zone (IANA), time zone status (`assumed_eastern`,
     `needs_city`, `confirmed`), quiet hours start/end (default `22:00`/`09:00`), pushiness
     (default `pushy`), style notes (text), is test user, consent at (first text), stopped at
     (nullable), context started at (see reset), created/updated at.
   - `goals`: the starting list as seed data in the migration: slug, title, short description,
     sort order, and the plan questions that apply (jsonb list of `what`, `where`, `when`,
     `how_long`, `tracks_with`; mark which are required). Rows: `reading` Daily reading,
     `exercise` Daily exercise, `nutrition` Daily nutrition, `reflection` Daily reflection and
     planning, `deep_work` Daily deep work target, `bedtime` Same bedtime every night,
     `something_else` Something else. Use the page's "Starting goals" table; `tracks_with` applies
     to exercise, nutrition, bedtime and deep work only.
   - `plan_inputs`: one row per tester and goal: what, where, when, how long, tracks with (all
     nullable text), extra notes (jsonb), updated at.
   - `flags`: tester, kind (e.g. `off_list_goal`), detail, created at. Saved only; nobody is
     notified (decided Oct 26).
2. **Tester lookup.** `src/testers/` with small functions: get or create a tester for an allowed
   inbound number (sets consent at), read their state, update fields. Time zone on creation from the
   area code: Eastern area codes → `America/New_York`, `assumed_eastern`; any other US area code →
   best-guess zone with status `needs_city` (T2's coach asks the city). A static area-code table
   is fine.
3. **Dev accounts.** New setting `DEV_NUMBERS` (comma list, same parsing as `ALLOWED_NUMBERS`;
   add to `.env.example` and config). Those testers get `is test user = true`.
4. **Stop and other opt-outs** (deterministic, before Claude): if the whole text, trimmed,
   case-insensitive and ignoring punctuation, is one of `stop`, `stop all`, `unsubscribe`,
   `cancel`, `end`, `quit`, `opt out`, `optout`: set stopped at, reply exactly
   `Thank you very much. Noted. We will stop sending you messages.`, don't call Claude, no
   notification to anyone. Export the same "opt out" function so T2's coach can call it for
   looser phrasings ("leave me alone"). A stopped tester who texts again (anything that isn't an
   opt-out) is un-stopped and gets a normal reply, per the page ("say nothing more until they text
   again"); nothing unprompted ever goes to a stopped tester (enforced later by the scheduler).
5. **Reset** (dev accounts only): text exactly `reset` (any case). Clears the tester's name, goal,
   plan inputs, style notes, quiet hours and time zone back to defaults, phase back to
   `onboarding`, un-stops them, and sets context started at to this message's time. Messages and
   flags stay in the database. Then the message continues through the normal reply path as if it
   were a brand-new tester's first text (so after T2, ZOH sends its first onboarding text).
   From any other number, `reset` is an ordinary message.
6. **Conversation window.** `recentConversation` (or a sibling) takes a "since" time so the coach
   never sees messages from before the tester's context started at. Keep the current limit
   behavior otherwise; T2 decides how much history onboarding gets.

## Owns

`src/db/schema.ts` + the new migration, `src/testers/**` (new), `src/db/messages.ts` (since
filter), `src/config.ts` + `.env.example` (DEV_NUMBERS), the commands step in
`src/pipeline/inbound.ts` (before the Claude call; leave the reply step alone), wiring in
`src/index.ts`, `test/helpers.ts` (truncate new tables, dev number), new test files. T3 moves
startup wiring into `src/wiring.ts`; whichever merges second rebases.

## Not in this ticket

What ZOH says (prompt, tools, onboarding flow: T2), nudges, founder notifications, pause and the
other commands (feature 12), the console.

## Done means (automated, with fakes)

- [ ] A first text from an allowed number creates a tester with consent time, Eastern time zone for
      an Eastern area code, `needs_city` for a non-Eastern one, and 10 pm to 9 am quiet hours.
- [ ] Numbers outside `ALLOWED_NUMBERS` still get no reply and no tester row.
- [ ] Each opt-out word, in any case and with punctuation ("STOP!", "Unsubscribe."), stops the
      tester, sends exactly the confirmation text once, and never calls Claude.
- [ ] "please don't stop texting me" and "stop by the gym later" are not opt-outs.
- [ ] A stopped tester who texts "hey" is un-stopped and gets a normal reply.
- [ ] "reset" from a dev number clears name, goal, plan inputs and settings, keeps old messages in
      the database, and the next Claude call sees only messages from the reset onward.
- [ ] "reset" from a non-dev allowed number is passed to Claude like any text and changes nothing.
- [ ] The seven goals are in the database after migrating, in order, with their plan questions.
- [ ] `npm run check` green; migration generated, not hand-written.

## Hand-off

PR with the template. Under "How to check it live" include: text "stop" and see the confirmation;
text "hey" and get a normal reply; text "reset" from Yanni's phone and see a fresh start. Note in
the PR that Railway needs `DEV_NUMBERS=+19085782266,+19084721920` set before merging.
