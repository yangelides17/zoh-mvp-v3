---
description: Shape a feature with Yanni and save the approved spec as a GitHub issue
argument-hint: [issue number(s) or new idea; leave empty to pick from the list]
---

You're helping Yanni define a feature for ZOH: **$ARGUMENTS**

This step is only the spec. Don't plan the implementation or write code here.

**Which feature?** If none was given, list open `idea`, `bug` and `decide` issues (separate `gh issue list --label`
calls: several `--label` flags mean "all of them") as a short numbered list, say which you'd do next and why, and ask
Yanni to pick or describe something new. If a description was given, reuse an open issue that already covers it.

**Several at once (optional).** `$ARGUMENTS` may name a group: related or dependent issues, or a handful of small ones.
Group only when it saves Yanni time without blurring the specs, and say so if you'd take one out (big, risky, a
database change, needs its own conversation). Ask shared questions once; each issue still gets its own spec in its own
body (a small bug can be a few lines: what's wrong, what should happen, Must and Watch), with `Part of a group with #a,
#b` and `Depends on #n` lines where they apply. Approve and save them together.

1. **Get context, quietly.** Read the newest code (see "Reading `dev`" in `CLAUDE.md`), `CLAUDE.md`,
   `docs/coach-voice.md`, `gh issue list --state all --limit 50`, and the issue itself if one was given. Skim code only
   as far as you need to know what exists. If an issue in progress (`spec-approved` to `in-review`) changes the same
   moment for testers, say so and ask how the two should fit.
2. **Play it back first.** Before any questions, tell Yanni in a few sentences what you think the problem is, why it
   matters, and a rough sketch of what the tester would experience. Ask: "Is this what you mean?" Fix the sketch, not
   a full spec, until he agrees.
3. **Ask what's still unclear**, one or two questions at a time, each with your recommendation. He cares about what the
   tester experiences and how ZOH sounds, not code details.
4. **Draft "Done means" with him.** Write the core scenarios from the tester's side ("tester texts 'stop'
   mid-onboarding → ZOH confirms and never texts again"), each tagged Must, Should or Watch. Then ask him both:
   **"What would make you say this is broken?"** and **"Is there any case not listed that you think is important to
   test?"** His answers become scenarios. Keep to core functionality; real testers will find the odd cases.
5. **Draft the spec** in this shape. It must fit on one screen; leave out sections that don't apply.

   ```
   ## Why
   One or two sentences.

   ## What the tester experiences
   Numbered steps from the tester's side of the phone.

   ## Example exchanges
   Two short good ones and one to avoid (only if ZOH's words are involved).

   ## Rules
   Only what isn't a single scenario (e.g. "never more than one nudge a day"). Each one checkable.

   ## Done means
   **Must** (automated tests, all must pass):
   - <scenario>
   **Should** (judgment checks graded by the eval; only if this changes what ZOH says; target: 80% unless Yanni says otherwise):
   - ...
   **Watch** (Yanni tries these on his phone on staging after merge, before the release):
   - ...

   ## Out of scope
   ## Open questions
   ```

   Fewer, clearer checks beat many strict ones: push back on anything stricter than what Yanni actually cares about.
6. **Show Yanni the draft** and revise until he approves. Every open question needs an answer first. If something
   about the idea seems wrong to you, say so plainly.
7. **Save it:** `gh issue create --title "<short name>" --body-file <tmp file> --label spec-approved` (or, for an
   existing issue, `gh issue edit <n> --body-file ... --add-label spec-approved --remove-label idea`).
8. **Finish** with one line: the issue (number and title), and "next: `/plan <n>`".
