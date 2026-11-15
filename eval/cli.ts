import { parseArgs } from "node:util";
import { FEATURES } from "./features.js";
import { PERSONAS } from "./types.js";

export const USAGE = [
  "Usage: npm run eval -- <feature> [--case <id>]... [--scenario <id>]... [--persona <name>] [--runs <n>] [--compare] [--store-baseline] [--regrade <report.json> | --regrade-baseline] [--max-turns <n>] [--concurrency <n>] [--final] [--dry-run] [--over-budget]",
  "",
  `  <feature>        one of: ${Object.keys(FEATURES).join(", ")}; or "all": every feature's cases (the release's full run)`,
  "  --case           only this case (repeatable), no simulated conversations: the cheap targeted run",
  "  --scenario       only this simulated conversation (repeatable), no cases unless --case is given too",
  `  --persona        only scenarios with this persona (${PERSONAS.join(", ")}); cases always run`,
  "  --runs           times to play each scenario and case (default 1; 3 with --compare)",
  "  --compare        compare with the stored baseline, case by case (checks it matches before spending anything)",
  "  --store-baseline store this run's results as the baseline for its cases (eval/baselines/, committed)",
  "  --regrade        re-grade a saved report with the current checks instead of running conversations",
  "  --regrade-baseline  re-grade the stored baseline (its cases, or those given with --case) with the current checks",
  "  --max-turns      tester texts before a conversation is cut off (default 20)",
  "  --concurrency    conversations at once (default 3)",
  "  --final          grade with the coach's model instead of Haiku: once, at the end, for the results in the PR",
  "  --dry-run        print what would run and the cost estimate, then stop",
  "  --over-budget    run even past this branch's eval budget (only with Yanni's OK)",
  "",
  "Needs ANTHROPIC_API_KEY in .env (or EVAL_ANTHROPIC_API_KEY, e.g. in a cloud environment where",
  "Claude Code owns ANTHROPIC_API_KEY). EVAL_MODEL overrides the grader model (default: Haiku, or CLAUDE_MODEL with --final);",
  "EVAL_SIM_MODEL the simulated tester (default: Haiku). EVAL_BUDGET_USD caps spend per branch (default: $1 per issue in the branch name, up to $3; $4.50 for \"all\").",
].join("\n");

export interface EvalArgs {
  /** A feature name, or "all" (every feature's cases). */
  feature: string;
  compare: boolean;
  storeBaseline: boolean;
  /** A saved report to re-grade instead of running conversations. */
  regrade?: string;
  regradeBaseline: boolean;
  /** Only these regression case ids, and no scenarios. */
  cases?: string[];
  /** Only these scenario ids. */
  scenarios?: string[];
  persona?: string;
  runs: number;
  maxTurns: number;
  concurrency: number;
  /** Grade with the coach's model rather than Haiku. */
  final: boolean;
  dryRun: boolean;
  overBudget: boolean;
}

export class UsageError extends Error {}

export function parseEvalArgs(argv: string[]): EvalArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        case: { type: "string", multiple: true },
        scenario: { type: "string", multiple: true },
        persona: { type: "string" },
        runs: { type: "string" },
        "max-turns": { type: "string" },
        concurrency: { type: "string" },
        compare: { type: "boolean" },
        "store-baseline": { type: "boolean" },
        regrade: { type: "string" },
        "regrade-baseline": { type: "boolean" },
        final: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "over-budget": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) throw new UsageError("");
  const feature = positionals[0];
  if (!feature) throw new UsageError("Which feature? e.g. npm run eval -- onboarding");
  if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`);
  if (feature !== "all" && !Object.hasOwn(FEATURES, feature)) throw new UsageError(`Unknown feature "${feature}"`);
  if ((values.case || values.scenario) && values.persona) throw new UsageError("--case and --scenario pick exactly what runs; drop --persona");
  if (values.persona && !(PERSONAS as readonly string[]).includes(values.persona)) {
    throw new UsageError(`Unknown persona "${values.persona}"`);
  }
  if (feature === "all" && (values.case || values.scenario || values.persona || values.regrade)) {
    throw new UsageError('"all" runs every feature\'s cases; pick one feature for --case, --scenario, --persona or --regrade');
  }
  if (values.regrade && values["regrade-baseline"]) throw new UsageError("--regrade re-grades a report and --regrade-baseline the baseline; pick one");
  if ((values.regrade || values["regrade-baseline"]) && (values.scenario || values.persona || values.runs)) {
    throw new UsageError("Re-grading runs no conversations; drop --scenario, --persona and --runs");
  }
  if (values.regrade && values.case) throw new UsageError("--regrade re-grades the whole report; drop --case");
  return {
    feature,
    compare: values.compare ?? false,
    storeBaseline: values["store-baseline"] ?? false,
    regrade: values.regrade,
    regradeBaseline: values["regrade-baseline"] ?? false,
    cases: values.case,
    scenarios: values.scenario,
    persona: values.persona,
    // A comparison is 3 runs a case unless told otherwise (#197).
    runs: positiveInt(values.runs, "--runs", values.compare ? 3 : 1),
    maxTurns: positiveInt(values["max-turns"], "--max-turns", 20),
    concurrency: positiveInt(values.concurrency, "--concurrency", 3),
    final: values.final ?? false,
    dryRun: values["dry-run"] ?? false,
    overBudget: values["over-budget"] ?? false,
  };
}

/** Haiku, the default for the eval's cheap roles: the simulated tester and the grader while iterating. */
export const HAIKU = "claude-haiku-5-5";

/**
 * The grader's model: EVAL_MODEL if set; otherwise the coach's model for a --final run, Haiku while iterating.
 * Haiku caught every known mistake in an 8-case calibration (#174) but names fewer secondary problems,
 * so the results Yanni reads come from a --final run.
 */
export function graderModel(env: NodeJS.ProcessEnv, coachModel: string, final: boolean): string {
  return env.EVAL_MODEL?.trim() || (final ? coachModel : HAIKU);
}

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a whole number of at least 1`);
  return n;
}

/**
 * The key the eval (and the coach it runs) uses. EVAL_ANTHROPIC_API_KEY is for Claude Code cloud
 * environments, where ANTHROPIC_API_KEY is reserved for Claude Code's own login.
 */
export function evalApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.ANTHROPIC_API_KEY?.trim() || env.EVAL_ANTHROPIC_API_KEY?.trim() || undefined;
}

/** The message to show when the key is missing, or undefined when it's there. */
export function missingKeyMessage(env: NodeJS.ProcessEnv): string | undefined {
  if (evalApiKey(env)) return undefined;
  return [
    "ANTHROPIC_API_KEY is not set, so the eval can't talk to Claude.",
    "Add it to .env in the repo root (ANTHROPIC_API_KEY=sk-ant-...), then run: npm run eval -- onboarding",
  ].join("\n");
}
