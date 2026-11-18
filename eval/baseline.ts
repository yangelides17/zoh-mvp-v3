/**
 * Stored baselines (#197): one committed file per case, `eval/baselines/<feature>/<case>.json`, holding its graded
 * runs and what produced them. A branch's final comparison stores its own cases' runs, so they replace those cases
 * on merge at no extra cost; the release refreshes every case. One file per case keeps two branches from colliding.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { REPO_ROOT, type RubricRule } from "./features.js";
import { graderSystemPrompt } from "./grader.js";
import { caseIdOf } from "./score.js";
import type { ConversationPlan, GradedConversation, Suite } from "./types.js";

export const BASELINES_DIR = `${REPO_ROOT}eval/baselines/`;

/** What produced a baseline's grades. A comparison needs the same on both sides. */
export interface Producer {
  grader: string;
  checks: string;
  voice: string;
  instructions: string;
  /** The case's tester lines and setup (a scenario's whole definition): a change means a different conversation. */
  script: string;
}

export const PRODUCER_LABELS: Record<keyof Producer, string> = {
  grader: "the grader model",
  checks: "the checks",
  voice: "the voice page",
  instructions: "the grader's instructions",
  script: "the case's script",
};

/** A stored run: what re-grading and scoring need, with the plan's case definition left out (it's in the repo). */
export type StoredRun = Pick<GradedConversation, "context" | "transcript" | "endedBy" | "memory" | "record" | "saved" | "error" | "grade" | "gradeError"> & {
  plan: Omit<ConversationPlan, "regression" | "scenario" | "seed">;
};

export interface BaselineEntry {
  feature: string;
  /** The case id as reports key it, e.g. "case:brief-done" or a scenario's id. */
  id: string;
  suite: Suite;
  storedAt: string;
  branch: string;
  producer: Producer;
  runs: StoredRun[];
}

export function producerFor(plan: ConversationPlan, grading: { model: string; rubric: RubricRule[]; pages: { rules: string; voice: string } }): Producer {
  const c = plan.regression;
  return {
    grader: grading.model,
    // How each rule is judged counts too: alone in its own call, or counted in code.
    checks: hash([grading.rubric.map((r) => [r.id, r.scope, r.label, r.alone ?? false, r.code ?? null]), c ? [c.whatWentWrong, c.shouldHaveHappened] : null]),
    voice: hash(grading.pages.voice),
    instructions: hash(graderSystemPrompt({ rubric: [], pages: { rules: "", voice: "" } })),
    script: hash(c ? [c.testerLines, c.seed ?? null, c.startTime, c.startDay ?? null, c.timeZone, c.areaCode, c.persona ?? null] : (plan.scenario ?? null)),
  };
}

/** What differs between a stored producer and the current one. */
export function producerChanges(stored: Producer, current: Producer): (keyof Producer)[] {
  return (Object.keys(PRODUCER_LABELS) as (keyof Producer)[]).filter((k) => stored[k] !== current[k]);
}

export function baselinePath(dir: string, feature: string, id: string): string {
  const file = id.startsWith("case:") ? `case-${id.slice(5)}` : `scenario-${id}`;
  return `${dir}${feature}/${file}.json`;
}

/** The stored baselines for these case ids (every stored case when none are given); a case with none is left out. */
export async function loadBaseline(feature: string, ids?: string[], dir = BASELINES_DIR): Promise<Map<string, BaselineEntry>> {
  const out = new Map<string, BaselineEntry>();
  let paths: string[];
  if (ids) paths = [...new Set(ids)].map((id) => baselinePath(dir, feature, id));
  else {
    try {
      paths = (await readdir(`${dir}${feature}`)).filter((f) => f.endsWith(".json")).sort().map((f) => `${dir}${feature}/${f}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw err;
    }
  }
  for (const path of paths) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const entry = JSON.parse(raw) as BaselineEntry;
    out.set(entry.id, entry);
  }
  return out;
}

/**
 * Stores each case's graded runs as its baseline, replacing what was there. A case with no graded run is
 * skipped (its old baseline stays). Returns the ids stored and skipped.
 */
export async function storeBaseline(
  feature: string,
  convs: GradedConversation[],
  producerOf: (plan: ConversationPlan) => Producer,
  meta: { branch: string; storedAt: string },
  dir = BASELINES_DIR,
): Promise<{ stored: string[]; skipped: string[] }> {
  const byCase = new Map<string, GradedConversation[]>();
  for (const c of convs) {
    const id = caseIdOf(c.plan.key);
    if (!byCase.has(id)) byCase.set(id, []);
    byCase.get(id)!.push(c);
  }
  const stored: string[] = [];
  const skipped: string[] = [];
  await mkdir(`${dir}${feature}`, { recursive: true });
  for (const [id, runs] of byCase) {
    const graded = runs.filter((r) => r.grade);
    if (graded.length === 0) {
      skipped.push(id);
      continue;
    }
    const entry: BaselineEntry = {
      feature,
      id,
      suite: graded[0]!.plan.suite ?? "regression",
      storedAt: meta.storedAt,
      branch: meta.branch,
      producer: producerOf(graded[0]!.plan),
      runs: graded.map(toStored),
    };
    await writeFile(baselinePath(dir, feature, id), `${JSON.stringify(entry, null, 2)}\n`);
    stored.push(id);
  }
  return { stored, skipped };
}

function toStored(c: GradedConversation): StoredRun {
  const { regression: _r, scenario: _s, seed: _seed, ...plan } = c.plan;
  return {
    plan,
    context: c.context,
    transcript: c.transcript,
    endedBy: c.endedBy,
    memory: c.memory,
    record: c.record,
    saved: c.saved,
    error: c.error,
    grade: c.grade,
    gradeError: c.gradeError,
  };
}

/** A stored run as a conversation again, with the case's current definition, ready to score or re-grade. */
export function fromStored(run: StoredRun, plan: ConversationPlan | undefined): GradedConversation {
  return {
    ...run,
    plan: { ...run.plan, regression: plan?.regression, scenario: plan?.scenario, seed: plan?.seed },
    phone: "",
    savedState: {},
    messageCount: run.transcript.length,
    appErrors: [],
    usage: { input: 0, output: 0 },
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 12);
}
