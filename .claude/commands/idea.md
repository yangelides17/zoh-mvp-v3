---
description: Quickly file a new idea or bug as an issue, without speccing it yet
argument-hint: <the idea or bug, in a sentence or two>
---

File this as a GitHub issue for later: **$ARGUMENTS**

1. If nothing was given, ask Yanni what the idea or bug is, in a sentence or two.
2. Check `gh issue list --state open --search "<key words>"` for an existing issue that already covers it. If one
   does, say so and add anything new as a comment instead of filing a duplicate.
3. Otherwise create it: a short title, and a body with what Yanni said in his words plus one line of context if it
   helps. Label `bug` if something is broken, otherwise `idea`.
   `gh issue create --title "..." --body "..." --label idea` (or `bug`).
4. Reply in one line: the issue number and title, and "spec it anytime with `/spec <n>`". Don't spec, plan or build it.
