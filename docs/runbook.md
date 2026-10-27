# Runbook: building ZOH with parallel agents

How a ticket goes from `docs/tickets/` to the live line. Short on purpose.

## The loop

1. **Pick** a ticket whose "Starts after" tickets are merged. Never run more than
   **3 builder sessions at once**, and never two tickets that own the same files.
2. **Start** a Claude Code session in the Claude desktop app (Code tab) on this repo, with its own
   worktree, and paste the ticket's "Prompt" block. One session per ticket.
3. **Build.** The agent follows `CLAUDE.md`, the ticket and the feature pages it names: branch
   `ticket/<id>-<slug>`, tests first or alongside, `npm run check` green.
4. **Judge** (tickets that change what ZOH says): run `npm run eval` for the feature once it exists
   (ticket T3) and paste the report summary into the PR.
5. **Hand off**: open a PR using the template. If `gh` isn't available, push the branch and give
   Yanni the "open a pull request" link.
6. **Review**: a fresh session (or the planning chat) reviews the PR against its ticket and feature
   page without having seen the build. Yanni reads the summary, the judgment report and the ideas.
7. **Merge** (squash) on GitHub. Railway deploys `main`. Yanni runs the page's live checklist on his
   phone; anything that goes wrong becomes a regression case (see `docs/features/template.md`).

## Rules for builder agents

- **Stay in your lane.** Each ticket lists the files it owns. Touch others only where the ticket
  says, and keep those edits small. Rebase on `main` before opening the PR.
- **One migration per ticket**, generated with `npm run db:generate`. If `main` gained a migration
  while you worked, rebase and regenerate yours; never edit an applied one.
- **Don't decide product questions.** If the page and the voice page are both silent, stop and ask
  in the session (or list it under "Questions" in the PR) instead of choosing.
- **Ideas beyond scope** go in the PR under "Ideas beyond scope" (what, why it helps the tester,
  size S/M/L, what it touches) for Yanni to mark Yes / Later / No. Don't build them.
- **Don't edit `docs/features/`.** If a page is wrong or unclear, say so in the PR.
- **Secrets:** never in code, commits, logs or the PR. Locally, `.env` (gitignored) holds
  `ANTHROPIC_API_KEY` for `npm run eval`; tests never need it.
- **Never text real people.** Tests and evals use fakes for Sendblue; nothing calls the live line.

## Status

| Ticket | What | Starts after | Owner session | PR | State |
| --- | --- | --- | --- | --- | --- |
| T1 | Testers, goals, stop and reset | — | | | ready |
| T2 | Coach engine and onboarding conversation | T1 | | | waiting |
| T3 | Coach judgment harness (simulate + grade) | — | | | ready |

Tonight: start **T1 and T3 together**; start **T2** as soon as T1 is merged. T2 runs the eval from T3
before handing off (if T3 isn't merged yet, T2 notes that and the eval runs as soon as it is).
