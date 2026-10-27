---
description: Independently review an issue's PR, then merge it when Yanni says so
argument-hint: <issue number>
---

Review the PR for issue **#$ARGUMENTS** with fresh eyes. Best run in a new session that didn't build it.

1. `gh issue view $ARGUMENTS --comments` (spec, approved plan, decisions) and find the PR: `gh pr list --search "$ARGUMENTS"`.
   Read `gh pr view <pr>` and `gh pr diff <pr>`.
2. Check it against the spec and plan:
   - Every **Must** item has a real test, and `npm run check` passes on the PR branch.
   - **Should** results: read the eval summary in the PR. Don't rerun the eval.
   - Nothing out of scope got built; every `Decision:` comment is reasonable.
   - The `CLAUDE.md` rules hold: no secrets or full phone numbers in code or logs, one generated migration at most,
     the webhook stays fast, replies only to allowed numbers.
3. Fix small problems yourself (push to the PR branch). For bigger ones, list them and don't merge.
4. Post the review as a PR comment and tell Yanni in plain words: verdict (merge / fix first), what changed for the
   tester, any risk, and the **Watch** list to try on his phone.
5. **Only when Yanni says merge:** `gh pr merge <pr> --merge --delete-branch`, then
   `gh issue edit $ARGUMENTS --add-label live-check --remove-label in-review`. Railway deploys `main` in a couple of minutes.
6. After Yanni's live check: if it's good, `gh issue edit $ARGUMENTS --add-label done --remove-label live-check`.
   Anything wrong becomes a new issue (`--label bug`) and, for the coach, a regression case in `eval/cases/`.
