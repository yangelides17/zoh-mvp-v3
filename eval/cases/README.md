# Regression cases

Every time ZOH gets something wrong (caught by the grader, by Yanni live, or by a beta tester), the
exchange goes here so the fix stays fixed. `npm run eval -- <feature>` replays **every** case in
`eval/cases/<feature>/` on every run and grades it alongside the simulated conversations.

A case scripts the tester's side only. ZOH's replies are generated fresh by the current coach each
run, then the grader checks them against the feature's checks **and** against `shouldHaveHappened`
(reported as the `regression` rule).

## Format

One JSON file per case, in `eval/cases/<feature>/`. Files replay in file-name order, so prefix them
with a number (`001-…`, `002-…`). Each tester line is sent as its own text, and the runner waits for
ZOH's reply before sending the next one.

```json
{
  "id": "form-in-disguise",
  "title": "Welcome text reads like a form",
  "origin": "Where it came from: grader run, Yanni live on Oct 28, beta tester…",
  "testerLines": ["Start", "Alex. Exercise, wanna get back to the gym"],
  "whatWentWrong": "What ZOH said that was wrong, quoted.",
  "shouldHaveHappened": "What a good reply does instead, in plain words the grader can check.",
  "areaCode": "212",
  "startTime": "18:30",
  "timeZone": "America/New_York"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase, dashes. Stable: the report compares runs by it. |
| `title` | yes | One line for the report. |
| `origin` | yes | Where the mistake was seen. |
| `testerLines` | yes | The tester's texts, in order. Keep only what's needed to reproduce it. |
| `whatWentWrong` | yes | The bad reply, quoted, so the history stays readable. |
| `shouldHaveHappened` | yes | What the grader checks the fresh replies against. |
| `areaCode` | no | Area code of the fake number (default `212`, Eastern). Use a non-Eastern one for time zone cases. |
| `startTime` | no | Local time of the first text, `HH:MM` (default `18:30`). |
| `startDay` | no | Weekday of the first text in the eval's week (`mon` to `sun`, default `mon`): the Sunday look-back cases start on `sun`. Seeded `days_ago` count back from it. |
| `timeZone` | no | IANA zone for `startTime` (default `America/New_York`). |
| `persona` | no | Which persona it belongs to in the per-persona table (default: its own "scripted" row). |
| `facts` | no | What's true about the tester, for the replies they send while a line waits (#230). Never shown to ZOH or the grader. |
| `suite` | no | `regression` (default: should keep passing; a drop is flagged), `capability` (a new feature's own case; graduates once it passes every run) or `replay` (a real tester conversation; reported apart, never tuned against). See `eval/README.md` (#197). |

## Lines that wait for their moment (#230)

A plain line is sent as written, in order, whatever ZOH just said. A line that answers ZOH waits for the moment it
fits instead, so it never lands after a text it doesn't answer:

```json
{ "say": "probably looking down at my left hand too early", "means": "it's looking down early, not speeding up",
  "when": "after ZOH asks what makes the jump go wrong", "length": "short" }
```

| Field | Meaning |
| --- | --- |
| `say` | The wording. Sent word for word when ZOH's latest text fits it. |
| `when` | The moment it answers, named by what ZOH does ("after ZOH asks…", "after ZOH proposes…"). Required, unless `starts`. |
| `means` | Its point. Required for an anchored line (the default). |
| `length` | `thin` (1 to 4 words), `short` (a sentence) or `full`. |
| `fixed` | `true`: word for word or not at all; never changed or skipped (when the exact words are the test, and for agreements). |
| `optional` | `true`: only applies if ZOH asks for it, so it's dropped when ZOH moves past it. |
| `expected` | `true`: its moment is what the case expects ZOH to reach (a proposal, the week talk). If ZOH never gets there, that's ZOH's miss. |
| `starts` | `true`: the tester's own move (texting first, the next part of a story, raising something new), sent as written. |

Before each such line, one call to the simulated tester (`EVAL_SIM_MODEL`) decides, with a one-sentence reason that
the report shows: the tester's own earlier texts **already said** it (skipped), it **fits** (the wording itself is
sent), it's **close** (ZOH asked for this very point in other words; a second call changes the wording just enough,
carrying only its point), **passed** (optional lines only: ZOH moved on, or is already at the next line's moment,
which the decision sees) or **not yet** (a second call replies to just what ZOH
asked, from the case's `facts`, without seeing the line, and never proposes, agrees to or decides anything).
After 2 extra replies on one line, or 4 in the case, the run ends: an `expected` line is **ZOH's miss**, graded as
usual; any other is a **case problem**, graded for a look but kept out of every score. An empty reply is a case
problem too. Every run is graded, so no ZOH mistake is hidden.

**Writing cases.** The test is fair when what's tested is what's actually tested; small invented details from the
tester are fine if they're plausible and change nothing (Yanni, Nov 21).
- Anchor only the tester's answers to ZOH and agreements. The tester's own moves are `starts`.
- When the tester raises something themselves (an obstacle, a second request), put it in a text they're already
  sending, or send several texts back to back (`+++`), never as a line waiting for a question ZOH may not ask.
- A `when` names something ZOH does, never "after ZOH does the right thing": a line waiting on ZOH's good behavior
  turns ZOH's mistake into a case problem. Where the case does expect ZOH to get somewhere, mark the line `expected`.
- Agreements ("works", "sounds good") are `fixed` and `expected`.
- A line that only makes sense if ZOH asks for it is `optional`.
- `facts` are what's true about the tester, for questions the lines don't cover. No fact may hold the answer ZOH
  is meant to come up with.
- The case ends at the moment it tests, with a line there.
- Actions (`advance to`, `console …`), commands and photos stay plain lines.
- A reply to ZOH's first text, or to a text ZOH starts after `advance to` (the welcome, a kickoff), may stay plain
  when it fits any reply ZOH is likely to send there. Everywhere else, a line that answers ZOH waits for its moment
  (`npm run check` enforces it).

## Adding one

1. Copy the exchange (tester lines, and ZOH's bad reply into `whatWentWrong`).
2. Write `shouldHaveHappened` as something checkable ("asks one question", "doesn't ask for the
   time again"), not "be better".
3. Run `npm run eval -- <feature>` before and after the fix and put both summaries in the PR.
