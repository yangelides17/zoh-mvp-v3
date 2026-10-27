# How we build ZOH

A guide for anyone working on this repo. You describe what you want and approve it; Claude Code
does the building, testing, git and GitHub work. Agents follow the same rules from `CLAUDE.md`.

## One-time setup

1. Install [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (terminal or the desktop app;
   they read the same repo instructions, so you can switch between them).
2. Install and log in to the GitHub CLI: `brew install gh`, then `gh auth login`.
3. Clone the repo: `git clone https://github.com/yangelides17/zoh-mvp-v3.git`, then `npm install`.
4. Only if you'll run the eval: create `.env` in the repo with `ANTHROPIC_API_KEY=...` (use a separate key
   with a low spending limit; `.env` is never committed).

Start Claude Code in the repo folder. Everything below happens there.

## Where things live

| What | Where |
| --- | --- |
| Every feature, bug and idea | GitHub Issues: the spec in the issue, the plan and decisions as comments |
| Where each one stands | Its label (below), or ask `/status` |
| How ZOH talks | `docs/coach-voice.md` |
| Where the project stands, past decisions | `docs/project-state.md` |
| Rules for Claude and agents | `CLAUDE.md` |
| Timeline and strategy | Yanni's launch plan doc |

## The flow

Each feature goes through five steps. You're needed at the two approvals, the merge and the live check.

| Step | Command | Who | Result |
| --- | --- | --- | --- |
| 1. Spec | `/spec` | You and Claude | You shape the feature together; when you approve, it becomes an issue labeled `spec-approved`. |
| 2. Plan | `/plan` | Claude proposes, you approve | Claude reads the code and proposes how to build it; the approved plan is posted on the issue (`plan-approved`). |
| 3. Build | `/build` | Claude, on its own | Its own branch, tests first, a draft PR you can watch, the eval if ZOH's words change. Ends `in-review` with a summary. |
| 4. Review | `/review` | A fresh session, then you | Checks the PR against the spec and plan and tells you merge or fix. You say "merge"; it deploys in about 2 minutes (`live-check`). |
| 5. Live check | | You | Try the spec's Watch list on your phone. Good: `done`. Not good: Claude files a `bug`. |

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
| `/review` · `/review nudges` · `/review 12` | With nothing, lists PRs waiting for review and merged work waiting for your live check. |

Outside the commands, just talk normally: "file a bug: the recap was too long", "what did the build
decide about time zones?", "mark #12 done".

## Labels

`idea` → `spec-approved` → `plan-approved` → `building` → `in-review` → `live-check` → `done`,
plus `decide` (a question waiting for Yes / Later / No) and `bug`.

## Good habits

- **Approve carefully at steps 1 and 2.** That's where you control what gets built and how strict the
  tests are. Keep the "Done means" list to what you actually care about.
- **Review in a fresh session**, not the one that built it, so it checks the work with fresh eyes.
- **At most 2 or 3 builds at once.** While one builds, spec and plan the next in another session. Each
  build works in its own copy of the repo (a git worktree in `../zoh-worktrees/`), so parallel builds never
  trip over each other; Claude creates and removes these, you don't need to do anything.
- **Decisions are written down.** If a build makes a call on its own, it posts a `Decision:` comment
  on the issue; anything that changes what testers experience waits for you.
- **Eval budget: $2 per feature**, enforced by the eval itself. Live testing and the beta catch the rest.

## Quick fixes and changes outside the flow

- **Quick fix:** `/quick <what to change>` for small things (docs, wording, config, a few-line fix). Claude checks
  it really is small, makes it on `main`, runs the tests, pushes, and records it on an issue. Bigger than that, it
  suggests `/idea` or `/spec` instead.
- **Claude nudges toward the flow:** ask for something feature-sized directly and Claude will say so in a sentence and
  offer `/idea` or `/spec`. If you insist, it does it anyway, on a branch with a PR and a record.
- **Just talking to Claude works too:** any session follows `CLAUDE.md`, so it runs the tests before committing and
  never commits secrets, even outside the commands.
- **If someone goes rogue** (edits by hand, or skips the commands), three things still protect the live line:
  1. Railway runs the type check and tests on every push; if they fail, nothing deploys and the old version keeps
     running.
  2. Builds in progress pick up whatever landed on `main` when they rebase, and the PR's tests run on the combined code.
  3. `/status` lists commits from the last week that didn't come through an issue or PR, flags risky ones, and
     offers to record them.
- **Never outside a PR:** database changes (`src/db/schema.ts`, `drizzle/`). A bad migration runs at startup and can
  take the app down.
- **Something broke live?** Tell Claude "roll back the last deploy" (Railway keeps every deploy), then fix it properly.

## Branches and PRs

Claude handles all of it. Feature work goes through a PR so the tests run on the exact code before it
reaches `main`, which deploys straight to the live line. Small things (docs, wording, config, one-line
fixes) go straight to `main` once the tests pass. There are no required approvals: the tests, the
review session and your "merge" are the check.

## A feature, start to finish (example)

1. `/status` shows "Plan agreement" as an idea. `/spec plan agreement`: a 15-minute conversation, you
   trim one check that's too strict, approve, and it's issue #12.
2. `/plan`: Claude proposes a plan (a new tool for the coach, one migration, six tests, a $1.50 eval).
   You ask one question, then approve.
3. `/build`: you walk away. An hour later: "Ready: all tests pass, 88% on the judgment checks, $1.62
   spent, one decision noted."
4. New session, `/review`: "Merge; worth trying 'yeah sure but later' on your phone." You say merge.
5. On your phone: text "reset", go through onboarding to a plan. The plan is a bit long: Claude
   files a bug. Otherwise good: `done`.
