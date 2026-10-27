import type { ScenarioInput } from "../types.js";

/**
 * Nudges (spec: GitHub issue "Nudge scheduler") run as scripted cases in eval/cases/nudges/, since a
 * day of nudges needs the clock moved ("advance to 18:50") between texts. No simulated scenarios yet.
 */
export const nudgeScenarios: ScenarioInput[] = [];
