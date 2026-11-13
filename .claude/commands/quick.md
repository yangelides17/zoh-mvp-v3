---
description: Make a small fix or change on dev (staging), or as a hotfix on production, with a record of it
argument-hint: <what to fix or change>
---

Make this small change: **$ARGUMENTS**

1. **Is it small?** Small means docs, wording, config, eval checks, or a fix of a few lines that doesn't change
   the database, add a feature, or change how ZOH sounds in general. If it's bigger, say so and suggest `/idea`
   (or `/spec`) instead; do it as a quick change only if Yanni insists, and note that in the record.
2. **Ask first, every time, before changing anything:** "Should this go to **dev (staging)**, or **straight to
   production as a hotfix**?" Use the question tool with exactly those two choices, recommend one (dev, unless it
   fixes something broken for testers right now), and wait for the answer. Never guess and never assume a default,
   even when the change looks harmless. Say which one in the record (step 6).
3. **Dev (staging):** work in the main folder on `dev` (`git pull` first). If other builds are running, that's fine:
   they work in their own worktrees. Make the change (if it fixes behavior, first write a test that reproduces
   the problem and see it fail, then fix it),
   `npm run check` must pass, then commit (message says what and why) and push to `dev`. Railway redeploys
   staging in a couple of minutes; it reaches testers with the next `/release`.
4. **Hotfix (production):** `git fetch origin`, then
   `git worktree add ../zoh-worktrees/hotfix-<slug> -b hotfix/<slug> origin/main` and work there (never switch the
   main folder to `main`). Make the change with a test (failing first, as in step 3), `npm run check` must pass, then open a PR into `main`
   (`gh pr create --base main`, titled "Hotfix: ..."). When Yanni says "ship" (or already did, for a live breakage):
   merge it, tag the next patch version and publish its GitHub Release (see `/release`, step 6; the notes are short:
   what broke or why, what changed for testers, deploy notes such as a new variable, and links to the PR and record
   issue), check production's `/health`, then bring `dev` up to
   date with `main` (`git -C <main folder> pull --ff-only`, `git -C <main folder> merge origin/main`, `npm run check`,
   push `dev`) so the fix isn't lost on the next release. Remove the worktree.
5. If the build's tests fail on Railway, nothing deploys and that environment keeps running the old version.
6. **Leave a record:** if it relates to an issue, comment on it (and close it if it's fixed). Otherwise create a
   closed issue for it: `gh issue create --title "Quick: ..." --label done --body "<what, why, dev or hotfix, commit link>"`,
   then `gh issue close <n>`.
7. Tell Yanni in one or two lines what changed, where it went (staging or production), and what to try on his phone,
   if anything.
