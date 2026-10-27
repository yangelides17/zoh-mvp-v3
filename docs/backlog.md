# Backlog (not in the MVP build)

- **Video:** analyze and transcribe short videos (up to ~1–2 minutes): audio track through
  Speaches, a few frames to Claude. Raised October 26, 2026.
- **Message batching:** a photo plus a caption arrive as two webhooks and currently get two
  replies; wait briefly and answer them together.
- **Typing indicator timing:** consider holding the bubble a minimum time, or only sending it
  when a reply will take longer than ~2 s.
- **Testers naming their own coach** (from the launch plan).
- **Goal exploration:** people often don't know what they want until they try it ("read more"
  was really "be more interesting in conversations"). Make refining or discovering the real goal
  feel natural over time. The MVP only supports plan tweaks and switching goals within the
  starting list. Raised October 26, 2026.

## From the Oct 26 build (T1 to T3), waiting on Yanni: Yes / Later / No

- **Optional onboarding questions:** onboarding ends as soon as the required answers are in, so
  optional ones (where someone reads) are often skipped. Ask them before finishing? (T2)
- **City before finishing:** when a number is outside Eastern, make the city a required answer
  so onboarding can't end without it. (T2)
- **Recap accuracy:** the recap sometimes adds details the tester never gave ("at home").
  Improved, not solved; tighten and add a regression case. (T2)
- **Refusal fallback:** if Claude refuses or returns nothing, try once more (or another model)
  instead of sending "Got it". (T2)
- **Goal changes after onboarding:** refused until plans ship; answers can still change. (T2 decision)
- **First text when the goal is already named:** skips the goal list (matches the Maya example).
  (T2 decision)
- **Repeated "stop":** a stopped tester who texts "stop" again gets the confirmation again. (T1 decision)
- **Eval:** re-run the full onboarding suite on the corrected rubric for honest numbers (~$2);
  skip whole-conversation rules for short regression scripts. (T2, T3)
- **Cleanup:** `CLAUDE_HISTORY_LIMIT` is no longer used; remove it from config. (T2)
