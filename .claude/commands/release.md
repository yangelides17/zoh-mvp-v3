---
description: Release what's on dev (staging) to production, with plain-language notes and a "Worth a look" list
argument-hint: [optional: a version, e.g. 0.4.0; default is the next minor]
---

Release what's been merged into `dev` (staging) to `main` (production, the testers' line). Yanni says "ship"; until
then nothing reaches testers.

1. **What's going out.** `git fetch origin --tags`, then `git log --first-parent --format="%h %s" origin/main..origin/dev`.
   If it's empty, say there's nothing to release and stop. From those commits, collect:
   - every merged PR (`Merge pull request #n`) and the issues it closes (`gh pr view <n> --json body,title,comments,reviews`);
   - quick changes made on `dev` (their `Quick:` issues or issue comments).
   Read each issue (`gh issue view <n> --comments`): its spec, decisions, review comments and its "Live checks" comment.
2. **Version.** The last tag is `git describe --tags --abbrev=0 origin/main` (no tag yet: the last is the `version` in `package.json` on `main`).
   Default: the next minor (`0.3.0` → `0.4.0`); a release of only bug fixes may be a patch (`0.4.1`). Use `$ARGUMENTS`
   if Yanni gave one. Bump it on `dev` so staging shows it too: in the main folder on a clean `dev`
   (`git pull --ff-only`), `npm version <v> --no-git-tag-version`, `npm run check`, commit "Release v<v>: version",
   push `dev`.
3. **Release notes**, in plain words for Yanni (what testers will notice, not code). The shape:
   ```
   ## Release v<v>
   **What testers will notice**: one line per issue, "#n (<title>): <what changes for them>".
   **Fixes**: one line per bug.
   **Behind the scenes**: console, tests, workflow, anything testers won't see.
   **Deploy notes**: database migrations (they run on production at startup), new Railway variables to set on
   production *before* shipping, anything to do after.
   ```
4. **Open the release PR:** `gh pr create --base main --head dev --title "Release v<v>" --body-file <notes>`
   (end the body with the attribution lines the session asks for). Not a draft: CI runs on it.
5. **Worth a look** (suggestions, never blockers). Before asking for "ship", give Yanni a short list, also added to
   the PR as a comment, one line each on what and why. Use judgment, not a checklist dump:
   - **Live checks** still unticked (`- [ ]` in an issue's "Live checks" comment) that matter: ones that touch
     what testers see or say, risky paths (sending, stop, pauses, scheduling, the database), or that a review flagged.
     Skip trivial or cosmetic ones.
   - **Concerns** found in the PRs, reviews, `Decision:` comments and issue threads: known gaps or "follow-up"
     notes left open, an eval that was skipped, below target or over budget, a migration (irreversible on
     production), a new Railway variable production doesn't have yet, a fix that landed on staging only hours ago
     and hasn't been tried, anything a reviewer said to watch.
   If nothing stands out, say "Nothing worth flagging" rather than inventing items. End with: "Say **ship** to
   release, or tell me what to check first."
6. **Only when Yanni says ship:**
   - Check the deploy notes first (for example, ask Yanni to set a new variable on production) and that CI is green.
   - `gh pr merge <pr> --merge` (never `--delete-branch`: `dev` stays).
   - Tag the merge commit: `git fetch origin && git tag -a v<v> origin/main -m "Release v<v>"` and `git push origin v<v>`.
   - Bring `dev` level with `main` so they don't drift: `git push origin origin/main:dev` (a fast-forward; if it
     isn't one, merge `origin/main` into `dev`, `npm run check`, push).
   - Production deploys in a couple of minutes. Check it: production's `/health` (see `docs/reference.md` for the
     URL) shows the new commit and no errors, then `?deep=1`, and skim the app's logs on Railway for errors.
     If it's unhealthy, tell Yanni at once and offer to roll back the deploy on Railway, then fix through a hotfix (`/quick`).
7. **Finish** with a short summary for Yanni: the version, what testers will notice, the health check result, and
   any "Worth a look" items still open.
