---
description: Show where every feature stands
argument-hint: [optional: a feature or stage to focus on]
---

Give Yanni a short status of the work, from GitHub. If `$ARGUMENTS` names a feature or a stage ("nudges",
"what's in review"), focus on that, including its spec, plan and latest decisions.

1. `gh issue list --state open --limit 100 --json number,title,labels,assignees` and
   `gh pr list --json number,title,isDraft,headRefName`.
2. Leave the `live-check` issue ("Live checks to do") out of the groups; step 4 covers it. Group by stage, in this order: `in-review`, `building`, `plan-approved`, `spec-approved`, `decide`,
   `bug`, `idea`. One line per issue: number, title, linked PR if any.
3. **Changes outside the flow:** `git fetch origin && git log origin/main --since="7 days ago" --no-merges --format="%h %an %ar %s"`.
   List commits on `main` from the last week that aren't from a merged PR and aren't mentioned on any issue (a
   rogue or hand-made change). For each: who, when, what it touched, and whether it touched risky areas
   (`src/db/schema.ts` or `drizzle/`, `src/coach/prompt.ts`, `src/pipeline/`, config). Offer to file each as a
   closed `Quick:` issue so the record is complete. Skip this section if there are none.
4. End with what needs Yanni right now: specs or plans waiting for approval, PRs waiting for "merge", how many boxes are
   still unticked on "Live checks to do" (with its number and the features they're for), and `decide` items waiting for Yes / Later / No.
