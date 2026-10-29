---
description: Build an issue from its approved plan, test it, and open a PR
argument-hint: [issue number(s) or description; leave empty to pick]
---

Build issue **#$ARGUMENTS** on your own, following its approved plan.

**Which issue?** `$ARGUMENTS` may be an issue number, a description ("the nudges one") or empty. If it isn't a
number, run `gh issue list --state open --label plan-approved` and match the description to an issue; if it's empty or
matches more than one, show those issues as a short numbered list and ask Yanni which one. Call the chosen
number N and use it everywhere below in place of `$ARGUMENTS`. If nothing has the `plan-approved` label, say what building
needs first and stop.

**A group (when the plan says so).** If `$ARGUMENTS` names several issues, or the plan is a group plan (the lead issue
has it; the others point to it), build them as the plan says. On one branch: name it
`feature/<a>-<b>-<c>-<short-slug>` (the eval budget counts the numbers: $1 each, up to $3), build in the plan's order
with at least one commit per issue (message ends `(#n)`), and put a `Closes #n` line for each in the PR. Labels move
for every issue together. If one issue gets stuck or turns out bigger than planned, take it out rather than hold up
the rest: revert or leave out its commits, drop its `Closes` line, move it back to `plan-approved` and post a
`Decision:` comment saying why. Tell Yanni.

**Parallel build agents (optional).** When the plan has separate branches, you may build them at the same time with
one background agent per branch, at most 3, each following this command in its own worktree. It's your call in the
moment: do it only when it's clearly safe and saves real time, and if you have concerns, say so and build them one
after another instead. Never in parallel:
- two branches that change the database (`src/db/schema.ts`, `drizzle/`): their migrations would collide;
- two branches that touch `src/coach/prompt.ts`, `docs/coach-voice.md` or `src/pipeline/inbound.ts`;
- anything whose spec or plan still has an open question (an agent can't stop to ask Yanni mid-build).

This session coordinates: it starts the agents with the issue, plan and branch name, keeps the labels and PRs
straight, and reports to Yanni once they're all done. They're reviewed and merged one at a time: after each merge,
the next branch rebases on `main` and runs `npm run check` again. If two branches changed what ZOH says, rerun the
touched eval cases once both are on `main`.

1. `gh issue view $ARGUMENTS --comments`. It must be labeled `plan-approved` and have a `## Plan (approved by Yanni...)`
   comment; if not, stop and say `/plan` comes first. The spec and plan are the contract.
2. **Work in your own worktree,** so other sessions in this repo aren't disturbed (never switch branches in the
   main folder). If this session already runs in a worktree (the desktop app can create one per session), use it.
   Otherwise: `git fetch origin`, then
   `git worktree add ../zoh-worktrees/$ARGUMENTS-<short-slug> -b feature/$ARGUMENTS-<short-slug> origin/main`,
   `cd` into it and run `npm install`. Do everything below from there.
   `gh issue edit $ARGUMENTS --add-label building --remove-label plan-approved`.
3. Open a **draft PR** early (`gh pr create --draft`, body from `.github/pull_request_template.md`, first line
   `Closes #$ARGUMENTS`) and push as you go, so Yanni can watch progress.
4. Write the **Must** tests first or alongside the code. Follow `CLAUDE.md`. Stay inside the plan.
5. **Decisions:** if you have to deviate in a small way, keep going and record it as an issue comment starting
   `Decision:` (what and why). If it changes what the tester experiences or the spec's intent, stop and ask Yanni.
6. **Eval** (only if ZOH's words change): run only the cases this change touches, adding a regression case in
   `eval/cases/<feature>/` when none covers it: `npm run eval -- <feature> --case <id> [--case <id>]` (check the
   cost first with `--dry-run`; it's free). A full run (no `--case`) only for changes that affect every
   conversation, and only with Yanni's OK. The budget is $1 per issue on the branch, up to $3, and the eval enforces
   it; never use `--over-budget` without Yanni's OK. In a group, run every issue's cases together once the prompt
   changes are all in. Fix causes in the coach's instructions, not
   one-off cases (see "Changing what ZOH says" in `CLAUDE.md`). If the budget runs out before the target, stop and
   report honestly; live testing and the beta will catch the rest.
7. `npm run check` green, rebased on the latest `main`.
8. Fill in the PR description (template sections; for a group, a short section per issue, and the Watch list
   grouped by issue), mark it ready (`gh pr ready`), and
   `gh issue edit $ARGUMENTS --add-label in-review --remove-label building`.
9. Finish with a short summary for Yanni: what changed for the tester, Must and Should results, eval spend,
   decisions made (and any issue taken out of the group), and "next: `/review $ARGUMENTS` in a fresh session".
