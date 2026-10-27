#!/usr/bin/env bash
# One-time GitHub setup for the issue-based workflow (see CLAUDE.md, "How we build").
# Creates the status labels, files the remaining launch-plan features and the backlog as issues,
# and records onboarding (already built) as a closed issue holding its spec.
# Safe to rerun: labels are updated in place and issues that already exist (same title) are skipped.
# Needs: gh installed and logged in (gh auth login), run from the repo root.
set -euo pipefail

command -v gh >/dev/null || { echo "Install the GitHub CLI first: brew install gh, then gh auth login"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Log in first: gh auth login"; exit 1; }

label() { gh label create "$1" --color "$2" --description "$3" --force >/dev/null && echo "label: $1"; }
label idea          ededed "Not specced yet"
label spec-approved c5def5 "Spec approved by Yanni; next: /plan"
label plan-approved bfd4f2 "Plan approved; next: /build"
label building      fbca04 "An agent is building it"
label in-review     d93f0b "PR ready; next: /review"
label live-check    0e8a16 "Merged; Yanni tries it on his phone"
label done          5319e7 "Built, merged and checked live"
label decide        f9d0c4 "Needs Yanni: Yes / Later / No"
label bug           b60205 "Something's broken"

existing="$(gh issue list --state all --limit 500 --json title --jq '.[].title')"
issue() { # title label body
  if grep -Fxq "$1" <<<"$existing"; then echo "skip (exists): $1"; return; fi
  gh issue create --title "$1" --label "$2" --body "$3" >/dev/null && echo "issue: $1"
}

# Already built: onboarding, with its spec, closed.
if ! grep -Fxq "Onboarding by text" <<<"$existing"; then
  url="$(gh issue create --title "Onboarding by text" --label done --body-file scripts/seed/04-onboarding.md)"
  gh issue close "$url" --comment "Built in PRs #1-#3 (Oct 26-27) and checked live by Yanni." >/dev/null
  echo "issue (closed): Onboarding by text"
fi

# Remaining launch-plan features (from the "What we build" table).
issue "Plan agreement" idea "Coach proposes where, when and what with a reason, setup step first; tester agrees; the plan locks and starts right away, and is flagged for our review in the background. Includes suggesting how each day's step is shown (photo, screenshot, voice), using what onboarding learned about how they already track it. Launch plan #5."
issue "Nudge scheduler" idea "Morning kickoff, step-time check-in, nightly 'did you do it?', follow-ups by pushiness, quiet hours; cancels once the step is done. Also the mid-onboarding nudges (3 hours, then daily, stop after 3 days). Launch plan #6."
issue "Photo and voice verification" idea "Photos: a private copy, and Claude checks it against the step. Voice notes: transcribed, Claude checks the transcript, we keep the text and delete the audio. Verified, or unclear and sent to us. Launch plan #7."
issue "Coach memory" idea "Every coach call gets a context pack (profile, goal and plan, recent steps, a running summary, recent messages) plus read tools for the rest; the coach saves notes as it learns things; summaries refresh nightly. Replaces onboarding's whole-conversation stopgap. Launch plan #8."
issue "Step log and next step" idea "Verified, self-reported or missed each day; coach evaluates and proposes the next step; moving up waits for our OK. Launch plan #9."
issue "Founder console" idea "Testers, conversations, plans to review, step log with photos, send as the coach, pause a tester. Also where flags (off-list goals) and notifications land. Launch plan #10."
issue "Memes (nice to have)" idea "An existing meme source (like GIPHY's API); simple rules for when to send one. Only if there's time. Launch plan #11."
issue "Commands and safety" idea "'Pause', 'gentler', 'pushier', 'feedback: ...'; a fallback message and an alert to us if something fails; founder notifications for opt-outs. Launch plan #12."
issue "Metrics" idea "Steps verified per person per week, days with a step, retention, progression, and mute, back-off or quit requests, with our test accounts left out. Launch plan #13."
issue "Test mode" idea "Runs a day of nudges in about an hour, for the internal test. Launch plan #14."

# Backlog ideas (not in the MVP build).
issue "Video notes" idea "Analyze and transcribe short videos (up to ~1-2 minutes): audio through Speaches, a few frames to Claude."
issue "Batch back-to-back texts" idea "A photo plus a caption arrive as two webhooks and get two replies; wait briefly and answer them together."
issue "Typing indicator timing" idea "Hold the bubble a minimum time, or only send it when a reply will take longer than ~2 s."
issue "Testers name their own coach" idea "From the launch plan."
issue "Goal exploration" idea "People often don't know what they want until they try it ('read more' was really 'be more interesting in conversations'). Make refining or discovering the real goal feel natural over time."

# Follow-ups from the Oct 26 build, waiting on Yanni's Yes / Later / No.
issue "Ask optional onboarding questions before finishing?" decide "Onboarding ends as soon as the required answers are in, so optional ones (where someone reads) are often skipped."
issue "Require the city before onboarding ends (non-Eastern numbers)" decide "When a number is outside Eastern, make the city a required answer so onboarding can't end without it."
issue "Recap adds details the tester never gave" bug "The onboarding recap sometimes adds details ('at home'). Improved in T2, not solved. Tighten the instruction and add a regression case."
issue "Retry instead of 'Got it' when Claude returns nothing" decide "If Claude refuses or returns no text, try once more (or another model) instead of sending the 'Got it' fallback."
issue "Confirm: goal can't change after onboarding (until plans ship)" decide "T2 decision: goal changes are refused once onboarding is done; answers like time or place can still change."
issue "Confirm: a goal named in the first text skips the goal list" decide "T2 decision, matching the Maya example."
issue "Remove the unused CLAUDE_HISTORY_LIMIT setting" idea "No longer used since the coach sees the whole conversation. Small cleanup."

echo "Done. Ask Claude for /status to see the board."
