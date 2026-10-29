---
description: Propose how to build an approved spec, get Yanni's OK, and post the plan on the issue
argument-hint: [issue number(s) or description; leave empty to pick]
---

Plan the build for issue **#$ARGUMENTS**. Don't write code in this step.

**Which issue?** `$ARGUMENTS` may be an issue number, a description ("the nudges one") or empty. If it isn't a
number, run `gh issue list --state open --label spec-approved` and match the description to an issue; if it's empty or
matches more than one, show those issues as a short numbered list and ask Yanni which one. Call the chosen
number N and use it everywhere below in place of `$ARGUMENTS`. If nothing has the `spec-approved` label, say what planning
needs first and stop.

**Several at once (optional).** `$ARGUMENTS` may name several issues ("41 42 48", "the small nudge bugs"), or you may
suggest a group when several `spec-approved` issues would be cheaper to build together (they touch the same code, one
depends on another, or they're small fixes). It's never required: plan a group only when you think it's safe and
saves time, and say so if you'd rather split one out. Good reasons to split: it changes the database while the others
don't, it's much bigger than the rest, its spec is still shaky, or a problem with it shouldn't hold the others up.
Keep a group to about 5 small issues, or 3 that change what ZOH says. For a group, run each step below for every
issue, and write **one** plan with these extra parts:
- **Group:** the issues, the build order and why (dependencies first).
- **Per issue:** its changes and its Must tests, so each can be reviewed, reverted or dropped on its own.
- **Branches:** one branch and PR for the group (the default), or separate ones when the issues don't touch the same
  code and one shouldn't wait on another.
- **Parallel builds (optional):** if separate branches would finish meaningfully sooner, say whether you'd run them as
  parallel build agents and why it's safe (see "Parallel build agents" in `/build`). If you have doubts, say so and
  plan them one after another.

1. `gh issue view $ARGUMENTS --comments`. It must have the `spec-approved` label; if not, stop and say `/spec` comes first.
2. Read `CLAUDE.md`, `docs/coach-voice.md` (if ZOH's words are involved) and the code the feature touches. Check
   what else is in flight: `gh issue list --label plan-approved`, the same with `--label building`, and `gh pr list`.
   Note any files you'd both touch, naming each overlap by issue number and title.
3. Write the plan in plain words, short enough to read in two minutes (a group may take a little longer):
   - **Approach:** how it works, in a few sentences.
   - **Changes:** the modules and files, and any database change (one migration at most, for a group too).
   - **Tests:** one line per **Must** item saying how it's tested.
   - **Eval** (only if the spec has **Should** items): the rubric entries (copied from the spec, close to word for
     word), the cases to run and the spend: $1 per issue on the branch, up to $3 (targeted `--case` runs; a full run
     only with Yanni's OK). In a group, prompt changes count as one change: one run at the end covers every issue's cases.
   - **Risks and open points**, and anything that overlaps with work in flight.
   - **Size:** small, medium or large.
4. Present it to Yanni and revise until he approves. If planning shows the spec is wrong or missing something,
   say so and ask; don't quietly change the spec.
5. On approval: `gh issue comment $ARGUMENTS --body-file <tmp file>` with the plan under the heading
   `## Plan (approved by Yanni, <date>)`, then `gh issue edit $ARGUMENTS --add-label plan-approved --remove-label spec-approved`.
   For a group, post the plan on the first issue in build order (the lead), comment on each of the others
   `Plan: in the group plan on #<lead>`, and move every issue's label.
6. Finish with one line: "Plan posted. Next: `/build $ARGUMENTS`" (or `/build <a> <b> ...`; it can run in this session or a new one).
