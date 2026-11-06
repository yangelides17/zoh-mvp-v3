#!/usr/bin/env tsx
/**
 * CLI for memory lab replay (#147).
 *
 * Usage: npm run lab:replay -- <scenario> --start <YYYY-MM-DD> [options]
 *
 * Options:
 *   --start <YYYY-MM-DD>   Monday start date (required)
 *   --through-day <N>      Replay only through day N (default: last day with texts)
 *   --runs <N>             Run N times for stability analysis (default: 1)
 *   --memory <version>     Memory version to test (default: "current")
 *   --dry-run              Print cost estimate and exit
 */

import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeModel, ModelRequest, ModelResponse } from "../../src/claude/replier.js";
import { runReplay, runMultipleReplays } from "./replay.js";
import { PER_RUN_CAP, COMMAND_CAP } from "./cost.js";

function usage(): never {
  console.error("Usage: npm run lab:replay -- <scenario> --start <YYYY-MM-DD> [options]");
  console.error("");
  console.error("Options:");
  console.error("  --start <YYYY-MM-DD>   Monday start date (required)");
  console.error("  --through-day <N>      Replay only through day N");
  console.error("  --runs <N>             Run N times for stability (default: 1)");
  console.error("  --memory <version>     Memory version (default: current)");
  console.error("  --dry-run              Print cost estimate, no Claude calls");
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const scenario = args[0];
  if (!scenario || scenario.startsWith("-")) usage();

  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const startStr = get("--start");
  if (!startStr) usage();
  const startDate = new Date(`${startStr}T00:00:00Z`);
  if (isNaN(startDate.getTime())) {
    console.error(`Invalid date: ${startStr}`);
    process.exit(1);
  }
  if (startDate.getUTCDay() !== 1) {
    console.error(`Start date must be a Monday, got ${startStr}`);
    process.exit(1);
  }

  const throughDay = get("--through-day") ? Number(get("--through-day")) : undefined;
  const runs = get("--runs") ? Number(get("--runs")) : 1;
  const memoryVersion = get("--memory") ?? "current";
  const dryRun = args.includes("--dry-run");

  return { scenario, startDate, throughDay, runs, memoryVersion, dryRun };
}

/** Wrap the Anthropic SDK as a ClaudeModel. */
function makeModel(client: Anthropic, modelId: string): ClaudeModel {
  return {
    async create(req: ModelRequest): Promise<ModelResponse> {
      const response = await client.messages.create({
        model: modelId,
        max_tokens: 8192,
        system: req.system,
        messages: req.messages,
        tools: req.tools ?? [],
        ...(req.toolChoice ? { tool_choice: req.toolChoice === "none" ? { type: "none" as const } : { type: "auto" as const } } : {}),
      });
      const content: import("../../src/claude/replier.js").ModelBlock[] = [];
      for (const b of response.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Anthropic SDK types for cache fields
      const rawUsage = response.usage as any;
      return {
        content,
        stopReason: response.stop_reason ?? "end_turn",
        usage: {
          input: response.usage.input_tokens,
          cacheRead: rawUsage.cache_read_input_tokens ?? 0,
          cacheWrite: rawUsage.cache_creation_input_tokens ?? 0,
          output: response.usage.output_tokens,
        },
        raw: response.content,
      };
    },
    async check() {
      // No-op for CLI
    },
  };
}

async function main() {
  const { scenario, startDate, throughDay, runs, memoryVersion, dryRun } = parseArgs(process.argv);

  const keeperModelName = "claude-sonnet-5-5";
  const graderModelName = "claude-haiku-5-5";

  if (dryRun) {
    // Dry run: estimate only, no API key needed
    const result = await runReplay({
      scenario,
      startDate,
      throughDay,
      memoryVersion,
      keeperModel: { create: async () => { throw new Error("dry run"); }, check: async () => {} },
      graderModel: { create: async () => { throw new Error("dry run"); }, check: async () => {} },
      keeperModelName,
      graderModelName,
      outputDir: path.resolve(import.meta.dirname, "runs", `${scenario}-dry-${Date.now()}`),
      dryRun: true,
    });
    console.log("\nDry run estimate:");
    console.log(`  Nights: ${result.estimate.nights}`);
    console.log(`  Forget calls: ${result.estimate.forgetCalls}`);
    console.log(`  Checkpoint batches: ${result.estimate.checkpointBatches}`);
    console.log(`  Keeper cost: $${result.estimate.keeperDollars.toFixed(2)}`);
    console.log(`  Forget cost: $${result.estimate.forgetDollars.toFixed(2)}`);
    console.log(`  Grader cost: $${result.estimate.graderDollars.toFixed(2)}`);
    console.log(`  Total: $${result.estimate.totalDollars.toFixed(2)}`);
    console.log(`  Per-run cap: $${PER_RUN_CAP}`);
    if (runs > 1) {
      console.log(`  ${runs} runs total: $${(result.estimate.totalDollars * runs).toFixed(2)}`);
      console.log(`  Command cap: $${COMMAND_CAP}`);
    }
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const keeperModel = makeModel(client, keeperModelName);
  const graderModel = makeModel(client, graderModelName);

  const baseOpts = {
    scenario,
    startDate,
    throughDay,
    memoryVersion,
    keeperModel,
    graderModel,
    keeperModelName,
    graderModelName,
    outputDir: path.resolve(import.meta.dirname, "runs", `${scenario}-${Date.now()}`),
  };

  if (runs > 1) {
    console.log(`Running ${runs} replays of "${scenario}"...`);
    const results = await runMultipleReplays({ ...baseOpts, runs });
    console.log("\nStability summary:");
    // Per-checkpoint min/max/mean across runs
    const allCheckpoints = results.flatMap((r) => r.grading?.checkpoints ?? []);
    const byDay = new Map<number, typeof allCheckpoints>();
    for (const cp of allCheckpoints) {
      const list = byDay.get(cp.afterDay) ?? [];
      list.push(cp);
      byDay.set(cp.afterDay, list);
    }
    for (const [day, cps] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
      const mh = cps.map((c) => c.mustHoldScore);
      const mnh = cps.map((c) => c.mustNotHoldScore);
      const pr = cps.map((c) => c.probeScore);
      const stats = (arr: number[]) => ({
        min: Math.min(...arr).toFixed(2),
        max: Math.max(...arr).toFixed(2),
        mean: (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2),
      });
      console.log(`  Day ${day}: must_hold ${JSON.stringify(stats(mh))}, must_not_hold ${JSON.stringify(stats(mnh))}, probes ${JSON.stringify(stats(pr))}`);
    }
    console.log(`\nTotal spend: $${results.reduce((s, r) => s + r.spend.total, 0).toFixed(2)}`);
  } else {
    console.log(`Replaying "${scenario}"...`);
    const result = await runReplay(baseOpts);
    console.log(`\nCompleted ${result.nights.length} nights.`);
    const failed = result.nights.filter((n) => n.failed);
    if (failed.length > 0) {
      console.log(`Failed nights: ${failed.map((n) => n.day).join(", ")}`);
    }
    if (result.grading) {
      console.log("\nGrading:");
      for (const cp of result.grading.checkpoints) {
        console.log(`  Day ${cp.afterDay}: must_hold=${cp.mustHoldScore.toFixed(2)} must_not_hold=${cp.mustNotHoldScore.toFixed(2)} probes=${cp.probeScore.toFixed(2)}`);
      }
    }
    console.log(`\nSpend: $${result.spend.total.toFixed(2)}`);
    console.log(`Report: ${path.join(baseOpts.outputDir, "report.json")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
