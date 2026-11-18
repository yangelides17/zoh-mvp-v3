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

A plain line is sent as written, in order, whatever ZOH just said. A line that answers ZOH can instead wait for the
moment it fits, so it never lands after a text it doesn't answer:

```json
{ "say": "probably looking down at my left hand too early", "means": "it's looking down early, not speeding up",
  "when": "after ZOH asks what causes the jump to go wrong", "length": "short" }
```

| Field | Meaning |
| --- | --- |
| `say` | The wording. Sent word for word when ZOH's latest text fits it. |
| `when` | The moment in ZOH's texts it answers. Required, unless `starts`. |
| `means` | What it must get across. Required for an anchored line (the default). |
| `length` | `thin` (1 to 4 words), `short` (a sentence) or `full`. |
| `fixed` | `true`: word for word or not at all, never changed to fit (when the exact words are the test). |
| `lead` | `false`: while it waits, the tester doesn't steer toward it (the case tests whether ZOH gets there itself). |
| `starts` | `true`: the tester starts a new exchange (texting first), so it's sent without waiting. |

Before each such line, the simulated tester (`EVAL_SIM_MODEL`) reads the conversation and decides: it **fits**
(the wording is sent), it's **close** (the wording changed as little as possible to answer what ZOH actually said;
never for a fixed line) or **not yet** (a natural reply from the case's `facts`, leading toward the line unless
`lead` is off). After 2 extra replies on one line, or 4 in the case, the run stops as a **case problem**: not
graded, listed in the report's "Case problems" with the line that never fit. The report counts lines sent word for
word, changed to fit and the extra replies. Actions (`advance to`, `console …`), commands and photos stay plain lines.

## Adding one

1. Copy the exchange (tester lines, and ZOH's bad reply into `whatWentWrong`).
2. Write `shouldHaveHappened` as something checkable ("asks one question", "doesn't ask for the
   time again"), not "be better".
3. Run `npm run eval -- <feature>` before and after the fix and put both summaries in the PR.
