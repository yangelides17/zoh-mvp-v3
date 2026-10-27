---
description: Build an issue from its approved plan, test it, and open a PR
argument-hint: [issue number or description; leave empty to pick]
---

Build issue **#$ARGUMENTS** on your own, following its approved plan.

**Which issue?** `$ARGUMENTS` may be an issue number, a description ("the nudges one") or empty. If it isn't a
number, run `gh issue list --state open --label plan-approved` and match the description to an issue; if it's empty or
matches more than one, show those issues as a short numbered list and ask Yanni which one. Call the chosen
number N and use it everywhere below in place of `$ARGUMENTS`. If nothing has the `plan-approved` label, say what building
needs first and stop.

1. `gh issue view $ARGUMENTS --comments`. It must be labeled `plan-approved` and have a `## Plan (approved by Yanni...)`
   comment; if not, stop and say `/plan` comes first. The spec and plan are the contract.
2. Start clean: `git checkout main && git pull`, then `git checkout -b feature/$ARGUMENTS-<short-slug>`.
   `gh issue edit $ARGUMENTS --add-label building --remove-label plan-approved`.
3. Open a **draft PR** early (`gh pr create --draft`, body from `.github/pull_request_template.md`, first line
   `Closes #$ARGUMENTS`) and push as you go, so Yanni can watch progress.
4. Write the **Must** tests first or alongside the code. Follow `CLAUDE.md`. Stay inside the plan.
5. **Decisions:** if you have to deviate in a small way, keep going and record it as an issue comment starting
   `Decision:` (what and why). If it changes what the tester experiences or the spec's intent, stop and ask Yanni.
6. **Eval** (only if the spec has **Should** items): add the rubric and scenarios in `eval/`, iterate with
   `npm run eval -- <feature> --persona <name>`, and do one full run at the end. The budget is $2 per branch and
   the eval enforces it; never use `--over-budget` without Yanni's OK. Fix causes in the coach's instructions, not
   one-off cases (see "Changing what ZOH says" in `CLAUDE.md`). If the budget runs out before the target, stop and
   report honestly; live testing and the beta will catch the rest.
7. `npm run check` green, rebased on the latest `main`.
8. Fill in the PR description (template sections), mark it ready (`gh pr ready`), and
   `gh issue edit $ARGUMENTS --add-label in-review --remove-label building`.
9. Finish with a short summary for Yanni: what changed for the tester, Must and Should results, eval spend,
   decisions made, and "next: `/review $ARGUMENTS` in a fresh session".
