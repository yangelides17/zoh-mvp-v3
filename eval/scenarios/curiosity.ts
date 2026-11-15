import type { ScenarioInput } from "../types.js";

const EASTERN = "America/New_York";

/**
 * Curious by default (#157): the multi-turn moments, played by a simulated tester so the answers fit whatever ZOH
 * asks. Single moments are scripted cases in eval/cases/curiosity/.
 */
export const curiosityScenarios: ScenarioInput[] = [
  {
    id: "vague-onboarding",
    title: "Too fast: a vague goal in onboarding gets dug into before the plan",
    source: "#157 spec: Watch (\"I just want to be less of a mess\")",
    persona: "terse",
    goal: "deep_work",
    intent: "Feel less scattered day to day; doesn't have words for it at first.",
    opening: "hey",
    areaCode: "212",
    startTime: "19:00",
    timeZone: EASTERN,
    maxTurns: 16,
    directions: [
      "When asked what you want to work on, say only \"I just want to be less of a mess\". Explain more only when ZOH asks about something specific or a real moment (like yesterday or last night); a general question gets another vague answer like \"idk just everything\".",
      "If asked about a real moment, tell it: last night you opened your laptop to finish a work thing at 8, ended up on YouTube till 11 and went to bed annoyed.",
    ],
    facts: {
      name: "Jordan",
      goal: "Focus: stop losing evenings to the phone and YouTube",
      experience: "Has tried app blockers, deleted them after a day",
      schedule: "Evenings after dinner, around 8",
      timeAvailable: "About 30 minutes",
      tracksWith: "Nothing",
    },
  },
  {
    id: "long-onboarding",
    title: "Too slow: a chatty tester who volunteers stories still reaches the plan",
    source: "#157 spec: new eval cases (a long onboarding that should reach the plan)",
    persona: "chatty",
    goal: "reading",
    intent: "Read more fiction again, like they did as a kid.",
    opening: "hi!! a friend told me about you",
    areaCode: "212",
    startTime: "20:00",
    timeZone: EASTERN,
    maxTurns: 20,
    directions: [
      "Answer every question, but add a side story each time (a book you loved at 12, your commute, your cat knocking over your tea). Never refuse to answer.",
    ],
    facts: {
      name: "Priya",
      goal: "Reading: get back to reading fiction",
      experience: "Read constantly as a kid, maybe two books in the last year",
      schedule: "On the train to work, 8:15",
      timeAvailable: "About 25 minutes",
      tracksWith: "Goodreads, sometimes",
    },
  },
  // ---- Harder cases (Nov 14): the easy move is the wrong one ----
  {
    id: "mixed-signals",
    title: "Hard: \"fine I guess\" while clearly frustrated: understanding first, never a guess-menu or a quick step",
    source: "#157 sharpened suite: mixed signals",
    persona: "terse",
    goal: "reading",
    intent: "Did the reading but is annoyed about how the evening went.",
    opening: "[voice: done. read the chapter. fine I guess]",
    areaCode: "212",
    startTime: "20:40",
    timeZone: EASTERN,
    maxTurns: 7,
    seed: readingSeed("Maya", "Chapter 6 of Atomic Habits on the couch at 8 pm (about 20 min)"),
    directions: [
      "You're frustrated: your partner kept talking to you through the whole chapter and you barely took it in. Don't say so unless ZOH asks an open, warm question about how it went; a menu of guesses (\"was it X or Y?\") gets \"idk, one of those\".",
      "If ZOH proposes tomorrow's step before you've said what happened, reply \"sure\" flatly.",
    ],
    facts: { name: "Maya", goal: "Reading", schedule: "8 pm on the couch", timeAvailable: "20 minutes", other: "Partner talks to her while she reads; she hasn't asked for quiet time" },
  },
  {
    id: "buried-worry",
    title: "Hard: a worry buried in the middle of a long, upbeat voice note gets followed up, not skipped for the positives",
    source: "#157 sharpened suite: buried worry",
    persona: "chatty",
    goal: "speak_connect",
    intent: "Did the step and is mostly excited, but has one real fear.",
    opening:
      "[voice: Okay so I did it! I said my point in the first two minutes of standup, my manager nodded, and Priya even followed up on it after. Honestly though I keep thinking people think I'm trying too hard now, like it's not really me. Anyway the coffee machine was broken again lol. But yeah, went way better than last week!]",
    areaCode: "212",
    startTime: "10:20",
    timeZone: EASTERN,
    maxTurns: 7,
    seed: speakingSeed(),
    directions: [
      "Your real concern is that people think you're trying too hard. Only talk about it if ZOH asks about it; if ZOH only celebrates or proposes tomorrow, go along cheerfully and never bring it up again.",
    ],
    facts: { name: "Lena", goal: "Speaking up in meetings", schedule: "10 am standup", timeAvailable: "15 minutes", other: "Worries colleagues see her as trying too hard" },
  },
  {
    id: "ramble-then-quiet",
    title: "Hard: a tester who rambles, then runs out: let them go warmly with the step, no more fishing",
    source: "#157 sharpened suite: rambles, then goes quiet",
    persona: "chatty",
    goal: "exercise",
    intent: "Says a lot at first, then has nothing more.",
    opening: "[voice: Done! 3 sets of push-ups and squats. Felt strong today]",
    areaCode: "212",
    startTime: "18:55",
    timeZone: EASTERN,
    maxTurns: 7,
    seed: exerciseSeed(),
    directions: [
      "To ZOH's first question, give a long, detailed answer (what felt easy, that squats felt better than push-ups, that you did them before dinner this time and it helped).",
      "After that you have nothing more: answer every further question with \"yeah\" or \"not really\". If ZOH proposes tomorrow's step, say \"ok\".",
    ],
    facts: { name: "Theo", goal: "Exercise", schedule: "6:30 pm in the living room", timeAvailable: "15 minutes" },
  },
  {
    id: "just-tell-me",
    title: "Hard: a tester who wants to be told what to do gets a clear step, not a round of questions",
    source: "#157 sharpened suite: pushes ZOH to just decide",
    persona: "resistant",
    goal: "reading",
    intent: "Busy, wants ZOH to decide.",
    opening: "[voice: done with chapter 6]",
    areaCode: "212",
    startTime: "20:30",
    timeZone: EASTERN,
    maxTurns: 6,
    seed: readingSeed("Sam", "Chapter 6 of Atomic Habits on the couch at 8 pm (about 20 min)"),
    directions: [
      "Answer ZOH's first question in a few words (\"went fine, interesting chapter\"). Then say \"honestly just tell me what to do tomorrow, I don't want to think about it\".",
      "If ZOH asks another question instead of telling you, get a bit short: \"can you just pick\".",
    ],
    facts: { name: "Sam", goal: "Reading", schedule: "8 pm on the couch", timeAvailable: "20 minutes" },
  },
  {
    id: "tiny-answers-hiding",
    title: "Hard: tiny answers that hide something real: an open question about the real moment draws it out",
    source: "#157 sharpened suite: tiny answers hide something",
    persona: "terse",
    goal: "exercise",
    intent: "Did only part of the step and is embarrassed about it.",
    opening: "[voice: done]",
    areaCode: "212",
    startTime: "19:10",
    timeZone: EASTERN,
    maxTurns: 7,
    seed: exerciseSeed(),
    directions: [
      "You only did one set of the three because your shoulder twinged. Answer general questions with \"ok\" or \"fine\". Say what really happened only if ZOH asks about the actual workout (what happened, how it went set by set, anything that felt off).",
    ],
    facts: { name: "Theo", goal: "Exercise", schedule: "6:30 pm in the living room", timeAvailable: "15 minutes", other: "Shoulder twinged in set 1; stopped after one set" },
  },
  {
    id: "onboarding-scared",
    title: "Hard: a fear mentioned mid-onboarding gets understanding before the next logistics question or the plan",
    source: "#157 sharpened suite: feelings in onboarding",
    persona: "confused",
    goal: "exercise",
    intent: "Doctor said to get active; a bit scared about it.",
    opening: "hi, my sister told me to try this",
    areaCode: "212",
    startTime: "19:30",
    timeZone: EASTERN,
    maxTurns: 16,
    directions: [
      "When asked what you want to work on, say \"my doctor told me I need to start exercising, honestly it kind of scared me\". Answer the rest plainly. If ZOH acknowledges the fear and asks about it, say your blood pressure was high and you're worried you'll overdo it.",
    ],
    facts: {
      name: "Dana",
      goal: "Exercise: start walking, doctor's advice",
      experience: "Hasn't exercised in years",
      schedule: "After work, around 6",
      timeAvailable: "20 minutes",
      tracksWith: "Nothing",
    },
  },
];

/** An active reader a few days in, with today's step agreed ahead (the seed every reading case uses). */
function readingSeed(name: string, today: string): ScenarioInput["seed"] {
  return {
    name,
    goal: "reading",
    phase: "active",
    history_hours_ago: 2,
    answers: { what: "Atomic Habits", where: "on the couch", when: "8 pm", how_long: "20 min" },
    history: [
      { from: "zoh", text: `Chapter 6 tonight, ${name}: 8 pm on the couch, about 20 minutes. Then a quick voice recap.` },
      { from: "tester", text: "yep" },
    ],
    plan: {
      step: "Read chapter 1 of Atomic Habits on the couch",
      place: "on the couch",
      time: "20:00",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      proof: "voice",
      proof_note: "a short voice recap of what you read",
      reason: "Putting it in your own words is what makes it stick.",
      minutes: 20,
      started_days_ago: 5,
    },
    step_days: [
      { days_ago: 2, status: "done", step: "Chapter 4 of Atomic Habits on the couch" },
      { days_ago: 1, status: "done", step: "Chapter 5 of Atomic Habits on the couch" },
    ],
    today_step: { step: today, agreed_hours_ago: 2 },
  } as ScenarioInput["seed"];
}

function exerciseSeed(): ScenarioInput["seed"] {
  return {
    name: "Theo",
    goal: "exercise",
    phase: "active",
    history_hours_ago: 1,
    answers: { what: "push-ups and squats", where: "living room", when: "6:30 pm", how_long: "15 min" },
    history: [
      { from: "zoh", text: "Starts in 10, Theo! 3 sets of 8 push-ups and 12 squats in the living room at 6:30." },
      { from: "tester", text: "ok" },
    ],
    plan: {
      step: "3 sets of 6 push-ups and 10 squats in the living room",
      place: "living room",
      time: "18:30",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      proof: "voice",
      proof_note: "a quick voice note saying what you did",
      reason: "Short sets every day build the base before anything harder.",
      minutes: 15,
      started_days_ago: 4,
    },
    step_days: [
      { days_ago: 2, status: "done", step: "3 sets of 7 push-ups and 10 squats in the living room" },
      { days_ago: 1, status: "done", step: "3 sets of 8 push-ups and 12 squats in the living room" },
    ],
    today_step: { step: "3 sets of 8 push-ups and 12 squats in the living room at 6:30 pm (about 15 min)", agreed_hours_ago: 9 },
  } as ScenarioInput["seed"];
}

function speakingSeed(): ScenarioInput["seed"] {
  return {
    name: "Lena",
    goal: "speak_connect",
    phase: "active",
    history_hours_ago: 3,
    answers: { what: "speaking up in meetings", where: "at work", when: "10 am standup", how_long: "15 min" },
    history: [
      { from: "zoh", text: "Standup at 10, Lena: say your one point in the first two minutes. Voice note after on how it went." },
      { from: "tester", text: "on it" },
    ],
    plan: {
      step: "Say one thing in the first two minutes of standup",
      place: "at work",
      time: "10:00",
      days: ["mon", "tue", "wed", "thu", "fri"],
      proof: "voice",
      proof_note: "a voice note right after on what you said and how it went",
      reason: "Saying it out loud right after is how you notice what's changing.",
      minutes: 15,
      started_days_ago: 4,
    },
    step_days: [{ days_ago: 1, status: "done", step: "Say one thing in the first two minutes of standup" }],
    today_step: { step: "Say your one point in the first two minutes of standup at 10 am", agreed_hours_ago: 3 },
  } as ScenarioInput["seed"];
}
