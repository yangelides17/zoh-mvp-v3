---
description: Build an issue from its approved plan, test it, and open a PR
argument-hint: [issue number(s) or description; leave empty to pick]
---

Build issue **#$ARGUMENTS** on your own, following its approved plan.

**Which issue?** See "Picking an issue" in `CLAUDE.md` (label `plan-approved`). If none has it, say `/plan` comes first.

**A group (when the plan says so).** If `$ARGUMENTS` names several issues, or the plan is a group plan (the lead issue
has it; the others point to it), build them as the plan says. On one branch: name it
`feature/<a>-<b>-<c>-<short-slug>` (the eval budget counts the numbers), build in the plan's order with at least one
commit per issue (message ends `(#n)`), and put a `Closes #n` line for each in the PR. Labels move for every issue
together. If one issue gets stuck or turns out bigger than planned, take it out rather than hold up the rest: revert or
leave out its commits, drop its `Closes` line, move it back to `plan-approved`, post a `Decision:` comment saying why,
and tell Yanni.

**Parallel build agents (optional).** When the plan has separate branches, you may build them at the same time with
one background agent per branch, at most 3, each in its own worktree, only when it's clearly safe and saves real time.
Never in parallel:
- two branches that change the database (`src/db/schema.ts`, `drizzle/`): their migrations would collide;
- two branches that touch `src/coach/prompt.ts`, `docs/coach-voice.md` or `src/pipeline/inbound.ts`;
- anything whose spec or plan still has an open question (an agent can't stop to ask Yanni mid-build).

**Rules for build agents.** The orchestrator creates one worktree per branch from `origin/dev`
(`git worktree add ../zoh-worktrees/<slug> -b <branch> origin/dev`) and passes each agent the **absolute worktree
path**. **Never use `isolation: "worktree"`**: it may base the worktree on `main`, not `dev`. At most one agent per
worktree. The agent **never pushes**; only the orchestrating session pushes, after verifying the work (step 7). The
agent prompt includes the issue number, the full plan text, branch name and worktree path. The orchestrator keeps
labels and PRs straight and reports once all are done. They're reviewed and merged one at a time: after each merge,
the next branch rebases on `dev` and reruns `npm run check`; if two changed what ZOH says, rerun the touched eval
cases once both are on `dev`.

1. `gh issue view $ARGUMENTS --comments`. It must be labeled `plan-approved` and have a `## Plan (approved by Yanni...)`
   comment; if not, stop and say `/plan` comes first. The spec and plan are the contract.
2. **Work in your own worktree,** never by switching branches in the main folder, and always from `dev`, never `main`.
   If this session already runs in a worktree, check its base (`git fetch origin && git merge-base --is-ancestor
   origin/dev HEAD`); if that fails, `git switch -c feature/$ARGUMENTS-<short-slug> origin/dev` there (with uncommitted
   changes, stop and ask). Otherwise `git fetch origin`, then
   `git worktree add ../zoh-worktrees/$ARGUMENTS-<short-slug> -b feature/$ARGUMENTS-<short-slug> origin/dev`, `cd`
   into it and `npm install`. Then `gh issue edit $ARGUMENTS --add-label building --remove-label plan-approved`.
   **Is the plan still current?** Read what merged into `dev` since the plan (`git log --since=<plan date>
   --name-only origin/dev`) in the files it touches. **Overlap:** compare each open PR's `gh pr diff <pr> --name-only`
   and the plans of `plan-approved` issues with no PR. If both change the database, `src/coach/prompt.ts`,
   `docs/coach-voice.md` or `src/pipeline/inbound.ts`, post a `Decision:` on which lands first (a later migration is
   regenerated after the first merges). Note smaller overlaps under the PR's risks.
3. Open a **draft PR** into `dev` early (`gh pr create --draft --base dev`, body from `.github/pull_request_template.md`,
   first line `Closes #$ARGUMENTS`) and push as you go.
4. Write the **Must** tests first, and make sure each one would fail if the feature were broken. Follow `CLAUDE.md`,
   including the simplicity rules. Stay inside the plan.
5. **When something doesn't fit the plan,** post a `Decision:` comment on the issue (never only in the PR).
   - **Stop and ask the founders** only if the tester would experience something different from the spec, the
     approved design turns out not to work (the plan assumed something about the code that isn't true), or a choice is
     hard to undo (dropping or rewriting data, who gets texted). Keep building other parts meanwhile if you can, and
     ask everything at once.
   - **Post, label, keep building** for smaller deviations that still change behavior, the fixture format or what gets
     written to the DB: add `needs-signoff` (`gh issue edit $ARGUMENTS --add-label needs-signoff`).
   - Purely internal choices (a variable name, a loop vs. map) need neither.
6. **Eval** (only if ZOH's words change): run only the cases this change touches, adding a regression case in
   `eval/cases/<feature>/` when none covers it. While iterating, `npm run eval -- <feature> --case <id>` (graded by
   Haiku, cheap); when done, one `--final` run of those cases (graded by the coach's model) for the results in the PR.
   Check cost first with `--dry-run` (free). A full run (no `--case`) only for changes that affect every conversation,
   and only with Yanni's OK; never `--over-budget` without it. In a group, run every issue's cases together once the
   prompt changes are in. Fix causes in the coach's instructions, not one-off cases. If the budget runs out before the
   target, stop and report honestly.
7. **Before pushing or opening the PR:**
   - `npm run check` green, rebased on the latest `dev`, and `git merge-base --is-ancestor origin/dev HEAD` passes
     (if not, stop: the branch isn't based on `dev`).
   - **Protected files:** `git diff origin/dev -- eval/memory-lab/fixtures/ docs/memory-*.md docs/coach-voice.md`
     shows nothing the plan didn't call for (hand-authored fixtures and docs are read-only to builders).
   - **Migrations:** a generated migration has its `drizzle/meta/NNNN_snapshot.json`, and `npx drizzle-kit generate`
     reports "No schema changes, nothing to migrate"; otherwise regenerate before pushing.
8. Fill in the PR description from the template (for a group, a short section per issue), mark it ready
   (`gh pr ready`), and `gh issue edit $ARGUMENTS --add-label in-review --remove-label building`.
9. Finish with one line for Yanni, plus anything he should know now (a stop, an over-budget eval, an issue taken out
   of the group): "Ready for review: `/review $ARGUMENTS` in a fresh session."
