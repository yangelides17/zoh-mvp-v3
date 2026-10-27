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
| `timeZone` | no | IANA zone for `startTime` (default `America/New_York`). |
| `persona` | no | Which persona it belongs to in the per-persona table (default: its own "scripted" row). |

## Adding one

1. Copy the exchange (tester lines, and ZOH's bad reply into `whatWentWrong`).
2. Write `shouldHaveHappened` as something checkable ("asks one question", "doesn't ask for the
   time again"), not "be better".
3. Run `npm run eval -- <feature>` before and after the fix and put both summaries in the PR.
