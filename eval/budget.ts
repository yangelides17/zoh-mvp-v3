import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Eval spend per branch (one branch = one feature), kept in eval/reports/spend.json (gitignored).
 * The default budget is $2 per feature (Yanni, Oct 27): bugs beyond that get found live and in the beta.
 */
export const DEFAULT_BUDGET_USD = 2;

export type Ledger = Record<string, { spentUsd: number; runs: number }>;

export function budgetFrom(env: NodeJS.ProcessEnv): number {
  const n = Number(env.EVAL_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD;
}

export function currentBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export async function readLedger(path: string): Promise<Ledger> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Ledger;
  } catch {
    return {};
  }
}

export async function recordSpend(path: string, branch: string, usd: number): Promise<Ledger> {
  const ledger = await readLedger(path);
  const entry = ledger[branch] ?? { spentUsd: 0, runs: 0 };
  ledger[branch] = { spentUsd: round(entry.spentUsd + usd), runs: entry.runs + 1 };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ledger, null, 2));
  return ledger;
}

/**
 * Whether a run fits: what's been spent on this branch plus the run's likely cost (the midpoint
 * of the estimate) must stay within the budget. Returns the message to show when it doesn't.
 */
export function overBudgetMessage(opts: { spentUsd: number; estimateUsd: { low: number; high: number }; budgetUsd: number; branch: string }): string | undefined {
  const likely = (opts.estimateUsd.low + opts.estimateUsd.high) / 2;
  if (opts.spentUsd + likely <= opts.budgetUsd) return undefined;
  return [
    `Eval budget: $${opts.spentUsd.toFixed(2)} of $${opts.budgetUsd.toFixed(2)} already spent on ${opts.branch}; this run would likely cost about $${likely.toFixed(2)}.`,
    "Run fewer conversations (--persona <name>), or ask Yanni before rerunning with --over-budget.",
  ].join("\n");
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
