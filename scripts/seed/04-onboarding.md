# Feature 4: Onboarding by text

A new tester texts "Start" and, in a short natural conversation, ZOH learns everything it needs to build their first plan: what they'll do, where, when and for how long. The moment onboarding ends, the plan is proposed. It's the first impression of the product, so it has to feel like a coach who's glad they showed up, not a form.

## 1. What it is

A coach-led conversation: introduction, goal pick, then the questions that shape the plan, tailored to the goal they picked. It ends by handing off to plan agreement (feature 5), which proposes the plan right away and is where the tester makes the commitment ZOH will hold them to. It sets the tone from the first text, at the Pushy default on the voice page.

## 2. The experience

1. The tester texts "Start" (or anything) to the ZOH number.
2. ZOH introduces itself in one text, with energy: who it is, that it'll text them every day to help them start one thing and stick with it, and that they can text "stop" anytime. In the same text it shows the starting goals, one per line, and asks their name and what they're looking to work on. If they skip their name, that's fine; ZOH saves it whenever they mention it.
3. ZOH learns what the plan needs through a naturally flowing conversation, not a fixed list of questions. Any questions that fit the goal and the person are fine, one at a time, as long as by the end ZOH knows whichever of these apply, plus, where it fits the goal, whether they already track it somewhere (an app, a wearable, a journal):
   - **What:** have they done this before, what did they do, and what do they actually like doing? What do they want to do?
   - **Where:** where will they do it (where do they want to do it), and what do they have access to? (No gym membership: get one, or work out at home?)
   - **When:** which days and times realistically fit their schedule?
   - **How long:** how much time do they want to spend, and how much do they actually have? If what they want needs more time than they have, ZOH says so and they agree on something realistic.
4. ZOH tells them they can change how it coaches anytime just by telling it ("chill out", "fewer emojis", "push me harder").
5. A one-line recap, then straight into the plan proposal (feature 5). Until the plan feature ships on Tuesday, the recap ends with a fun, excited line that the plan is on its way (something like "Your plan is buffering… this is a great start. Ready shortly 🔥"), and ZOH waits there.

Not asked: wake and sleep times (unless the goal is bedtime) and how pushy to be. It should take about 6 to 12 texts and under five minutes. If the tester answers several things at once ("home, mornings, like 20 minutes"), ZOH takes all of it and skips those questions.

**Quiet hours:** 10 pm to 9 am by default, and a tester can change them to whatever they prefer just by asking. ZOH never sends scheduled or unprompted texts then, including onboarding nudges, but it always replies when the tester texts, at any hour.

**Starting goals.** General titles on purpose: the onboarding conversation narrows each one down to a specific plan.

| Goal | What it can look like |
| --- | --- |
| Daily reading | Pages or minutes of a book |
| Daily exercise | Gym, home workout, walk or run, a sport |
| Daily nutrition | A calorie or protein target for the day |
| Daily reflection and planning | Journaling, a nightly reflection, or planning tomorrow |
| Daily deep work target | A set amount of focused, distraction-free work each day |
| Same bedtime every night | In bed, lights out, at the agreed time (wake time not a goal for now) |
| Something else | Accepted only if it's close to a goal above and ZOH is confident it can coach and check it |

How they'll show each day's step isn't fixed per goal. The plan (feature 5) suggests the best way for this person, based on what onboarding learned, including anything they already use to track it.

## 3. Example conversations

**Good: the gym**

> **Alex:** Start
>
> **ZOH:** Yo! I'm ZOH. I'm gonna text you every day to help you start one thing and actually stick with it. Text "stop" anytime. What's your name, and what are you looking to work on?\
• Daily reading\
• Daily exercise\
• Daily nutrition\
• Daily reflection and planning\
• Daily deep work target\
• Same bedtime every night\
• Something else
>
> **Alex:** Alex. Exercise, wanna get back to the gym
>
> **ZOH:** Let's go, Alex. Have you worked out at a gym before, and if so, what did you usually do?
>
> **Alex:** used to lift in college, haven't been in like 2 years
>
> **ZOH:** Back at it then 💪 Do you have a gym membership now, or somewhere you can work out?
>
> **Alex:** no membership. I have some dumbbells at home
>
> **ZOH:** Works. Want to start at home with the dumbbells, or get a membership?
>
> **Alex:** home for now
>
> **ZOH:** Smart. When are you usually free to get a workout in?
>
> **Alex:** mornings before work, like 7:30
>
> **ZOH:** And how much time can you give it then?
>
> **Alex:** 20 min tops
>
> **ZOH:** 20 minutes of dumbbells is plenty to get going. You can change how I coach you anytime, just tell me. Here's what I'm thinking for your plan…

**Good: they answer several things at once**

> **Maya:** hi! I'm Maya, I want to journal every morning at home before work, maybe 10 min
>
> **ZOH:** Maya! I'm ZOH. Journaling every morning, love it. Have you journaled before, or is this brand new?

**Good: the reality check**

> **Sam:** I want to read for an hour every night
>
> **ZOH:** Love the ambition. Earlier you said you've got about 20 minutes free at night. Want to start with 20 and build up from there?

**Avoid: a form in disguise**

> **ZOH:** Welcome to ZOH! To get started, please answer the following: 1. Your name 2. Your goal 3. Your schedule 4. Your location 5. Your available time

**Avoid: drifting off the onboarding**

> **Sam:** what's the best book to start with?
>
> **ZOH:** Great question! It depends on your interests. For fiction, many people love… *(three paragraphs)*

Instead, a short answer and back on track: "Depends what you're into. We'll pick one together in your plan. Quick one first: when are you usually free to read?"

## 4. Rules

- Everything on the voice page applies; these rules add to it.
- One question per text (the first text is the exception, asking name and goal together), and usually one text per reply (two at most).
- The first text always says it's ZOH, what it does, and that "stop" works anytime.
- No fixed script: the conversation flows naturally and the questions fit the goal and the person, as long as it ends knowing what, where, when and how long, wherever those apply.
- Never asks again for something already given, even if said early or in passing.
- If what they want doesn't fit the time or resources they have, ZOH says so and agrees something realistic before the plan.
- When it applies (exercise, nutrition, bedtime, deep work), ZOH asks once whether they already track it, like a fitness app, a wearable, a food tracker or a focus timer. It doesn't ask for goals where it wouldn't make sense, and it doesn't settle how they'll show their steps; the plan suggests that.
- The goal comes from the starting list. "Something else" goes ahead only if it's close to a listed goal and ZOH is confident it can coach and check it; otherwise ZOH says plainly it can't help with that one yet, asks if they'd like to try something on the list, and flags the request for the founders. Strict for now, widened as we learn.
- Doesn't ask wake or sleep times unless the goal is bedtime (then it asks what time they want to be in bed, and what usually keeps them up), and doesn't ask how pushy to be. Asks what city they're in only when their number's area code is outside Eastern Time; otherwise assumes Eastern.
- Questions about their goal get a short answer, then ZOH goes back to the next onboarding question; the longer-answer exception on the voice page applies after onboarding.
- Onboarding isn't done until the goal and every plan question that applies are answered; the plan proposal never starts before that.

## 5. Edge cases

- **They go quiet mid-onboarding:** a nudge after 3 hours, then one text a day picking up where they left off, never during quiet hours. After 3 days with no reply, ZOH stops texting them automatically and the founders are notified to decide whether to follow up themselves. Not built today: these nudges come with the nudge scheduler (feature 6) on Tuesday.
- **They text late at night:** ZOH replies normally; quiet hours only stop texts ZOH starts.
- **They text "stop":** reply "Thank you very much. Noted. We will stop sending you messages.", say nothing more until they text again, with no founder notification for now (we can see it in Sendblue). Any other way of opting out ("unsubscribe", "leave me alone", "I'm done with this") is treated the same.
- **They give style feedback ("chill out", "no emojis"):** confirm in one line, save it, and continue in the new style.
- **They want a goal not on the list:** if it's close to a listed goal and ZOH can coach and check it, go ahead; otherwise say it can't help with that one yet, offer the list, and flag the request for the founders.
- **Vague answers ("whenever", "a while"):** ask once for something concrete; if still vague, use a sensible default in the plan and say they can change it.
- **They don't have what the goal needs (no gym):** offer a version that works with what they have (at home, a walk, bodyweight).
- **They send a photo or voice note:** respond to it naturally, then continue where onboarding left off.
- **They change an answer later ("actually make it walking"):** update it, confirm, and continue.
- **Someone not on the allowlist texts:** no reply (current behavior), stored for the founders.

## 6. Done means

Automated tests (scripted conversations against a stubbed coach, plus the real coach in the judgment check):

- [ ] A first text creates the tester and gets the introduction with the "stop" line, the goal list, and the name-and-goal question.
- [ ] For each starting goal, onboarding gathers what, where, when and how long wherever they apply, then hands off to the plan proposal.
- [ ] Where it applies, ZOH asks whether they already track the goal somewhere, and the answer is saved for the plan.
- [ ] Answering several things in one text saves all of them and skips those questions; nothing is asked twice.
- [ ] Asking for more time than they said they have triggers the reality check.
- [ ] No wake, sleep or pushiness questions (except bedtime questions for the bedtime goal); a time zone question only for numbers outside Eastern Time.
- [ ] Plan proposal starts only once every applicable plan question is answered.
- [ ] "stop", or any other opt-out, sets the tester to stopped, sends exactly one confirmation ("Thank you very much. Noted. We will stop sending you messages.") and nothing after it.
- [ ] Style feedback during onboarding is saved and the next texts follow it.
- [ ] From Tuesday (nudge scheduler): silence produces a nudge after 3 hours, then one text a day; after 3 days, automatic texts stop and the founders are notified. Nothing is sent between 10 pm and 9 am.
- [ ] A text from the tester at 11 pm gets a reply.
- [ ] A "something else" goal close to the list goes ahead; anything else gets a plain no, the list again, and a founder flag.
- [ ] "reset" from a dev account (Yanni or Stamati) starts onboarding from scratch with nothing remembered; from anyone else it's an ordinary message.
- [ ] Finishing onboarding today ends with the recap and the "plan is coming" line, then ZOH waits.

Live checklist for Yanni (the Monday bar from the plan):

- [ ] Onboard from your phone with the gym goal through to the plan proposal, and see every answer saved correctly in the database.
- [ ] Onboard again answering several things in one text.
- [ ] Ask for more time than you said you have, and check ZOH pushes back.
- [ ] Text after 10 pm and get a reply.
- [ ] Text "stop" mid-way and confirm ZOH goes quiet.

## 7. Checking the coach's judgment

A tester-simulator plays the example conversations above, plus 5 personas (terse, chatty, joking, confused, answers-everything-at-once), across several starting goals, against the real coach. An independent grader that sees only the transcripts, the rules in section 4 and the voice page scores every ZOH text: questions that fit the goal, one question per text, no repeats, the reality check when needed, Pushy-level energy without overfamiliarity, no invented facts. The report gives pass rates, the three worst replies and 3 to 5 suggested live checks for Yanni; target is every rule passing on every persona.

## 8. Out of scope

- Writing, proposing and agreeing the plan (feature 5); onboarding collects the inputs and hands off.
- Scheduling nudges beyond the mid-onboarding follow-ups above (feature 6).
- Founder console views (feature 10); flags are stored and visible there later.
- Deeper "why" conversations and open-ended goal exploration (backlog).
- Letting testers name their coach (backlog).

## 9. Ideas beyond scope

None yet. The building agent adds ideas here for Yanni to mark Yes, Later or No.

## 10. Open decisions

None right now. How each goal's steps are shown moves to the plan (feature 5), which suggests a method from the onboarding answers.

Decided October 26: six goals (including the same bedtime every night; no wake-time goal for now) plus a strict "Something else", name asked in the first text but optional, time zone asked only for non-Eastern numbers, no "why" question for now, quiet hours 10 pm to 9 am and changeable on request.

## 11. Technical notes

- New tables (draft, finalized on the data and memory page): `testers` (phone, name, phase, time zone, quiet hours defaulting to 10 pm to 9 am, pushiness defaulting to pushy, style notes, test-user flag, consent time) and `goals` (the starting list, each with its plan questions) plus a saved "already tracks it with" answer when one was asked.
- Onboarding answers are saved as structured plan inputs (what, where, when, how long) that feature 5 turns into the plan.
- The coach gets the voice page's instructions, a short onboarding block, the goal's plan questions and which ones are still unanswered, and saves answers through tools; the app, not the model, decides when onboarding is complete.
- **Memory for now (the full coach memory, feature 8, comes Tuesday):** every coach call during onboarding gets the whole conversation since the tester's first text, not just the last 12 messages, plus a short block of what's been saved so far (name, goal, answers, time zone, quiet hours). An onboarding conversation is a few dozen short texts, so this fits easily. That's enough for ZOH never to re-ask something already answered and to pick up exactly where a tester left off. Feature 8 replaces it with summaries and read tools.
- **Reset for dev accounts:** our two numbers (Yanni and Stamati, marked as test users) can text "reset". It clears the tester profile, saved answers and goal, and hides earlier messages from the coach's context (they stay in the database for us), then ZOH starts onboarding fresh with its first text. Ignored for every other number.
- **Built today vs later:** no nudges (feature 6, Tuesday) and no founder notifications of any kind yet; off-list goal requests and other flags are just saved, and how we get notified is decided with the console and commands (features 10 and 12). "Stop" and other opt-outs work today.
- Quiet hours are enforced by the scheduler for texts ZOH starts; replies to the tester are never held back.
- Phase moves `onboarding → planning` when every applicable plan input is saved.
- Depends on: data model, coach engine (tool loop and context pack), nudge scheduler for the mid-onboarding follow-ups.
