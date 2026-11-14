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
    goal: "focus",
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
];
