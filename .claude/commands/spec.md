---
description: Shape a feature with Yanni and save the approved spec as a GitHub issue
argument-hint: [issue number or new idea; leave empty to pick from the list]
---

You're helping Yanni define a feature for ZOH: **$ARGUMENTS**

This step is only the spec. Don't plan the implementation or write code here.

**Which feature?** If no feature was given, run `gh issue list --state open --label idea`, then the same with
`--label bug` and `--label decide` (separate calls: several `--label` flags mean "all of them"), show them as a short numbered list (issue number, title, one line each), say which one you'd do
next and why, and ask Yanni to pick one or describe something new. If an issue number was given, that's the
feature. If a description was given, check whether an open issue already covers it and use that one if so.

1. **Get context, quietly.** Read `CLAUDE.md` and `docs/coach-voice.md`. Run `gh issue list --state all --limit 50`
   to see what exists. If `$ARGUMENTS` is an issue number, read it with `gh issue view`. Skim the code only as far
   as you need to know what already exists.
2. **Talk it through.** Ask Yanni the questions that change what gets built, one or two at a time, and offer your
   recommendation with each. He cares about what the tester experiences and how ZOH sounds, not code details.
3. **Draft the spec** in this shape. It must fit on one screen; leave out sections that don't apply.

   ```
   ## Why
   One or two sentences.

   ## What the tester experiences
   Numbered steps from the tester's side of the phone.

   ## Example exchanges
   Two short good ones and one to avoid (only if ZOH's words are involved).

   ## Rules
   Only the ones that matter. Each one checkable.

   ## Edge cases
   Only real ones.

   ## Done means
   **Must** (automated tests, all must pass):
   - ...
   **Should** (judgment checks graded by the eval; only if this changes what ZOH says; target: 80% unless Yanni says otherwise):
   - ...
   **Watch** (Yanni tries these on his phone after merge):
   - ...

   ## Out of scope
   ## Open questions
   ```

   Keep the bar reasonable: fewer, clearer rules beat many strict ones. Push back on anything that would make the
   tests stricter than what Yanni actually cares about.
4. **Show Yanni the draft** and revise until he says it's approved. Every open question needs an answer first.
5. **Save it:** create the issue with `gh issue create --title "<short name>" --body-file <tmp file> --label spec-approved`
   (or, for an existing issue, `gh issue edit <n> --body-file ... --add-label spec-approved --remove-label idea`).
6. **Finish** with one line: the issue number, and "next: `/plan <n>`".
