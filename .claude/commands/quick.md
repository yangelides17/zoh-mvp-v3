---
description: Make a small fix or change straight on main, with a record of it
argument-hint: <what to fix or change>
---

Make this small change: **$ARGUMENTS**

1. **Is it small?** Small means docs, wording, config, eval checks, or a fix of a few lines that doesn't change
   the database, add a feature, or change how ZOH sounds in general. If it's bigger, say so and suggest `/idea`
   (or `/spec`) instead; do it as a quick change only if Yanni insists, and note that in the record.
2. Work in the main folder on `main` (`git pull` first). If other builds are running, that's fine: they work in
   their own worktrees.
3. Make the change. If it fixes behavior, add or adjust a test for it.
4. `npm run check` must pass. Then commit (message says what and why) and push to `main`. Railway deploys it in a
   couple of minutes; if the build's tests fail, nothing deploys and the live line keeps running the old version.
5. **Leave a record:** if it relates to an issue, comment on it (and close it if it's fixed). Otherwise create a
   closed issue for it: `gh issue create --title "Quick: ..." --label done --body "<what, why, commit link>"`, then
   `gh issue close <n>`.
6. Tell Yanni in one or two lines what changed and what to try on his phone, if anything.
