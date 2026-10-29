---
description: Independently review an issue's PR, then merge it when Yanni says so
argument-hint: [issue number or description; leave empty to pick]
---

Review the PR for issue **#$ARGUMENTS** with fresh eyes. Best run in a new session that didn't build it.

**Which issue?** `$ARGUMENTS` may be an issue number, a description ("the nudges one") or empty. If it isn't a
number, run `gh issue list --state open --label in-review` and match the description to an issue; if it's empty or
matches more than one, show those issues as a short numbered list and ask Yanni which one. Call the chosen
number N and use it everywhere below in place of `$ARGUMENTS`. If nothing has the `in-review` label, say nothing is waiting for review and stop.

**A group.** If the PR closes several issues (one `Closes #n` line each), review it once for all of them: read every
issue's spec and the group plan (on the lead issue), check each issue's Must tests and Watch items on their own, and
when it merges, move every issue's label and record the Watch list under one heading per issue. If one issue's part
isn't ready but the rest is, you may suggest taking it out (as `/build` describes) rather than holding up the group;
it's Yanni's call. Branches from one plan built in parallel are reviewed and merged one at a time: rebase the next on
`main` and run `npm run check` before merging it.

1. `gh issue view $ARGUMENTS --comments` (spec, approved plan, decisions) and find the PR: `gh pr list --search "$ARGUMENTS"`.
   Read `gh pr view <pr>` and `gh pr diff <pr>`. To run the tests, check the branch out in its own worktree
   (`git fetch origin && git worktree add ../zoh-worktrees/review-$ARGUMENTS origin/<branch>`, then `npm install`),
   never by switching branches in the main folder.
2. Check it against the spec and plan:
   - Every **Must** item has a real test, and `npm run check` passes on the PR branch.
   - **Should** results: read the eval summary in the PR. Don't rerun the eval.
   - Nothing out of scope got built; every `Decision:` comment is reasonable.
   - The `CLAUDE.md` rules hold: no secrets or full phone numbers in code or logs, one generated migration at most,
     the webhook stays fast, replies only to allowed numbers, and `docs/reference.md` is updated if the PR adds a
     service or Railway variable or reverses a decision recorded there.
3. Fix small problems yourself (push to the PR branch). For bigger ones, list them and don't merge.
4. Post the review as a PR comment and tell Yanni in plain words: verdict (merge / fix first), what changed for the
   tester, any risk, and the **Watch** list to try on his phone.
5. **Only when Yanni says merge:** `gh pr merge <pr> --merge --delete-branch`, remove the worktrees for this issue
   (`git worktree list`, then `git worktree remove --force <path>` for the review and build ones, and
   `git worktree prune`), bring the main folder up to date (`git -C <main folder> pull --ff-only`; if it isn't on a
   clean `main`, skip this and say so), then
   `gh issue edit $ARGUMENTS --add-label done --remove-label in-review`. Railway deploys `main` in a couple of minutes.
6. **Record the Watch list:** add it as unticked boxes under a `### <title> (#$ARGUMENTS, PR #<pr>)` heading in the body
   of the open `live-check` issue, "Live checks to do" (`gh issue list --label live-check`; create it with that label
   if it's missing), via `gh issue edit <n> --body-file`. Done doesn't wait for these.
7. When Yanni reports a live check: tick it if it's good. Anything wrong becomes a new issue (`--label bug`) and,
   for the coach, a regression case in `eval/cases/`; tick the box and link the bug.
