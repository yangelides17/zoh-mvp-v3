/**
 * Coach judgment harness: plays simulated testers and regression cases against the real
 * app, has a separate Claude grade every ZOH text, and writes a report. With --compare it scores
 * the run against the stored baseline case by case (#197); --regrade grades saved conversations again.
 *
 *   npm run eval -- onboarding [--persona terse] [--runs 2]
 *   npm run eval -- curiosity --case brief-done --runs 3 --compare
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../src/config.js";
import { fromStored, loadBaseline, producerChanges, producerFor, PRODUCER_LABELS, storeBaseline, type BaselineEntry } from "./baseline.js";
import { addUsage, createCompleter } from "./claude.js";
import { HAIKU, USAGE, UsageError, evalApiKey, graderModel, missingKeyMessage, parseEvalArgs, type EvalArgs } from "./cli.js";
import { budgetFor, currentBranch, overBudgetMessage, readLedger, recordSpend, RELEASE_BUDGET_USD } from "./budget.js";
import { billedDollars, estimateCost, type Estimate } from "./cost.js";
import { FEATURES, REPO_ROOT, REPORTS_DIR, getFeature, readPages, rubricFor, type FeatureDef, type RubricRule } from "./features.js";
import { gradeConversation, mapLimit, regradeConversations } from "./grader.js";
import { createMeter, guardFetch, runConversation, scriptedTester } from "./harness.js";
import { loadCases, loadScenarios, planConversations } from "./load.js";
import {
  aggregate,
  diffRuns,
  renderMarkdown,
  sameScope,
  suggestLiveChecks,
  summaryLines,
  worstReplies,
  type ReportData,
} from "./report.js";
import { caseIdOf, compareScores, groupScores, scoreCases, type CaseScore } from "./score.js";
import { simulatedTester } from "./simulator.js";
import type { ConversationPlan, GradedConversation } from "./types.js";

/** One feature's share of the run: what to play (or re-grade), and the baseline to compare with. */
interface Job {
  feature: FeatureDef;
  rubric: RubricRule[];
  pages: { rules: string; voice: string };
  plans: ConversationPlan[];
  /** Saved conversations to re-grade instead of running `plans`. */
  saved?: GradedConversation[];
  regradedFrom?: string;
  /** The current definition of each case, by case id: re-grading and the baseline use it. */
  current: Map<string, ConversationPlan>;
  baseline?: Map<string, BaselineEntry>;
  /** Cases whose script changed since their baseline: compared as new. */
  rescripted: string[];
  /** Cases whose baseline was graded differently (grader, checks, voice page): comparing would mislead. */
  stale: { id: string; changes: string[] }[];
  est: Estimate;
}

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

  const coachModel = loadConfig({ DATABASE_URL: "unused", CLAUDE_MODEL: env.CLAUDE_MODEL }).claude.model;
  const evalModel = graderModel(env, coachModel, args.final);
  const simModel = env.EVAL_SIM_MODEL?.trim() || HAIKU;
  const all = args.feature === "all";
  const features = all ? Object.values(FEATURES) : [getFeature(args.feature)!];

  const jobs: Job[] = [];
  for (const feature of features) {
    try {
      jobs.push(await prepare(feature, args, { all, coachModel, evalModel, simModel }));
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }
  const runnable = jobs.filter((j) => (j.saved ?? j.plans).length > 0);
  if (runnable.length === 0) {
    console.error(
      args.regradeBaseline
        ? "Nothing to re-grade: no stored baseline for these cases."
        : "Nothing to run: no scenario matches that persona and there are no regression cases.",
    );
    return 1;
  }

  const total = runnable.reduce((t, j) => ({ low: t.low + j.est.dollars.low, high: t.high + j.est.dollars.high }), { low: 0, high: 0 });
  const tokens = runnable.reduce((t, j) => ({ low: t.low + j.est.tokens.low, high: t.high + j.est.tokens.high }), { low: 0, high: 0 });
  for (const j of runnable) {
    const what = j.saved
      ? `re-grading ${j.saved.length} saved conversations from ${j.regradedFrom}`
      : `${j.plans.length} conversations (${j.plans.filter((p) => p.kind === "scenario").length} simulated, ${j.plans.filter((p) => p.kind === "case").length} cases)`;
    console.log(`Eval: ${j.feature.name}. ${what}${args.runs > 1 && !j.saved ? `, ${args.runs} runs each` : ""}.`);
  }
  console.log(
    [
      `Models: coach ${coachModel}, simulator ${simModel}, grader ${evalModel}${args.final ? " (final run)" : ""}.`,
      `Rough cost: ${fmtTokens(tokens.low)}–${fmtTokens(tokens.high)} tokens, about $${total.low.toFixed(2)}–$${total.high.toFixed(2)}.`,
    ].join("\n"),
  );

  // A baseline graded differently would show false differences: caught here, before anything is spent.
  const stale = runnable.filter((j) => j.stale.length);
  if (stale.length) {
    for (const j of stale) {
      const what = [...new Set(j.stale.flatMap((s) => s.changes))].join(", ");
      const ids = j.stale.map((s) => s.id);
      const regrade = await regradeEstimate(j, ids, { coachModel, evalModel });
      console.error(
        [
          `The stored baseline for ${ids.length} ${j.feature.name} case(s) was graded differently (${what} changed since), so a comparison would show false differences: ${ids.join(", ")}.`,
          `Re-grade it with the current checks first (grader only, about $${regrade.toFixed(2)}; no conversation runs again):`,
          `  npm run eval -- ${j.feature.name} --regrade-baseline${ids.filter((id) => id.startsWith("case:")).map((id) => ` --case ${id.slice(5)}`).join("")}${args.final ? " --final" : ""}`,
        ].join("\n"),
      );
    }
    if (!args.dryRun) return 1;
  }

  const ledgerPath = `${REPORTS_DIR}spend.json`;
  const branch = currentBranch(REPO_ROOT);
  // The release's full run has its own allowance, apart from what the branch spent on builds.
  const budgetUsd = all && !Number(env.EVAL_BUDGET_USD) ? RELEASE_BUDGET_USD : budgetFor(env, branch);
  const spentUsd = all ? 0 : ((await readLedger(ledgerPath))[branch]?.spentUsd ?? 0);
  console.log(all ? `Budget: $${budgetUsd.toFixed(2)} for the release's full run.` : `Budget: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent on ${branch}.`);
  const tooMuch = overBudgetMessage({ spentUsd, estimateUsd: total, budgetUsd, branch });
  if (tooMuch && !args.dryRun && !args.overBudget) {
    console.error(tooMuch);
    return 1;
  }
  if (args.dryRun) {
    for (const j of runnable) {
      for (const p of j.saved?.map((c) => c.plan) ?? j.plans) console.log(`  - ${j.feature.name} ${p.key} (${p.persona}): ${p.title}`);
      if (j.baseline) console.log(`  Baseline: ${j.baseline.size} of ${new Set(j.plans.map((p) => caseIdOf(p.key))).size} cases have one.`);
    }
    if (keyProblem) console.log(`\nNote: ${keyProblem.split("\n")[0]}`);
    return 0;
  }

  // Every Claude call the run makes (the coach inside the app included) is billed from what the API reports.
  const meter = createMeter();
  const restoreFetch = guardFetch(meter);
  const complete = createCompleter({ apiKey: evalApiKey(env)!, model: evalModel });
  const simulate = createCompleter({ apiKey: evalApiKey(env)!, model: simModel });
  for (const job of runnable) {
    const startedAt = new Date();
    const spentBefore = meter.dollars;
    let graded: GradedConversation[];
    if (job.saved) {
      graded = (await regradeConversations(job.saved, { rubric: job.rubric, pages: job.pages, complete, concurrency: args.concurrency })).convs;
      console.log(`  ${job.feature.name}: re-graded ${graded.filter((c) => c.grade).length} of ${graded.length} conversations`);
    } else {
      graded = await play(job, args, { env, complete, simulate });
    }
    await writeReport(job, graded, args, { startedAt, coachModel, evalModel, simModel, costUsd: meter.dollars - spentBefore });
    if (args.storeBaseline || args.regradeBaseline) {
      const producerOf = (plan: ConversationPlan) => producerFor(job.current.get(caseIdOf(plan.key)) ?? plan, { model: evalModel, rubric: job.rubric, pages: job.pages });
      const res = await storeBaseline(job.feature.name, graded, producerOf, { branch, storedAt: startedAt.toISOString() });
      console.log(`  Baseline stored for ${res.stored.length} case(s) in eval/baselines/${job.feature.name}/ (commit it with the branch).`);
      if (res.skipped.length) console.log(`  Not stored (no graded run): ${res.skipped.join(", ")}; their old baseline stays.`);
    }
  }
  restoreFetch();

  const costUsd = meter.dollars;
  const ledger = await recordSpend(ledgerPath, branch, costUsd);
  for (const [model, u] of Object.entries(meter.byModel)) {
    console.log(
      `  ${model}: $${billedDollars(u, model).toFixed(2)} (input ${fmtTokens(u.input)}, cache writes ${fmtTokens(u.cacheWrite)}, cache reads ${fmtTokens(u.cacheRead)}, output ${fmtTokens(u.output)})`,
    );
  }
  console.log(`Cost $${costUsd.toFixed(2)} as billed (estimated $${total.low.toFixed(2)}–$${total.high.toFixed(2)})${all ? "" : `; $${ledger[branch]!.spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent on ${branch}`}.`);
  return 0;
}

/** What a feature's run plays or re-grades, and the baseline it compares with. */
async function prepare(feature: FeatureDef, args: EvalArgs, models: { all: boolean; coachModel: string; evalModel: string; simModel: string }): Promise<Job> {
  const rubric = rubricFor(feature);
  const pages = await readPages(feature);
  const scenarios = loadScenarios(feature);
  const cases = await loadCases(feature.name);
  const current = new Map(planConversations(scenarios, cases, { runs: 1 }).map((p) => [caseIdOf(p.key), p]));
  const grading = { model: models.evalModel, rubric, pages };
  const job: Omit<Job, "est"> = { feature, rubric, pages, plans: [], current, rescripted: [], stale: [] };

  if (args.regrade) {
    const report = JSON.parse(await readFile(args.regrade, "utf8")) as ReportData;
    if (report.feature !== feature.name) throw new Error(`${args.regrade} is a ${report.feature} report, not ${feature.name}`);
    job.saved = report.conversations.map((c) => withCurrent(c, current.get(caseIdOf(c.plan.key))));
    job.regradedFrom = args.regrade;
  } else if (args.regradeBaseline) {
    const ids = args.cases?.map((id) => `case:${id}`);
    const stored = await loadBaseline(feature.name, ids);
    job.saved = [];
    for (const [id, entry] of stored) {
      const plan = current.get(id);
      if (!plan) {
        console.log(`  ${feature.name} ${id}: the case is gone, so its baseline is left as it is.`);
        continue;
      }
      if (producerChanges(entry.producer, producerFor(plan, grading)).includes("script")) {
        console.log(`  ${feature.name} ${id}: its script changed since the baseline, so re-grading can't stand in; store a fresh run instead.`);
        continue;
      }
      job.saved.push(...entry.runs.map((r) => fromStored(r, plan)));
    }
    job.regradedFrom = "the stored baseline";
  } else {
    // "all" (the release) plays every feature's cases; simulated scenarios stay out of the full run.
    job.plans = planConversations(models.all ? [] : scenarios, cases, { cases: args.cases, scenarios: args.scenarios, persona: args.persona, runs: args.runs });
  }

  const plansForCost = job.saved ? job.saved.map((c) => c.plan) : job.plans;
  const est = estimateCost(plansForCost, {
    maxTurns: args.maxTurns,
    pagesChars: pages.rules.length + pages.voice.length,
    coachModel: models.coachModel,
    evalModel: models.evalModel,
    simModel: models.simModel,
    memory: feature.memory,
    gradeOnly: !!job.saved,
    graderCalls: graderCalls(rubric),
  });

  if (args.compare && !args.regradeBaseline) {
    const ids = [...new Set(plansForCost.map((p) => caseIdOf(p.key)))];
    job.baseline = await loadBaseline(feature.name, ids);
    for (const [id, entry] of job.baseline) {
      const changes = producerChanges(entry.producer, producerFor(current.get(id) ?? plansForCost.find((p) => caseIdOf(p.key) === id)!, grading));
      if (changes.includes("script")) {
        job.rescripted.push(id);
        job.baseline.delete(id);
      } else if (changes.length) job.stale.push({ id, changes: changes.map((c) => PRODUCER_LABELS[c]) });
    }
  }
  return { ...job, est };
}

/** A saved conversation with its case's current definition (its text is part of the checks). */
function withCurrent(c: GradedConversation, plan: ConversationPlan | undefined): GradedConversation {
  if (!plan) return c;
  return { ...c, plan: { ...c.plan, suite: plan.suite, regression: plan.regression, scenario: plan.scenario, seed: plan.seed } };
}

async function regradeEstimate(job: Job, ids: string[], models: { coachModel: string; evalModel: string }): Promise<number> {
  const plans = [...(job.baseline?.values() ?? [])].filter((e) => ids.includes(e.id)).flatMap((e) => e.runs.map((r) => fromStored(r, job.current.get(e.id)).plan));
  const est = estimateCost(plans, { maxTurns: 20, pagesChars: job.pages.rules.length + job.pages.voice.length, coachModel: models.coachModel, evalModel: models.evalModel, gradeOnly: true, graderCalls: graderCalls(job.rubric) });
  return (est.dollars.low + est.dollars.high) / 2;
}

/** Plays and grades a job's conversations. */
async function play(
  job: Job,
  args: EvalArgs,
  deps: { env: NodeJS.ProcessEnv; complete: ReturnType<typeof createCompleter>; simulate: ReturnType<typeof createCompleter> },
): Promise<GradedConversation[]> {
  const { feature, plans, rubric, pages } = job;
  let done = 0;
  const graded = await mapLimit(plans, args.concurrency, async (plan, index): Promise<GradedConversation> => {
    const tester = plan.kind === "case" ? scriptedTester(plan.regression!.testerLines) : simulatedTester(plan.scenario!, deps.simulate, feature.doneWhen);
    // A case gets one turn past its script so it ends "by script", not by the cap.
    const maxTurns = plan.kind === "case" ? plan.regression!.testerLines.length + 1 : (plan.scenario!.maxTurns ?? args.maxTurns);
    const result = await runConversation(plan, tester, { maxTurns, index, env: deps.env, memory: feature.memory, saved: feature.saved, record: feature.record });
    const out: GradedConversation = { ...result };
    const zohCount = result.transcript.filter((l) => l.from === "zoh").length;
    if (!result.error || result.transcript.length > 0) {
      try {
        const g = await gradeConversation(
          { plan, context: result.context, transcript: result.transcript, memory: result.memory, record: result.record, saved: result.saved, rubric, pages },
          deps.complete,
        );
        out.grade = g.grade;
        out.gradeError = g.error;
        out.usage = addUsage(out.usage, g.usage);
      } catch (err) {
        out.gradeError = errorText(err);
      }
    }
    done += 1;
    const status = out.error ? `error: ${out.error}` : out.gradeError ? `not graded: ${out.gradeError}` : "graded";
    console.log(`  [${done}/${plans.length}] ${feature.name} ${plan.key}: ${zohCount} ZOH texts, ended by ${result.endedBy}, ${status}`);
    return out;
  });
  return graded;
}

async function writeReport(
  job: Job,
  graded: GradedConversation[],
  args: EvalArgs,
  meta: { startedAt: Date; coachModel: string; evalModel: string; simModel: string; costUsd?: number },
): Promise<void> {
  const { feature, rubric } = job;
  const summary = aggregate(graded);
  const scores = scoreCases(graded, rubric);
  const isReplay = (c: CaseScore) => c.suite === "replay";
  const previous = job.saved ? undefined : await latestReport(feature.name, args.persona, args.cases);
  let comparison: ReportData["comparison"];
  if (job.baseline) {
    const before = scoreCases(
      [...job.baseline.values()].flatMap((e) => e.runs.map((r) => fromStored(r, job.current.get(e.id)))),
      rubric,
    );
    const main = compareScores(scores.filter((c) => !isReplay(c)), before.filter((c) => !isReplay(c)));
    main.unmatched = main.unmatched.filter((id) => !job.rescripted.includes(id));
    const replays = scores.some(isReplay) ? compareScores(scores.filter(isReplay), before.filter(isReplay)) : undefined;
    comparison = { main, replays, rescripted: job.rescripted };
  }
  const report: ReportData = {
    feature: feature.name,
    startedAt: meta.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    models: { coach: meta.coachModel, eval: meta.evalModel, sim: meta.simModel },
    costUsd: meta.costUsd,
    options: { persona: args.persona, cases: args.cases, runs: args.runs, maxTurns: args.maxTurns },
    rubric,
    summary,
    worst: worstReplies(graded, 3),
    liveChecks: suggestLiveChecks(graded, rubric, 5),
    diff: previous ? diffRuns(summary, previous.data.summary, previous.name) : undefined,
    groups: groupScores(scores.filter((c) => !isReplay(c))),
    replayGroups: scores.some(isReplay) ? groupScores(scores.filter(isReplay)) : undefined,
    comparison,
    regradedFrom: job.regradedFrom,
    usage: graded.reduce((u, c) => addUsage(u, c.usage), { input: 0, output: 0 }),
    conversations: graded,
  };
  await mkdir(REPORTS_DIR, { recursive: true });
  const base = `${REPORTS_DIR}${meta.startedAt.toISOString().replace(/[:.]/g, "-")}-${feature.name}`;
  const files = { md: `${base}.md`, json: `${base}.json` };
  await writeFile(files.md, renderMarkdown(report));
  await writeFile(files.json, JSON.stringify(report, null, 2));
  for (const line of summaryLines(report, { md: rel(files.md), json: rel(files.json) })) console.log(line);
}

/** The most recent earlier report for this feature run over the same personas and cases, if any. */
async function latestReport(feature: string, persona: string | undefined, cases: string[] | undefined): Promise<{ name: string; data: ReportData } | undefined> {
  let files: string[];
  try {
    files = await readdir(REPORTS_DIR);
  } catch {
    return undefined;
  }
  const mine = files.filter((f) => f.endsWith(`-${feature}.json`)).sort().reverse();
  for (const name of mine) {
    try {
      const data = JSON.parse(await readFile(`${REPORTS_DIR}${name}`, "utf8")) as ReportData;
      if (sameScope(data.options, persona, cases)) return { name, data };
    } catch {
      // An unreadable report is skipped; an older one may still compare.
    }
  }
  return undefined;
}

function graderCalls(rubric: RubricRule[]): number {
  return 1 + rubric.filter((r) => r.alone && !r.code).length;
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

function rel(path: string): string {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length) : path;
}

function errorText(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected (401)";
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
