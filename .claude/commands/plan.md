---
description: Propose how to build an approved spec, get Yanni's OK, and post the plan on the issue
argument-hint: [issue number(s) or description; leave empty to pick]
---

Plan the build for issue **#$ARGUMENTS**. Don't write code in this step.

**Which issue?** See "Picking an issue" in `CLAUDE.md` (label `spec-approved`). If none has it, say `/spec` comes first.

**Several at once (optional).** `$ARGUMENTS` may name several issues, or you may suggest a group when they touch the
same code, depend on each other, or are small fixes. Never required: split one out if it changes the database while
the others don't, is much bigger, has a shaky spec, or shouldn't hold the others up. At most about 5 small issues, or 3
that change what ZOH says. A group gets **one** plan, plus: the build order and why; per issue, its changes and Must
tests (so each can be dropped on its own); one branch and PR (the default) or separate ones; and, for separate
branches, whether you'd build them as parallel agents (see `/build`) and why it's safe.

1. `gh issue view $ARGUMENTS --comments`; it must have the `spec-approved` label.
2. **Plan against `dev`** (see "Reading `dev`" in `CLAUDE.md`). Read `CLAUDE.md`, `docs/coach-voice.md` (if ZOH's
   words are involved) and the code the feature touches. Check work in flight: `gh issue list --label plan-approved`,
   the same with `--label building`, and `gh pr list`; name any shared files by issue number and title.
3. **Write the briefing.** This is what Yanni reads and approves: plain words, no file names, about two minutes.
   1. **How it works.** The big picture: what the feature is made of, what each piece does, and how it fits into what
      ZOH already does. Trace a text's route through the system only when the feature changes it.
   2. **Where it could break.** Is the design sound, beyond matching the spec: who a number belongs to, time zones,
      staging vs production, memory, deleted data, anything that passes tests but fails with real people. How existing
      code changes to make room: what behavior changes, which other features share it and what protects them. The
      simpler approach you considered and why not. For each risk (top two or three), what the tester would see and the
      guard against it.
   3. **Where I disagree.** What you're least confident about, and anything you'd change in the spec, even though it's
      approved. "Nothing" only with a reason.
   4. **Questions for Yanni.** Only decisions that are his.

   For a big build, add how it splits into pieces that can each be tried on staging. For a large or risky feature (a
   database change, how the coach thinks, several parts of the system at once), offer in one line to have a separate
   agent critique the spec and design first; run it only if Yanni says yes, and fold its findings into section 3.
4. **Write the appendix** for `/build` and `/review` (Yanni may skip it): the modules and files; any database change
   (one migration at most, for a group too); one line per **Must** saying how it's tested; the eval (only with
   **Should** items): rubric entries copied close to word for word from the spec, the cases to run and the spend (see
   the eval budget in `CLAUDE.md`; in a group, one run at the end covers every issue); overlaps with work in flight;
   size (small, medium, large).
5. Present the briefing (the appendix on request) and revise until Yanni approves. If planning shows the spec is wrong,
   say so and ask; don't quietly change it.
6. On approval: `gh issue comment $ARGUMENTS --body-file <tmp file>` with the briefing, then `### Appendix`, under the
   heading `## Plan (approved by Yanni, <date>)`, then
   `gh issue edit $ARGUMENTS --add-label plan-approved --remove-label spec-approved`. For a group, post it on the lead
   issue (first in build order), comment `Plan: in the group plan on #<lead>` on the others, and move every label.
7. Finish with one line: "Plan posted. Next: `/build $ARGUMENTS`".
