# Feature page template

Every feature in the launch plan's "What we build" table gets a page in this shape. Sections 1 to 10 describe the experience and decisions, which are Yanni's; section 11 is the technical note, which is Claude's. An agent building a feature reads its page, the Coach voice and principles page and the repo's CLAUDE.md before writing code, and treats the page as the spec: where the page is silent, it follows the voice page; where both are silent, it stops and asks instead of choosing.

## Sections

**Not every section applies to every feature.** A behind-the-scenes feature, like the data model or the scheduler, has no conversation to sketch or tone to judge, so it may only need What it is, Rules, Edge cases, Done means, Out of scope, Ideas and Technical notes. Write "Not applicable" with a one-line reason rather than deleting a section, so it's clear it was considered rather than forgotten.

1. **What it is.** One or two sentences, plus why it matters for the beta.
2. **The experience.** What the tester sees and feels, step by step, from their side of the phone.
3. **Example conversations.** Two or three short exchanges showing what good sounds like, and one or two showing what to avoid. These are the tone spec, and the agent tests against them.
4. **Rules.** Must and must-not, each one checkable: "one question per text", "never text during quiet hours".
5. **Edge cases.** What happens when the tester goes quiet, says no, goes off-topic, changes their mind or sends something unexpected.
6. **Done means.** Acceptance tests written in tester terms. Each becomes an automated test the agent must pass. Then a short live checklist for Yanni to try on his phone.
7. **Checking the coach's judgment.** For behavior a normal test can't check (tone, length, whether it asked the right thing), Claude runs simulated conversations and a separate Claude grades them:
   - **Simulate:** a tester-simulator plays each example conversation, plus personas listed on the page (terse, chatty, joking, confused, resistant), against the real coach.
   - **Grade independently:** a grader that has never seen the code or the builder's reasoning reads only the transcripts, this page's rules and the voice page, and scores every coach text pass or fail with a one-line reason.
   - **Report:** pass rate per rule and per persona, the three worst replies quoted, and what changed since the last run.
   - **Suggest live checks:** from the borderline and failed cases, the 3 to 5 things most worth Yanni trying on his own phone.
8. **Out of scope.** What not to build in this ticket, so the agent doesn't add its own ideas to the build.
9. **Ideas beyond scope.** Where the agent writes down improvements it noticed while building but did not build, for Yanni to accept, reject or save for later (see below).
10. **Open decisions.** Questions only Yanni can answer. The agent stops and asks rather than inventing an answer.
11. **Technical notes.** What the feature reads and writes, what it depends on, and anything the agent must not change. Optional reading for Yanni.

## How agents use it

- **Before building:** read the page, the voice page and CLAUDE.md; list any open decision that blocks the work and stop if one does.
- **While building:** write the "Done means" tests first or alongside the code; keep to the ticket; when an idea goes beyond it, write it down and keep going instead of building it.
- **Before handing back:** all tests green; run the simulated conversations and independent grading and include the report; list the suggested live checks; list any new ideas.

## Ideas beyond scope

Agents build only what the page asks for, but they often spot something that would make the experience better. Those ideas get captured, not built.

- **How it's written:** one entry per idea in the feature page's Ideas section and in the hand-off: what it is, why it would help the tester, roughly how big it is (small, medium, large), and what it would touch.
- **What Yanni does with it:** marks each one **Yes, add to this feature**, **Later** (moves to the backlog) or **No**.
- **What happens next:** a Yes becomes part of the page (experience, rules and Done means updated) and goes into a follow-up ticket; nothing beyond scope is built until it's marked Yes.

## When the coach goes off the rails

Every time the coach gets something wrong, whether caught by the grader, by Yanni live or by a tester in the beta, the fix has to stop it happening again, not just this once.

1. **Capture it:** save the exchange that went wrong, with what should have happened instead.
2. **Fix it at the source:** change the coach's instructions or logic in the one place they live in the code, and update the matching rule or example on the voice page or feature page so the spec and the code agree.
3. **Lock it in:** add the exchange to the simulated-conversation suite as a permanent regression case, and to the page's "avoid" examples if it shows a new kind of mistake.
4. **Prove it:** rerun the full suite, not just the new case, so the fix doesn't break something else, then commit and deploy as usual.

**Keep the coach's instructions lean.** A longer prompt makes the coach slower, costlier and less predictable, so fixes go in as efficiently as possible:

- **Sharpen before adding.** First reword an existing rule or principle so it covers the new case; add a new line only when no existing one can.
- **Fix the cause, not the instance.** One general rule ("never guess what a photo shows") beats a list of specific cases.
- **Examples live in the test suite, not the prompt.** The prompt keeps only a handful of model exchanges; every failure case lives in the suite, where it costs nothing per message.
- **Set a budget and tidy up.** The coach's core instructions have a set length; when a fix would exceed it, merge or trim overlapping rules first, then rerun the full suite to show nothing regressed.
- **Show the change.** Each fix to the coach's instructions is reported as a short before-and-after with the suite results.

Over the beta, the suite grows from the examples on these pages into a record of every mistake the coach has made and no longer makes. Changes that touch the coach's voice for every feature are flagged for Yanni before they ship.
