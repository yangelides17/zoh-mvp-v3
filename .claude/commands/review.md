---
description: Independently review an issue's PR, then merge it when Yanni says so
argument-hint: [issue number or description; leave empty to pick]
---

Review the PR for issue **#$ARGUMENTS** with fresh eyes. Best run in a new session that didn't build it.

**Which issue?** See "Picking an issue" in `CLAUDE.md` (label `in-review`). If none has it, say nothing is waiting.

**A group.** If the PR closes several issues, review it once for all of them: read every spec and the group plan (on
the lead issue), check each issue's Must tests and Watch items on their own, and on merge move every label and leave
each issue its own "Live checks" comment. If one issue's part isn't ready, you may suggest taking it out (as `/build`
describes); it's Yanni's call. Parallel branches from one plan merge one at a time: rebase the next on `dev` and run
`npm run check` first.

Features merge into `dev` (staging), never straight to production. A PR whose base is `main` is a release or hotfix:
say so and stop (unless it's a hotfix Yanni asked for through `/quick`).

1. `gh issue view $ARGUMENTS --comments` (spec, plan, decisions); find the PR (`gh pr list --search "$ARGUMENTS"`),
   then `gh pr view <pr>` and `gh pr diff <pr>`. Run the tests in its own worktree
   (`git fetch origin && git worktree add ../zoh-worktrees/review-$ARGUMENTS origin/<branch>`, `npm install`).
2. **Check it:**
   - Base is `dev` and the branch is up to date (`git merge-base --is-ancestor origin/dev origin/<branch>`); if not,
     rebase on `origin/dev` and push (`--force-with-lease`) first.
   - Every **Must** has a real test, and `npm run check` passes. **Prove the tests catch a broken feature:** in the
     review worktree, put the source back to `dev` while keeping the PR's tests
     (`git restore --source=origin/dev --worktree -- src/`), run the new and changed test files
     (`npx vitest run <files>`) and confirm the Must tests fail; then `git restore --source=HEAD --worktree -- src/`.
     A Must test that still passes doesn't test the change: list it. Skip when the PR changes no code in `src/`.
   - **Extra review (trial, risky PRs only).** If the diff touches anything that starts a text or decides who gets one
     (`src/sendblue/`, `src/nudges/`, `owns`/`ALLOWED_NUMBERS`), the database (`src/db/schema.ts`, `drizzle/`),
     `src/pipeline/` or `src/memory/`, start one background agent (model `sonnet`) as soon as you have the diff, so it
     runs while you check the rest. Give it the diff and the files it touches, and ask it only for silent failures:
     errors caught and dropped, a send or memory write that can fail with nothing logged or alerted, a fallback that
     hides a failure. Each finding: the line, and what a tester would experience. Fold the real ones into your review.
     On a risky PR, before you say **fix first** over a problem you found (not failing tests or `needs-signoff`), have
     a second agent check that finding on its own, told to refute it when unsure; drop what it refutes.
   - **The design held up:** it still works the way the plan's "How it works" says, and each risk in "Where it could
     break" got its guard. If the plan or spec now looks wrong, say so plainly.
   - **Simplicity:** nothing is more complicated than the spec needs (the rules in `CLAUDE.md`); unrelated code wasn't
     reshaped.
   - Nothing out of scope got built; every `Decision:` comment is reasonable. If the issue has `needs-signoff`, the
     verdict is **fix first**: list the unsigned decisions and stop until a founder removes the label.
   - The `CLAUDE.md` rules hold: no secrets or full phone numbers, one generated migration at most, the webhook stays
     fast, replies only to allowed numbers, `docs/reference.md` updated if needed.
   - Read the eval results in the PR; don't rerun the eval. If only Haiku-graded runs are there, ask for the `--final` run.
3. Fix small problems yourself (push to the PR branch). For bigger ones, list them and don't merge.
4. **Tell Yanni**, in plain words, and post the same as a PR comment:
   - **Verdict:** merge or fix first, and why in a line.
   - **Different from the plan:** only what changed and why; "As planned" if nothing did.
   - **Decisions worth knowing:** only those that affect testers or the design.
   - **Tests:** "All N Must tests pass", or what failed.
   - **Eval** (if ZOH's words changed): a short summary of what passed and went well. For each check below target, more
     detail: the weakness, the pattern behind it, one real reply showing it, and whether the build fixed the cause.
   - **What ZOH will say differently:** the instruction change in a sentence or two, and one or two real exchanges
     from the eval.
   - **Live checks:** the Watch list ranked by where the build is least sure, each of the top one or two with a reason.
   - **Extra review** (risky PRs only): "Extra review (trial n/5): <what it found that was real> / nothing real". Count
     n from earlier reviews (`gh search prs --repo yangelides17/zoh-mvp-v3 "Extra review (trial" in:comments`). At
     5/5, add the tally across the five and recommend keeping or dropping it; Yanni decides, and `/quick` updates this
     command.
   - **A rule that would have caught it** (only when the review found a real problem): the `CLAUDE.md` line to sharpen,
     or one new line, that would have stopped it during the build. Yanni decides; `/quick` adds it.
5. **Only when Yanni says merge:** `gh pr merge <pr> --merge --delete-branch`; remove this issue's worktrees
   (`git worktree list`, `git worktree remove --force <path>`, `git worktree prune`); bring the main folder up to date
   (`git -C <main folder> pull --ff-only`, or say why not); `gh issue edit $ARGUMENTS --add-label done --remove-label
   in-review`. It's **done**: staging redeploys in a couple of minutes; production waits for `/release`. Warn open PRs
   that share files with this one ("`dev` changed files this PR touches (#<pr>, <title>): rebase and rerun
   `npm run check`") and tell Yanni which.
6. **Leave the Live checks on the issue:** `gh issue comment $ARGUMENTS` with "**Live checks** (try on staging after
   texting `env staging`, before the next release):" and the ranked list as `- [ ]` checkboxes, the top ones marked
   **(most important)** with their reason. Done doesn't wait for these.
7. A live check that goes wrong becomes a `bug` issue and, for the coach, a regression case in `eval/cases/`.
