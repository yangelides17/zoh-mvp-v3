import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { onboardingScenarios } from "./scenarios/onboarding.js";
import { nudgeScenarios } from "./scenarios/nudges.js";
import { planScenarios } from "./scenarios/plan.js";
import type { ScenarioInput } from "./types.js";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The coach voice page: applies to every feature, read at run time. */
export const VOICE_PATH = `${REPO_ROOT}docs/coach-voice.md`;
export const CASES_DIR = `${REPO_ROOT}eval/cases/`;
export const REPORTS_DIR = `${REPO_ROOT}eval/reports/`;

export interface RubricRule {
  id: string;
  label: string;
  /** "text": judged on each ZOH text. "conversation": judged once on the whole exchange. */
  scope: "text" | "conversation";
}

export interface FeatureDef {
  name: string;
  /**
   * The judgment checks Yanni approved in the feature's spec (its "Should" list), close to word
   * for word. The grader applies exactly these plus the voice page; ids keep pass rates comparable.
   */
  rubric: RubricRule[];
  scenarios: ScenarioInput[];
  /** Tells the simulator when the coach has finished this feature's conversation. */
  doneWhen: string;
  /**
   * The overnight memory pass runs (on the real model) whenever the clock passes 3 am, and the
   * grader sees the pages it wrote. Only for features that grade memory: it costs a pass per day.
   */
  memory?: boolean;
}

/** Applies to every feature: only judged on a regression case. */
export const REGRESSION_RULE: RubricRule = {
  id: "regression",
  label: "Does what the regression case says should have happened",
  scope: "conversation",
};

export const FEATURES: Record<string, FeatureDef> = {
  onboarding: {
    name: "onboarding",
    doneWhen:
      "ZOH has finished the onboarding questions and moved on to your plan: it showed you a proposed plan, or started asking details for it.",
    scenarios: onboardingScenarios,
    rubric: [
      { id: "one-question", scope: "text", label: "One question per text (the first text may ask name and goal together)" },
      { id: "short", scope: "text", label: "Short: one to three sentences (a short list doesn't count), at most two texts per reply. The first text is exempt: it must carry the intro, the stop and coaching-style lines and the question" },
      { id: "plain-words", scope: "text", label: "Plain words: no markdown, hashtags or filler" },
      {
        id: "voice",
        scope: "text",
        label: "Pushy-level energy, warm and sincere; not overfamiliar or affectionate; emoji as punctuation, never a row",
      },
      { id: "fits", scope: "text", label: "The question fits the goal and the person and moves onboarding forward" },
      { id: "no-repeat", scope: "text", label: "Doesn't ask for something the tester already gave, even in passing" },
      { id: "honest", scope: "text", label: "No invented facts; only uses what the tester actually said" },
      { id: "on-track", scope: "text", label: "Off-topic or goal questions get a short answer, then back to onboarding" },
      {
        id: "not-asked",
        scope: "text",
        label: "No wake/sleep questions (unless bedtime) or pushiness questions; asks the city only for numbers outside Eastern",
      },
      { id: "follows-style", scope: "text", label: "Follows the tester's style requests once they make one" },
      {
        id: "first-text",
        scope: "conversation",
        label:
          "First text says it's ZOH, what it does, that \"stop\" works anytime and that they can change how ZOH coaches, and asks name and goal with the goal list; if their first text already named the goal (and name), it skips what's given and moves on",
      },
      { id: "nothing-twice", scope: "conversation", label: "Nothing asked twice across the conversation" },
      { id: "covers-inputs", scope: "conversation", label: "Learns what, where, when and how long (where they apply) before wrapping up" },
      {
        id: "tracking",
        scope: "conversation",
        label: "Asks once whether they already track it, for exercise, nutrition, bedtime and deep work only",
      },
      { id: "reality-check", scope: "conversation", label: "Reality check when what they want doesn't fit their time or resources" },
      {
        id: "goal-list",
        scope: "conversation",
        label: "Goal comes from the list: off-list goals declined plainly with the list offered; close ones accepted",
      },
      { id: "style-offer", scope: "conversation", label: "Tells them they can change how ZOH coaches anytime" },
      {
        id: "wrap-up",
        scope: "conversation",
        label: "Only once every plan question is answered, carries straight on into the plan (asks what it still needs, or shows it), with no recap or plan-is-coming line",
      },
      { id: "length", scope: "conversation", label: "No longer than about 12 ZOH texts and five minutes; fewer is fine when the tester gives several answers at once" },
    ],
  },
  plan: {
    name: "plan",
    doneWhen:
      "your plan is locked: you committed and ZOH confirmed it and when day 1 is (or, if you came to switch goals, the new plan is locked or you've clearly decided to keep the current one).",
    scenarios: planScenarios,
    rubric: [
      { id: "one-question", scope: "text", label: "One question per text, at the end" },
      {
        id: "short",
        scope: "text",
        label: "Short: one to three sentences, except a text presenting or changing the plan, which can run to about 8 lines",
      },
      { id: "plain-words", scope: "text", label: "Plain words: no markdown, hashtags or filler" },
      {
        id: "voice",
        scope: "text",
        label: "Pushy-level energy, warm and sincere; not overfamiliar or affectionate; emoji as punctuation, never a row",
      },
      { id: "honest", scope: "text", label: "No invented facts about the tester: the plan uses what they said plus ZOH's concrete suggestions" },
      {
        id: "no-seam",
        scope: "conversation",
        label:
          "No seam: extra questions the plan needs come before any \"that's everything\" line, one at a time (changes the tester asks for afterwards don't count against it)",
      },
      {
        id: "plan-shape",
        scope: "conversation",
        label:
          "The plan is concrete enough to follow (what, how much, where, when, which days), at most about 8 lines, with a reason and a proof method (photo, screenshot or voice note) that fits what they use",
      },
      {
        id: "commitment",
        scope: "conversation",
        label: "The commitment ask feels like a real commitment, not a casual question, in natural words (no stock lines); a soft yes (\"ok\", \"sure\") gets one natural re-ask that doesn't pick apart their wording",
      },
      { id: "day-one", scope: "conversation", label: "Pushes for day 1 today; accepts tomorrow on pushback" },
      { id: "quiet-hours", scope: "conversation", label: "A step time inside quiet hours (10 pm to 9 am by default) gets the offer to adjust them, with a plain explanation of what quiet hours are" },
      {
        id: "nutrition",
        scope: "conversation",
        label:
          "Nutrition: asks for their target first, and suggests one only if they have none, from their weight in pounds: protein 0.75 to 1 g per lb; calories 10 to 12x to lose, 13 to 15x to maintain, 16 to 18x to gain",
      },
      { id: "goal-switch", scope: "conversation", label: "An unjustified goal switch gets a warm push back; a justified one goes ahead" },
      { id: "revisions", scope: "conversation", label: "Revisions keep what they didn't ask to change" },
    ],
  },
  /** Target: 80% of checks passing (spec "Should"). */
  nudges: {
    name: "nudges",
    doneWhen: "the day is over: you've done today's step, or it's late evening.",
    scenarios: nudgeScenarios,
    rubric: [
      {
        id: "names-commitment",
        scope: "text",
        label: "Every step-day nudge (a text ZOH starts itself on a step day) names their actual commitment: what, and when or where",
      },
      { id: "warm-open", scope: "text", label: "A text ZOH starts itself opens warm with their name" },
      { id: "off-day-light", scope: "text", label: "Off-day (rest day) text is light, with no push" },
      { id: "no-guilt", scope: "text", label: "No guilt or fake urgency" },
      { id: "short", scope: "text", label: "Short: one to three sentences, at most one question, at the end" },
      { id: "plain-words", scope: "text", label: "Plain words: no markdown, hashtags or filler" },
      {
        id: "voice",
        scope: "text",
        label: "Pushy-level energy, warm and sincere; not overfamiliar or affectionate; emoji as punctuation, never a row",
      },
      {
        id: "miss-ladder",
        scope: "conversation",
        label: "Day-after-a-miss and day-3 texts follow the voice page's \"When they start to slip\"",
      },
      {
        id: "daily-rhythm",
        scope: "conversation",
        label:
          "Once the step is done ZOH celebrates and starts no more texts that day; \"can't today\" gets the line held once, then a smaller version",
      },
    ],
  },
  /** Coach memory (#8). Part 1 grades what the overnight pass files; Part 2 adds how the coach uses it. */
  memory: {
    name: "memory",
    doneWhen: "the day is over and you've said what you wanted to say.",
    scenarios: [],
    memory: true,
    rubric: [
      {
        id: "pages-real",
        scope: "conversation",
        label:
          "Makes pages for real parts of the tester's life, files general likes and opinions on the right person's page, and makes no pages for passing mentions or general topics",
      },
      { id: "learned-not-single", scope: "conversation", label: "Doesn't record a learned preference from a single instance" },
      { id: "recall", scope: "text", label: "Uses a relevant detail from 1+ weeks back naturally, without reciting it" },
      { id: "stated-pref", scope: "text", label: "Follows a stated preference days later" },
      { id: "honest-memory", scope: "text", label: "Never states a fact that isn't in memory" },
      { id: "what-you-know", scope: "text", label: "Answers \"what do you know about me\" honestly in a few lines" },
      { id: "not-overfamiliar", scope: "text", label: "No overfamiliarity in the first week" },
      {
        id: "progress-path",
        scope: "conversation",
        label: "\"How much progress have I made?\" traces the whole path back to the start, accurately",
      },
    ],
  },
};

export function getFeature(name: string): FeatureDef | undefined {
  return Object.hasOwn(FEATURES, name) ? FEATURES[name] : undefined;
}

export function rubricFor(feature: FeatureDef): RubricRule[] {
  return [...feature.rubric, REGRESSION_RULE];
}

/** The feature's approved checks as text, and the voice page read at run time so edits flow into grading. */
export async function readPages(feature: FeatureDef): Promise<{ rules: string; voice: string }> {
  const voice = await readFile(VOICE_PATH, "utf8");
  const rules = feature.rubric.map((r) => `- ${r.label}`).join("\n");
  return { rules, voice };
}
