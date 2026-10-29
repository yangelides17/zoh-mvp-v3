import { parseArgs } from "node:util";
import { FEATURES } from "./features.js";
import { PERSONAS } from "./types.js";

export const USAGE = [
  "Usage: npm run eval -- <feature> [--case <id>]... [--scenario <id>]... [--persona <name>] [--runs <n>] [--max-turns <n>] [--concurrency <n>] [--dry-run] [--over-budget]",
  "",
  `  <feature>        one of: ${Object.keys(FEATURES).join(", ")}`,
  "  --case           only this regression case (repeatable), no simulated conversations: the cheap targeted run",
  "  --scenario       only this simulated conversation (repeatable), no regression cases unless --case is given too",
  `  --persona        only scenarios with this persona (${PERSONAS.join(", ")}); regression cases always run`,
  "  --runs           times to play each scenario (default 1)",
  "  --max-turns      tester texts before a conversation is cut off (default 20)",
  "  --concurrency    conversations at once (default 3)",
  "  --dry-run        print what would run and the cost estimate, then stop",
  "  --over-budget    run even past this branch's eval budget (only with Yanni's OK)",
  "",
  "Needs ANTHROPIC_API_KEY in .env (or EVAL_ANTHROPIC_API_KEY, e.g. in a cloud environment where",
  "Claude Code owns ANTHROPIC_API_KEY). EVAL_MODEL sets the grader model (default: CLAUDE_MODEL); EVAL_SIM_MODEL the",
  "simulated tester (default: claude-haiku-5-5). EVAL_BUDGET_USD caps spend per branch (default: $1 per issue in the branch name, up to $3).",
].join("\n");

export interface EvalArgs {
  feature: string;
  /** Only these regression case ids, and no scenarios. */
  cases?: string[];
  /** Only these scenario ids. */
  scenarios?: string[];
  persona?: string;
  runs: number;
  maxTurns: number;
  concurrency: number;
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
  if (!Object.hasOwn(FEATURES, feature)) throw new UsageError(`Unknown feature "${feature}"`);
  if ((values.case || values.scenario) && values.persona) throw new UsageError("--case and --scenario pick exactly what runs; drop --persona");
  if (values.persona && !(PERSONAS as readonly string[]).includes(values.persona)) {
    throw new UsageError(`Unknown persona "${values.persona}"`);
  }
  return {
    feature,
    cases: values.case,
    scenarios: values.scenario,
    persona: values.persona,
    runs: positiveInt(values.runs, "--runs", 1),
    maxTurns: positiveInt(values["max-turns"], "--max-turns", 20),
    concurrency: positiveInt(values.concurrency, "--concurrency", 3),
    dryRun: values["dry-run"] ?? false,
    overBudget: values["over-budget"] ?? false,
  };
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
