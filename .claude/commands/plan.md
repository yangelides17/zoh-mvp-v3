---
description: Propose how to build an approved spec, get Yanni's OK, and post the plan on the issue
argument-hint: [issue number or description; leave empty to pick]
---

Plan the build for issue **#$ARGUMENTS**. Don't write code in this step.

**Which issue?** `$ARGUMENTS` may be an issue number, a description ("the nudges one") or empty. If it isn't a
number, run `gh issue list --state open --label spec-approved` and match the description to an issue; if it's empty or
matches more than one, show those issues as a short numbered list and ask Yanni which one. Call the chosen
number N and use it everywhere below in place of `$ARGUMENTS`. If nothing has the `spec-approved` label, say what planning
needs first and stop.

1. `gh issue view $ARGUMENTS --comments`. It must have the `spec-approved` label; if not, stop and say `/spec` comes first.
2. Read `CLAUDE.md`, `docs/coach-voice.md` (if ZOH's words are involved) and the code the feature touches. Check
   what else is in flight: `gh issue list --label building` and `gh pr list`, and note any files you'd both touch.
3. Write the plan in plain words, short enough to read in two minutes:
   - **Approach:** how it works, in a few sentences.
   - **Changes:** the modules and files, and any database change (one migration at most).
   - **Tests:** one line per **Must** item saying how it's tested.
   - **Eval** (only if the spec has **Should** items): the rubric entries (copied from the spec, close to word for
     word), the scenarios, and the plan for the $2 budget (single-persona runs while iterating, one full run at the end).
   - **Risks and open points**, and anything that overlaps with work in flight.
   - **Size:** small, medium or large.
4. Present it to Yanni and revise until he approves. If planning shows the spec is wrong or missing something,
   say so and ask; don't quietly change the spec.
5. On approval: `gh issue comment $ARGUMENTS --body-file <tmp file>` with the plan under the heading
   `## Plan (approved by Yanni, <date>)`, then `gh issue edit $ARGUMENTS --add-label plan-approved --remove-label spec-approved`.
6. Finish with one line: "Plan posted. Next: `/build $ARGUMENTS`" (it can run in this session or a new one).
