# How we build ZOH

A guide for anyone working on this repo. You describe what you want and approve it; Claude Code
does the building, testing, git and GitHub work. Agents follow the same rules from `CLAUDE.md`.

## One-time setup

1. Install [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (terminal or the desktop app;
   they read the same repo instructions, so you can switch between them).
2. Install and log in to the GitHub CLI: `brew install gh`, then `gh auth login`.
3. Clone the repo: `git clone https://github.com/yangelides17/zoh-mvp-v3.git`, then `git checkout dev` and
   `npm install`. Your main folder stays on `dev`, where all work starts.
4. Only if you'll run the eval: create `.env` in the repo with `ANTHROPIC_API_KEY=...` (use a separate key
   with a low spending limit; `.env` is never committed).
5. So builds don't ask before making worktrees, create `.claude/settings.local.json` yourself (Claude can't):
   `{"permissions": {"additionalDirectories": ["<full path to the zoh-worktrees folder next to the repo>"]}}`.

Start Claude Code in the repo folder. Everything below happens there.

## Where things live

| What | Where |
| --- | --- |
| Every feature, bug and idea | GitHub Issues: the spec in the issue, the plan and decisions as comments |
| Where each one stands | Its label (below), or ask `/status` |
| How ZOH talks | `docs/coach-voice.md` |
| Infrastructure, past decisions, outside limits | `docs/reference.md` |
| Rules for Claude and agents | `CLAUDE.md` |
| What's on staging but not released yet | `/status` |
| Timeline and strategy | Yanni's launch plan doc |

## The flow

Each feature goes through four steps, a live check on staging, and later a release. You're needed at the two
approvals, the merge and "ship".

**Two environments, one ZOH number.** `dev` deploys to **staging**, `main` to **production** (the testers' line).
Features merge into `dev`; a **release** moves everything on `dev` to `main`. Both apps receive every text, and each
keeps only the numbers it owns: testers always go to production, and a dev number goes wherever it last said. Text
`env staging` to try staging, `env production` to go back, and `env` to ask which one you're on (it answers with its
version). Each app keeps its own texts, memory and console; the staging console says STAGING at the top.

| Step | Command | Who | Result |
| --- | --- | --- | --- |
| 1. Spec | `/spec` | You and Claude | Claude first says what it thinks you mean and sketches it; once you agree, you shape the rest together, including "Done means": it drafts the core scenarios and asks what would make you say it's broken and what case is missing. When you approve, it's an issue labeled `spec-approved`. |
| 2. Plan | `/plan` | Claude proposes, you approve | Claude reads the code on `dev` and gives you a two-minute briefing: how it works in plain words, where it could break (including what changes in existing code), where it disagrees or is least sure, and questions for you. A technical appendix for the build sits below it. The approved plan is posted on the issue (`plan-approved`). |
| 3. Build | `/build` | Claude, on its own | Its own branch, tests first, a draft PR you can watch, the eval if ZOH's words change. Stops to ask only if the spec, the design or something hard to undo is in question. Ends `in-review` with one line. |
| 4. Review | `/review` | A fresh session, then you | Checks the PR against the spec and plan, that the design held up and the code stays lean, and that the tests fail when the feature is taken out. PRs touching sending, the database, the pipeline or memory also get a quick extra check for silent failures (a trial, see Good habits). It tells you merge or fix, with what differed from the plan, an eval summary (detail only on what fell short), what ZOH will say differently, and the live checks ranked by importance. You say "merge"; it lands on `dev`, staging redeploys in about 2 minutes and the issue is `done`. Claude cleans up the branch and worktrees, updates your main folder and leaves the ranked live checks as a "Live checks" comment (checkboxes) on the issue. |
| Live check | | You, on staging | Text `env staging`, then try the issue's "Live checks" and tick them. Not good: Claude files a `bug`. Best done before the next release. |
| Release | `/release` | Claude, then you | Collects everything on `dev` since the last release, writes plain-language notes, opens the `dev` → `main` PR and lists anything "Worth a look" (important unticked live checks, concerns from the PRs). Suggestions only. You say "ship"; it merges, tags the version (v0.3, v0.4…), production deploys and Claude checks it's healthy. |

Each command checks that the step before it is done, and ends by naming the next one, so the order
takes care of itself.

## The commands

You never need an issue number. Every command takes a number, a description, or nothing:

| You type | What happens |
| --- | --- |
| `/status` | The whole board, grouped by stage, ending with what's waiting on you. |
| `/status nudges` · `/status what's in review` | Focused on one feature (spec, plan, decisions) or one stage. |
| `/spec` | Lists open ideas, bugs and decisions, recommends one, and asks you to pick or describe something new. |
| `/spec plan agreement` · `/spec 12` | Starts on that feature. A brand-new idea becomes a new issue when you approve its spec; if an issue already covers it, that one is reused. |
| `/idea <a sentence or two>` | Files a new idea (or `bug`, if something's broken) as an issue to spec later, without speccing it now. |
| `/plan` · `/plan the nudges one` · `/plan 12` | With nothing, lists approved specs waiting for a plan. |
| `/build` · `/build plan agreement` · `/build 12` | With nothing, lists approved plans waiting to be built. |
| `/review` · `/review nudges` · `/review 12` | With nothing, lists PRs waiting for review. |
| `/release` | Releases what's on staging to production, after your "ship". |

**Several issues at once (optional).** `/spec 41 42 48`, `/plan the small nudge bugs` or `/build 41 42 48` take
a group: related or dependent issues, or a handful of small fixes not worth doing one by one. Each issue keeps its own
spec; the group gets one plan (on the first issue) and usually one PR that closes them all, so it's one review, one
deploy and one round of phone checks. When the plan splits a group into separate branches, `/build` can build up to
3 of them at the same time. Claude decides when either is safe and worth it, and tells you when it would rather split
an issue out (big, a database change, shared prompt files, an open question) or build one at a time.

**Session names.** Typing `/spec`, `/plan`, `/build` or `/review` names the Claude Code session after exactly what
you typed (`/build 80 90 120` → "build 80 90 120"), so each terminal is easy to tell apart in the resume picker and
the terminal title. A hook does it (`.claude/hooks/session-title.mjs`, set up in `.claude/settings.json`); other
prompts leave the name alone.

Outside the commands, just talk normally: "file a bug: the recap was too long", "what did the build
decide about time zones?", "mark #12 done".

## Labels

`idea` → `spec-approved` → `plan-approved` → `building` → `in-review` → `done` (on merge into `dev`),
plus `decide` (a question waiting for Yes / Later / No) and `bug`.

## Good habits

- **Approve carefully at steps 1 and 2.** That's where you control what gets built and how strict the
  tests are. Keep the "Done means" list to core functionality you actually care about.
- **Read the plan briefing to understand, not just approve.** If something in "How it works" isn't clear, ask
  Claude to walk you through it; you'll direct the next build better. Claude says so when it thinks the spec or
  plan is wrong, even after you've approved it. For big, risky features it can offer a separate critic first.
- **Review in a fresh session**, not the one that built it, so it checks the work with fresh eyes.
- **Extra review on risky PRs is a trial.** PRs touching anything that texts testers or decides who gets a text,
  the database, the pipeline or memory get a background agent hunting for silent failures (a tester gets no reply and
  nothing is logged), and a second opinion before any "fix first". Its result is a line in the review. After five
  such PRs, `/review` shows what it found and you decide whether to keep it. When a review finds a real problem, it
  also suggests a `CLAUDE.md` rule that would have caught it; you decide.
- **Bugs start with a failing test.** `/build` and `/quick` first write a test that shows the bug, see it fail, then fix.
- **At most 2 or 3 builds at once.** While one builds, spec and plan the next in another session. Each
  build works in its own copy of the repo (a git worktree in `../zoh-worktrees/`), so parallel builds never
  trip over each other; Claude creates and removes these, you don't need to do anything.
- **Overlapping work is checked at every step.** `/spec` flags a feature in progress that changes the same moment
  for testers, `/plan` and `/build` name open work that touches the same files (a database or coach-prompt overlap
  gets a decision on which lands first), `/build` also checks that nothing merged since the plan changes its
  approach, and `/review` only merges a branch that's up to date with `dev`, then tells
  other open PRs touching the same files to rebase.
- **Decisions are written down.** If a build makes a call on its own, it posts a `Decision:` comment
  on the issue; anything that changes what testers experience waits for you.
- **Eval budget: $0.50 per issue on the branch, up to $1.50 for a group**, enforced by the eval itself. Each change
  runs only the cases it touches, graded by Haiku while the build iterates (about $0.015 a short case) and once by the
  coach's model at the end (about $0.04), so the results you read are full quality. A full run only for changes to
  every conversation, with your OK. The tests in `npm run check` are free. Live testing and the beta catch the rest.

## Quick fixes and changes outside the flow

- **Quick fix:** `/quick <what to change>` for small things (docs, wording, config, a few-line fix). Claude checks
  it really is small, then **always asks you first: dev (staging) or straight to production as a hotfix?** It makes
  it there, runs the tests, pushes, and records it on an issue. Bigger than that, it suggests `/idea` or `/spec` instead.
- **Hotfix** (something broken for testers right now): `/quick`, pick production. It branches off `main`, opens a PR,
  ships it after your OK, tags a patch version and merges `main` back into `dev` so the fix isn't lost.
- **Claude nudges toward the flow:** ask for something feature-sized directly and Claude will say so in a sentence and
  offer `/idea` or `/spec`. If you insist, it does it anyway, on a branch with a PR and a record.
- **Just talking to Claude works too:** any session follows `CLAUDE.md`, so it runs the tests before committing and
  never commits secrets, even outside the commands.
- **If someone goes rogue** (edits by hand, or skips the commands), four things still protect the testers' line:
  1. Railway runs the type check and tests on every push; if they fail, nothing deploys and the old version keeps
     running.
  2. Builds in progress pick up whatever landed on `dev` when they rebase, and the PR's tests run on the combined code.
  3. Nothing reaches testers without a release (or a hotfix) and your "ship", and database migrations run on
     staging first.
  4. `/status` lists commits from the last week that didn't come through an issue or PR, flags risky ones, and
     offers to record them.
- **Guard hooks** (`.claude/hooks/guard.mjs`) stop three costly mistakes in any session, before they happen: editing a
  migration that's already applied, pushing straight to `main`, and switching branches in your main folder.
- **Never outside a PR:** database changes (`src/db/schema.ts`, `drizzle/`). A bad migration runs at startup and can
  take the app down.
- **Something broke live?** Tell Claude "roll back the last deploy" (Railway keeps every deploy), then fix it properly.

## Branches and PRs

Claude handles all of it.

| Branch | Deploys to | Gets there by |
| --- | --- | --- |
| `feature/<n>-<slug>` | nothing (tests only) | `/build`, from `dev` |
| `dev` (the default branch) | staging | `/review` merging a feature PR; `/quick` small changes |
| `main` | production (testers) | `/release` after your "ship"; a hotfix |

Feature work goes through a PR into `dev` so the tests run on the exact code first. Small things (docs, wording,
config, one-line fixes) go straight to `dev` once the tests pass. Each release (and hotfix) is tagged (`v0.3.0`) and its
notes are published on the repo's **Releases** page, and in the release PR. There are no required approvals: the tests, the review session and your "merge" and "ship" are the check.

## A feature, start to finish (example)

1. `/status` shows "Plan agreement" as an idea. `/spec plan agreement`: a 15-minute conversation, you
   trim one check that's too strict, approve, and it's issue #12.
2. `/plan`: a two-minute briefing. It explains how the agreement step fits between the plan and day 1, flags that
   changing the plan tool could affect the nudges, and says it's least sure how "yeah sure but later" should count.
   You answer that, then approve.
3. `/build`: you walk away. An hour later: "Ready for review: `/review 12` in a fresh session."
4. New session, `/review`: "Merge. As planned; all 6 Must tests pass; eval 88%, one check below target (ZOH
   repeats the plan back); most important live check: 'yeah sure but later'." You say merge: it's on staging and `done`.
5. On your phone: text `env staging`, then "reset", and go through onboarding to a plan. The plan is a bit
   long: Claude files a bug. Otherwise good: tick the live checks. To see days of nudges in a minute, a dev
   number texts `jump next`, `jump 3h`, `jump 2d` or `jump 7:30am` (the clock moves forward, a ⏩ line says
   what happened); "reset" returns to real time.
6. A few features later, `/release`: notes for v0.4.0, plus "Worth a look: #12's 'yeah sure' check isn't ticked".
   You try it, say "ship", and testers have it a couple of minutes later.
