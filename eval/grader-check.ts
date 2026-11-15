/**
 * Checks the grader itself (#197), automatically:
 * - rules, against known answers: conversations written to follow or break one rule (`eval/known/<feature>/`),
 *   graded as usual; the report gives each rule's catch rate (breaks failed) and pass rate (follows passed);
 * - feel, against a stronger model: on a sample of a saved report's conversations, a stronger, separate model
 *   grades the conversation checks, and the report gives how often the regular grader caught what it failed
 *   and passed what it passed.
 *
 *   npm run grader-check -- <feature | all> [--runs 3] [--report eval/reports/<file>.json [--sample 4]] [--dry-run]
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { budgetFor, currentBranch, overBudgetMessage, readLedger, recordSpend } from "./budget.js";
import { createCompleter, type Completer } from "./claude.js";
import { evalApiKey, graderModel, missingKeyMessage } from "./cli.js";
import { EVAL_DAY, zonedDate } from "./clock.js";
import { dollarsFor, estimateCost } from "./cost.js";
import { FEATURES, REPO_ROOT, REPORTS_DIR, getFeature, readPages, rubricFor, type RubricRule } from "./features.js";
import { gradeConversation, mapLimit } from "./grader.js";
import type { ReportData } from "./report.js";
import { seedSchema, type ConversationPlan, type Grade, type GradedConversation, type TokenUsage, type TranscriptLine } from "./types.js";

export const KNOWN_DIR = `${REPO_ROOT}eval/known/`;
/** The stronger, separate model for feel: Opus unless EVAL_STRONG_MODEL says otherwise. */
export const STRONG_MODEL = "claude-opus-5-5";

export const knownSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** The one rule this example is written to follow or break. */
  rule: z.string(),
  expect: z.enum(["pass", "fail"]),
  /** Why it follows or breaks the rule, in a line. */
  why: z.string(),
  areaCode: z.string().regex(/^\d{3}$/).default("212"),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).default("18:30"),
  timeZone: z.string().default("America/New_York"),
  /** What ZOH knew before (its history is shown as earlier context, never graded). */
  seed: seedSchema.optional(),
  transcript: z.array(z.object({ from: z.enum(["tester", "zoh"]), text: z.string().min(1) })).min(2),
});
export type KnownExample = z.infer<typeof knownSchema> & { feature: string };

/** A feature's known-answer examples, checked against its rubric. A missing folder means none yet. */
export async function loadKnown(feature: string, dir = KNOWN_DIR): Promise<KnownExample[]> {
  const def = getFeature(feature);
  if (!def) throw new Error(`Unknown feature "${feature}"`);
  let files: string[];
  try {
    files = (await readdir(`${dir}${feature}`)).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const rubric = rubricFor(def);
  return Promise.all(
    files.map(async (file) => {
      const parsed = knownSchema.safeParse(JSON.parse(await readFile(`${dir}${feature}/${file}`, "utf8")));
      if (!parsed.success) throw new Error(`Known example ${feature}/${file} is invalid: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      const rule = rubric.find((r) => r.id === parsed.data.rule);
      if (!rule) throw new Error(`Known example ${feature}/${file}: "${parsed.data.rule}" is not a ${feature} rule`);
      if (rule.code) throw new Error(`Known example ${feature}/${file}: "${rule.id}" is counted in code, not judged`);
      return { ...parsed.data, feature };
    }),
  );
}

/** The example as a conversation to grade: a minute between lines, from its start time on the eval's Monday. */
export function knownConversation(ex: KnownExample): { plan: ConversationPlan; context: TranscriptLine[]; transcript: TranscriptLine[] } {
  const start = zonedDate(EVAL_DAY, ex.startTime, ex.timeZone).getTime();
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const history = ex.seed?.history ?? [];
  return {
    plan: { key: `known:${ex.id}`, kind: "scenario", id: ex.id, title: ex.why, persona: "scripted", areaCode: ex.areaCode, startTime: ex.startTime, timeZone: ex.timeZone, seed: ex.seed },
    context: history.map((l, i) => ({ from: l.from, text: l.text, at: at(i - history.length - 60) })),
    transcript: ex.transcript.map((l, i) => ({ ...l, at: at(i) })),
  };
}

/** What the grader said about one rule in a grade: failed anywhere, passed, or never scored it. */
export function verdictOn(grade: Grade, rule: string): "pass" | "fail" | "skipped" {
  const checks = [...grade.texts.flatMap((t) => t.checks), ...grade.conversation].filter((c) => c.rule === rule);
  if (checks.length === 0) return "skipped";
  return checks.some((c) => !c.pass) ? "fail" : "pass";
}

export interface KnownResult {
  feature: string;
  id: string;
  rule: string;
  expect: "pass" | "fail";
  said: "pass" | "fail" | "skipped" | "error";
}

export interface KnownRate {
  feature: string;
  rule: string;
  /** Gradings of examples that break the rule, and how many the grader failed. */
  breaks: number;
  caught: number;
  /** Gradings of examples that follow it, and how many it didn't fail (a rule it skipped as not applying counts). */
  follows: number;
  passed: number;
  /** Gradings that errored, left out of both. */
  errors: number;
}

export function knownRates(results: KnownResult[]): KnownRate[] {
  const out = new Map<string, KnownRate>();
  for (const r of results) {
    const key = `${r.feature}/${r.rule}`;
    const rate = out.get(key) ?? { feature: r.feature, rule: r.rule, breaks: 0, caught: 0, follows: 0, passed: 0, errors: 0 };
    if (r.said === "error") rate.errors += 1;
    else if (r.expect === "fail") {
      rate.breaks += 1;
      if (r.said === "fail") rate.caught += 1;
    } else {
      rate.follows += 1;
      if (r.said !== "fail") rate.passed += 1;
    }
    out.set(key, rate);
  }
  return [...out.values()];
}

/** Grades each example `runs` times with the regular grader. */
export async function checkKnown(
  examples: KnownExample[],
  grading: { runs: number; complete: Completer; concurrency?: number },
): Promise<{ results: KnownResult[]; usage: TokenUsage }> {
  let usage: TokenUsage = { input: 0, output: 0 };
  const jobs = examples.flatMap((ex) => Array.from({ length: grading.runs }, () => ex));
  const pages = new Map<string, { rules: string; voice: string }>();
  for (const f of new Set(examples.map((e) => e.feature))) pages.set(f, await readPages(getFeature(f)!));
  const results = await mapLimit(jobs, grading.concurrency ?? 3, async (ex): Promise<KnownResult> => {
    const conv = knownConversation(ex);
    const g = await gradeConversation({ ...conv, rubric: rubricFor(getFeature(ex.feature)!), pages: pages.get(ex.feature)! }, grading.complete);
    usage = { input: usage.input + g.usage.input, output: usage.output + g.usage.output };
    return { feature: ex.feature, id: ex.id, rule: ex.rule, expect: ex.expect, said: g.grade ? verdictOn(g.grade, ex.rule) : "error" };
  });
  return { results, usage };
}

// ---- Feel, against a stronger model ----

export interface AgreementRate {
  rule: string;
  /** Checks the stronger model failed, and how many of those the regular grader failed too. */
  strongFails: number;
  caught: number;
  /** Checks the stronger model passed, and how many of those the regular grader passed too. */
  strongPasses: number;
  passed: number;
}

/** Pairs each conversation check both graders scored (per text, or once for the conversation) and tallies agreement per rule. */
export function agreement(pairs: { regular: Grade; strong: Grade }[], rules: string[]): AgreementRate[] {
  const out = new Map<string, AgreementRate>();
  const keyed = (g: Grade) => {
    const m = new Map<string, boolean>();
    for (const t of g.texts) for (const c of t.checks) if (rules.includes(c.rule)) m.set(`${c.rule}@${t.zohText}`, (m.get(`${c.rule}@${t.zohText}`) ?? true) && c.pass);
    for (const c of g.conversation) if (rules.includes(c.rule)) m.set(`${c.rule}@all`, (m.get(`${c.rule}@all`) ?? true) && c.pass);
    return m;
  };
  for (const { regular, strong } of pairs) {
    const reg = keyed(regular);
    for (const [key, strongPass] of keyed(strong)) {
      const regPass = reg.get(key);
      if (regPass === undefined) continue;
      const rule = key.split("@")[0]!;
      const rate = out.get(rule) ?? { rule, strongFails: 0, caught: 0, strongPasses: 0, passed: 0 };
      if (strongPass) {
        rate.strongPasses += 1;
        if (regPass) rate.passed += 1;
      } else {
        rate.strongFails += 1;
        if (!regPass) rate.caught += 1;
      }
      out.set(rule, rate);
    }
  }
  return [...out.values()].sort((a, b) => a.rule.localeCompare(b.rule));
}

/** Up to `n` graded conversations spread across the report, so the sample isn't all one case. */
export function sampleConversations(convs: GradedConversation[], n: number): GradedConversation[] {
  const graded = convs.filter((c) => c.grade && c.transcript.length);
  if (graded.length <= n) return graded;
  return Array.from({ length: n }, (_, i) => graded[Math.floor((i * graded.length) / n)]!);
}

/** Has the stronger model grade the sample's conversation checks (the rules in the conversation group). */
export async function checkFeel(
  convs: GradedConversation[],
  grading: { rubric: RubricRule[]; pages: { rules: string; voice: string }; strong: Completer },
): Promise<{ rates: AgreementRate[]; usage: TokenUsage; ungraded: number }> {
  const feel = grading.rubric.filter((r) => r.group === "conversation");
  let usage: TokenUsage = { input: 0, output: 0 };
  const pairs: { regular: Grade; strong: Grade }[] = [];
  let ungraded = 0;
  const pages = { voice: grading.pages.voice, rules: feel.map((r) => `- ${r.label}`).join("\n") };
  for (const c of convs) {
    const g = await gradeConversation({ ...c, rubric: feel, pages }, grading.strong);
    usage = { input: usage.input + g.usage.input, output: usage.output + g.usage.output };
    if (g.grade && c.grade) pairs.push({ regular: c.grade, strong: g.grade });
    else ungraded += 1;
  }
  return { rates: agreement(pairs, feel.map((r) => r.id)), usage, ungraded };
}

// ---- Report ----

function share(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${Math.round((100 * part) / whole)}% (${part}/${whole})`;
}

export function renderGraderCheck(r: { known: KnownRate[]; feel?: { rates: AgreementRate[]; regular: string; strong: string; sampled: number; from: string } }): string {
  const lines = ["# Grader check", ""];
  lines.push(
    "## Rules, against known answers",
    "",
    "Each example is written to follow or break one rule. Catch rate: breaks the grader failed. Pass rate: follows it didn't fail.",
    "",
  );
  if (r.known.length === 0) lines.push("No known-answer examples for this feature yet (`eval/known/<feature>/`).");
  else {
    lines.push("| Rule | Catch rate | Pass rate |", "| --- | --- | --- |");
    for (const k of r.known) lines.push(`| \`${k.feature}/${k.rule}\` | ${share(k.caught, k.breaks)} | ${share(k.passed, k.follows)}${k.errors ? ` (${k.errors} errored)` : ""} |`);
  }
  if (r.feel) {
    lines.push(
      "",
      "## Feel, against a stronger model",
      "",
      `${r.feel.sampled} conversation${r.feel.sampled === 1 ? "" : "s"} from ${r.feel.from}: \`${r.feel.strong}\` graded the conversation checks; the report's grader was \`${r.feel.regular}\`.`,
      "Catches: of the checks the stronger model failed, how many the regular grader failed too. Passes: of those it passed, how many the regular grader passed.",
      "",
      "| Rule | Catches | Passes |",
      "| --- | --- | --- |",
    );
    for (const a of r.feel.rates) lines.push(`| \`${a.rule}\` | ${share(a.caught, a.strongFails)} | ${share(a.passed, a.strongPasses)} |`);
  }
  return lines.join("\n");
}

// ---- Command line ----

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { runs: { type: "string" }, report: { type: "string" }, sample: { type: "string" }, "dry-run": { type: "boolean" }, "over-budget": { type: "boolean" } },
  });
  const target = positionals[0];
  if (!target || (target !== "all" && !getFeature(target))) {
    console.error(`Usage: npm run grader-check -- <feature | all> [--runs 3] [--report <report.json> [--sample 4]] [--dry-run]\n  features: ${Object.keys(FEATURES).join(", ")}`);
    return 1;
  }
  const runs = Number(values.runs ?? 3);
  const sample = Number(values.sample ?? 4);
  if (existsSync(`${REPO_ROOT}.env`)) process.loadEnvFile(`${REPO_ROOT}.env`);
  const env = process.env;
  const dryRun = values["dry-run"] ?? false;
  const keyProblem = missingKeyMessage(env);
  if (keyProblem && !dryRun) {
    console.error(keyProblem);
    return 1;
  }
  const coachModel = loadConfig({ DATABASE_URL: "unused", CLAUDE_MODEL: env.CLAUDE_MODEL }).claude.model;
  const regularModel = graderModel(env, coachModel, false);
  const strongModel = env.EVAL_STRONG_MODEL?.trim() || STRONG_MODEL;

  const features = target === "all" ? Object.keys(FEATURES) : [target];
  const examples = (await Promise.all(features.map((f) => loadKnown(f)))).flat();
  let report: ReportData | undefined;
  if (values.report) {
    report = JSON.parse(await readFile(values.report, "utf8")) as ReportData;
    if (target !== "all" && report.feature !== target) {
      console.error(`${values.report} is a ${report.feature} report, not ${target}`);
      return 1;
    }
  }
  const sampled = report ? sampleConversations(report.conversations, sample) : [];
  const feelFeature = report ? getFeature(report.feature)! : undefined;

  const knownPlans = examples.flatMap((ex) => Array.from({ length: runs }, () => knownConversation(ex).plan));
  const knownEst = estimateCost(knownPlans, { maxTurns: 20, pagesChars: 20_000, coachModel, evalModel: regularModel, gradeOnly: true });
  const feelEst = estimateCost(sampled.map((c) => c.plan), { maxTurns: 20, pagesChars: 20_000, coachModel, evalModel: strongModel, gradeOnly: true, graderCalls: 1 + (feelFeature?.rubric.filter((r) => r.group === "conversation" && r.alone).length ?? 0) });
  const estimate = { low: knownEst.dollars.low + feelEst.dollars.low, high: knownEst.dollars.high + feelEst.dollars.high };
  console.log(
    `Grader check: ${examples.length} known-answer examples × ${runs} runs (grader ${regularModel})${sampled.length ? `, ${sampled.length} conversation${sampled.length === 1 ? "" : "s"} from ${values.report} re-graded by ${strongModel}` : ""}. About $${estimate.low.toFixed(2)}–$${estimate.high.toFixed(2)}.`,
  );
  const ledgerPath = `${REPORTS_DIR}spend.json`;
  const branch = currentBranch(REPO_ROOT);
  const budgetUsd = budgetFor(env, branch);
  const spentUsd = (await readLedger(ledgerPath))[branch]?.spentUsd ?? 0;
  const tooMuch = overBudgetMessage({ spentUsd, estimateUsd: estimate, budgetUsd, branch });
  if (tooMuch && !dryRun && !values["over-budget"]) {
    console.error(tooMuch);
    return 1;
  }
  if (dryRun) return 0;

  const regular = createCompleter({ apiKey: evalApiKey(env)!, model: regularModel });
  const known = await checkKnown(examples, { runs, complete: regular });
  let cost = dollarsFor(known.usage, regularModel);
  let feel: Parameters<typeof renderGraderCheck>[0]["feel"];
  if (report && feelFeature) {
    const strong = createCompleter({ apiKey: evalApiKey(env)!, model: strongModel });
    const res = await checkFeel(sampled, { rubric: rubricFor(feelFeature), pages: await readPages(feelFeature), strong });
    cost += dollarsFor(res.usage, strongModel);
    feel = { rates: res.rates, regular: report.models.eval, strong: strongModel, sampled: sampled.length - res.ungraded, from: values.report! };
  }
  const md = renderGraderCheck({ known: knownRates(known.results), feel });
  await mkdir(REPORTS_DIR, { recursive: true });
  const path = `${REPORTS_DIR}${new Date().toISOString().replace(/[:.]/g, "-")}-grader-check.md`;
  await writeFile(path, md);
  console.log(`\n${md}\n\nReport: ${path.slice(REPO_ROOT.length)}`);
  const ledger = await recordSpend(ledgerPath, branch, cost);
  console.log(`Cost about $${cost.toFixed(2)}; $${ledger[branch]!.spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent on ${branch}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`Grader check failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
