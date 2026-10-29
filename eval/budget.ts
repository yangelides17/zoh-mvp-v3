import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Eval spend per branch, kept in eval/reports/spend.json (gitignored). The budget is $1 per issue
 * the branch builds, up to $3 for a group (Yanni, Oct 29; $1 per branch since Oct 27): run only
 * the cases a change touches (--case); bugs beyond that get found live and in the beta.
 */
export const BUDGET_PER_ISSUE_USD = 1;
export const MAX_BUDGET_USD = 3;

export type Ledger = Record<string, { spentUsd: number; runs: number }>;

/** Issues a branch builds, from its name: feature/41-42-48-nudge-fixes is 3. Any other branch is 1. */
export function issueCount(branch: string): number {
  const numbers = /^feature\/(\d+(?:-\d+)*)(?=-|$)/.exec(branch)?.[1];
  return numbers ? numbers.split("-").length : 1;
}

/** EVAL_BUDGET_USD overrides; otherwise $1 per issue on the branch, at most $3. */
export function budgetFor(env: NodeJS.ProcessEnv, branch: string): number {
  const n = Number(env.EVAL_BUDGET_USD);
  if (Number.isFinite(n) && n > 0) return n;
  return Math.min(MAX_BUDGET_USD, BUDGET_PER_ISSUE_USD * issueCount(branch));
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
    "Run only the cases this change touches (--case <id>), or ask Yanni before rerunning with --over-budget.",
  ].join("\n");
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
