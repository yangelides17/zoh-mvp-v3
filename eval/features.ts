import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { onboardingScenarios } from "./scenarios/onboarding.js";
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
      "ZOH has wrapped up onboarding: it recapped what you agreed and said your plan is on its way (or started proposing the plan).",
    scenarios: onboardingScenarios,
    rubric: [
      { id: "one-question", scope: "text", label: "One question per text (the first text may ask name and goal together)" },
      { id: "short", scope: "text", label: "Short: one to three sentences (a short list doesn't count), at most two texts per reply. The first text is exempt: it must carry the intro, the stop line and the question" },
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
          "First text says it's ZOH, what it does and that \"stop\" works anytime, and asks name and goal with the goal list; if their first text already named the goal (and name), it skips what's given and moves on",
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
        label: "Ends with a one-line recap and the plan-is-coming line, only once every plan question is answered",
      },
      { id: "length", scope: "conversation", label: "No longer than about 12 ZOH texts and five minutes; fewer is fine when the tester gives several answers at once" },
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
