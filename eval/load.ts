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
  /** Only these case ids, and no scenarios (a targeted run). */
  cases?: string[];
  /** Only these scenario ids, and no cases (iterating on one conversation). */
  scenarios?: string[];
  persona?: string;
  runs: number;
}

/**
 * What a run will play: each matching scenario `runs` times, then every regression case once.
 * Cases always run whatever the persona filter, so a fixed mistake can't sneak back in.
 * A targeted run (`cases`) plays only those cases; unknown ids throw.
 */
export function planConversations(scenarios: Scenario[], cases: RegressionCase[], opts: PlanOptions): ConversationPlan[] {
  if (opts.cases) {
    const unknown = opts.cases.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length) throw new Error(`Unknown case id: ${unknown.join(", ")} (known: ${cases.map((c) => c.id).join(", ") || "none"})`);
    cases = cases.filter((c) => opts.cases!.includes(c.id));
  }
  if (opts.scenarios) {
    const unknown = opts.scenarios.filter((id) => !scenarios.some((s) => s.id === id));
    if (unknown.length) throw new Error(`Unknown scenario id: ${unknown.join(", ")} (known: ${scenarios.map((s) => s.id).join(", ")})`);
    cases = opts.cases ? cases : [];
  }
  const picked = opts.scenarios
    ? scenarios.filter((s) => opts.scenarios!.includes(s.id))
    : opts.cases
      ? []
      : opts.persona
        ? scenarios.filter((s) => s.persona === opts.persona)
        : scenarios;
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
        seed: s.seed,
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
      startDay: c.startDay,
      timeZone: c.timeZone,
      regression: c,
      seed: c.seed,
    });
  }
  return plans;
}
