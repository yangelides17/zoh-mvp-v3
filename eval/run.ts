/**
 * Coach judgment harness: plays simulated testers and regression cases against the real
 * app, has a separate Claude grade every ZOH text, and writes a report.
 *
 *   npm run eval -- onboarding [--persona terse] [--runs 2]
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../src/config.js";
import { addUsage, createCompleter } from "./claude.js";
import { USAGE, UsageError, missingKeyMessage, parseEvalArgs, type EvalArgs } from "./cli.js";
import { estimateCost } from "./cost.js";
import { REPO_ROOT, REPORTS_DIR, getFeature, readPages, rubricFor } from "./features.js";
import { gradeConversation } from "./grader.js";
import { guardFetch, runConversation, scriptedTester } from "./harness.js";
import { loadCases, loadScenarios, planConversations } from "./load.js";
import {
  aggregate,
  diffRuns,
  renderMarkdown,
  suggestLiveChecks,
  summaryLines,
  worstReplies,
  type ReportData,
} from "./report.js";
import { simulatedTester } from "./simulator.js";
import type { GradedConversation } from "./types.js";

async function main(): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseEvalArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    if (err.message) console.error(err.message, "\n");
    console.error(USAGE);
    return err.message ? 1 : 0;
  }

  if (existsSync(`${REPO_ROOT}.env`)) process.loadEnvFile(`${REPO_ROOT}.env`);
  const env = process.env;
  const keyProblem = missingKeyMessage(env);
  if (keyProblem && !args.dryRun) {
    console.error(keyProblem);
    return 1;
  }

  const feature = getFeature(args.feature)!;
  const coachModel = loadConfig({ DATABASE_URL: "unused", CLAUDE_MODEL: env.CLAUDE_MODEL }).claude.model;
  const evalModel = env.EVAL_MODEL?.trim() || coachModel;
  const rubric = rubricFor(feature);
  const pages = await readPages(feature);
  const scenarios = loadScenarios(feature);
  const cases = await loadCases(feature.name);
  const plans = planConversations(scenarios, cases, { persona: args.persona, runs: args.runs });
  if (plans.length === 0) {
    console.error("Nothing to run: no scenario matches that persona and there are no regression cases.");
    return 1;
  }

  const est = estimateCost(plans, {
    maxTurns: args.maxTurns,
    pagesChars: pages.rules.length + pages.voice.length,
    coachModel,
    evalModel,
  });
  const scenarioCount = plans.filter((p) => p.kind === "scenario").length;
  console.log(
    [
      `Eval: ${feature.name}. ${est.conversations} conversations (${scenarioCount} simulated, ${plans.length - scenarioCount} regression cases), up to ${est.maxTurns} tester texts.`,
      `Models: coach ${coachModel}, simulator + grader ${evalModel}.`,
      `Rough cost: ${fmtTokens(est.tokens.low)}–${fmtTokens(est.tokens.high)} tokens, about $${est.dollars.low.toFixed(2)}–$${est.dollars.high.toFixed(2)}.`,
    ].join("\n"),
  );
  if (args.dryRun) {
    for (const p of plans) console.log(`  - ${p.key} (${p.persona}): ${p.title}`);
    if (keyProblem) console.log(`\nNote: ${keyProblem.split("\n")[0]}`);
    return 0;
  }

  const restoreFetch = guardFetch();
  const complete = createCompleter({ apiKey: env.ANTHROPIC_API_KEY!.trim(), model: evalModel });
  const startedAt = new Date();
  let done = 0;

  const graded = await mapLimit(plans, args.concurrency, async (plan, index): Promise<GradedConversation> => {
    const tester =
      plan.kind === "case" ? scriptedTester(plan.regression!.testerLines) : simulatedTester(plan.scenario!, complete, feature.doneWhen);
    // A case gets one turn past its script so it ends "by script", not by the cap.
    const maxTurns = plan.kind === "case" ? plan.regression!.testerLines.length + 1 : (plan.scenario!.maxTurns ?? args.maxTurns);
    const result = await runConversation(plan, tester, { maxTurns, index, env });
    const graded: GradedConversation = { ...result };
    if (!result.error || result.transcript.length > 0) {
      try {
        const g = await gradeConversation({ plan, transcript: result.transcript, rubric, pages }, complete);
        graded.grade = g.grade;
        graded.gradeError = g.error;
        graded.usage = addUsage(graded.usage, g.usage);
      } catch (err) {
        graded.gradeError = errorText(err);
      }
    }
    done += 1;
    const zohTexts = result.transcript.filter((l) => l.from === "zoh").length;
    const status = graded.error ? `error: ${graded.error}` : graded.gradeError ? `not graded: ${graded.gradeError}` : "graded";
    console.log(`  [${done}/${plans.length}] ${plan.key}: ${zohTexts} ZOH texts, ended by ${result.endedBy}, ${status}`);
    return graded;
  });
  restoreFetch();

  const summary = aggregate(graded);
  const previous = await latestReport(feature.name);
  const report: ReportData = {
    feature: feature.name,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    models: { coach: coachModel, eval: evalModel },
    options: { persona: args.persona, runs: args.runs, maxTurns: args.maxTurns },
    rubric,
    summary,
    worst: worstReplies(graded, 3),
    liveChecks: suggestLiveChecks(graded, rubric, 5),
    diff: previous ? diffRuns(summary, previous.data.summary, previous.name) : undefined,
    usage: graded.reduce((u, c) => addUsage(u, c.usage), { input: 0, output: 0 }),
    conversations: graded,
  };

  await mkdir(REPORTS_DIR, { recursive: true });
  const base = `${REPORTS_DIR}${startedAt.toISOString().replace(/[:.]/g, "-")}-${feature.name}`;
  const files = { md: `${base}.md`, json: `${base}.json` };
  await writeFile(files.md, renderMarkdown(report));
  await writeFile(files.json, JSON.stringify(report, null, 2));
  for (const line of summaryLines(report, { md: rel(files.md), json: rel(files.json) })) console.log(line);
  return 0;
}

/** The most recent earlier report for this feature, if any. */
async function latestReport(feature: string): Promise<{ name: string; data: ReportData } | undefined> {
  let files: string[];
  try {
    files = await readdir(REPORTS_DIR);
  } catch {
    return undefined;
  }
  const mine = files.filter((f) => f.endsWith(`-${feature}.json`)).sort();
  const last = mine.at(-1);
  if (!last) return undefined;
  try {
    return { name: last, data: JSON.parse(await readFile(`${REPORTS_DIR}${last}`, "utf8")) as ReportData };
  } catch {
    return undefined;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

function rel(path: string): string {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length) : path;
}

function errorText(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY was rejected (401)";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`Eval failed: ${errorText(err)}`);
    process.exit(1);
  },
);
