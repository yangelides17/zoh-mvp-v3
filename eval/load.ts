import { readdir, readFile } from "node:fs/promises";
import { CASES_DIR, type FeatureDef } from "./features.js";
import {
  caseSchema,
  scenarioSchema,
  type ConversationPlan,
  type RegressionCase,
  type Scenario,
} from "./types.js";

/** Validates a feature's scenarios; throws with the scenario id on the first bad one. */
export function loadScenarios(feature: FeatureDef): Scenario[] {
  const seen = new Set<string>();
  return feature.scenarios.map((input, i) => {
    const parsed = scenarioSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`Scenario ${input.id ?? `#${i + 1}`} is invalid: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    }
    if (seen.has(parsed.data.id)) throw new Error(`Duplicate scenario id: ${parsed.data.id}`);
    seen.add(parsed.data.id);
    return parsed.data;
  });
}

/** Every case for a feature, in file-name order. A missing folder means no cases yet. */
export async function loadCases(feature: string, dir = `${CASES_DIR}${feature}/`): Promise<RegressionCase[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  files.sort((a, b) => a.localeCompare(b, "en"));
  const seen = new Set<string>();
  const cases: RegressionCase[] = [];
  for (const file of files) {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(`${dir}${file}`, "utf8"));
    } catch (err) {
      throw new Error(`Case ${file} is not valid JSON: ${(err as Error).message}`);
    }
    const parsed = caseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Case ${file} is invalid: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    }
    if (seen.has(parsed.data.id)) throw new Error(`Duplicate case id ${parsed.data.id} (${file})`);
    seen.add(parsed.data.id);
    cases.push(parsed.data);
  }
  return cases;
}

export interface PlanOptions {
  persona?: string;
  runs: number;
}

/**
 * What a run will play: each matching scenario `runs` times, then every regression case once.
 * Cases always run whatever the persona filter, so a fixed mistake can't sneak back in.
 */
export function planConversations(scenarios: Scenario[], cases: RegressionCase[], opts: PlanOptions): ConversationPlan[] {
  const picked = opts.persona ? scenarios.filter((s) => s.persona === opts.persona) : scenarios;
  const plans: ConversationPlan[] = [];
  for (const s of picked) {
    for (let run = 1; run <= opts.runs; run++) {
      plans.push({
        key: opts.runs > 1 ? `${s.id}#${run}` : s.id,
        kind: "scenario",
        id: s.id,
        title: s.title,
        persona: s.persona,
        areaCode: s.areaCode,
        startTime: s.startTime,
        timeZone: s.timeZone,
        scenario: s,
      });
    }
  }
  for (const c of cases) {
    plans.push({
      key: `case:${c.id}`,
      kind: "case",
      id: c.id,
      title: c.title,
      persona: c.persona ?? "scripted",
      areaCode: c.areaCode,
      startTime: c.startTime,
      timeZone: c.timeZone,
      regression: c,
    });
  }
  return plans;
}
