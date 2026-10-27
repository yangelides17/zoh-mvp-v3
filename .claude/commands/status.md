---
description: Show where every feature stands
---

Give Yanni a short status of the work, from GitHub:

1. `gh issue list --state open --limit 100 --json number,title,labels,assignees` and
   `gh pr list --json number,title,isDraft,headRefName`.
2. Group by stage, in this order: `in-review`, `building`, `plan-approved`, `spec-approved`, `live-check`, `decide`,
   `bug`, `idea`. One line per issue: number, title, linked PR if any.
3. End with what needs Yanni right now: specs or plans waiting for approval, PRs waiting for "merge", live checks to
   try, and `decide` items waiting for Yes / Later / No.
