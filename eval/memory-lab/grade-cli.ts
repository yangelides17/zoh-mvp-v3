#!/usr/bin/env tsx
/**
 * CLI for re-grading a saved memory lab run (#152 follow-up).
 *
 * Usage: npm run lab:grade -- <run-folder> [options]
 *
 * Reads night-NN.json and night-NN.txt snapshots from the run folder, loads
 * the answer key for the scenario (from report.json), re-grades each checkpoint,
 * and writes updated grading results back to report.json.
 *
 * Options:
 *   --dry-run    Print what would be graded without calling Claude
 */

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeModel, ModelRequest, ModelResponse } from "../../src/claude/replier.js";
import { loadAnswerKey, gradeRun, type GradeResult } from "./grader.js";
import type { MemorySnapshot } from "./snapshot.js";
import { dollarsFor, PER_RUN_CAP, COMMAND_CAP } from "./cost.js";

function usage(): never {
  console.error("Usage: npm run lab:grade -- <run-folder> [options]");
  console.error("");
  console.error("Re-grades saved snapshots from a previous run without replaying nights.");
  console.error("");
  console.error("Options:");
  console.error("  --dry-run    Print what would be graded, no Claude calls");
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const folder = args[0];
  if (!folder || folder.startsWith("-")) usage();
  const dryRun = args.includes("--dry-run");
  return { folder, dryRun };
}

/** Wrap the Anthropic SDK as a ClaudeModel with the same settings as replay-cli. */
function makeModel(client: Anthropic, modelId: string): ClaudeModel {
  return {
    async create(req: ModelRequest): Promise<ModelResponse> {
      const response = await client.messages.create({
        model: modelId,
        max_tokens: 16384,
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

interface SavedReport {
  scenario: string;
  startDate?: string;
  throughDay?: number;
  memoryVersion?: string;
  nights?: Array<{ day: number; date: string; failed: boolean; error?: string; [key: string]: unknown }>;
  grading?: unknown;
  gradingError?: string;
  unresolvedForgets?: unknown[];
  spend?: unknown;
  estimate?: unknown;
  [key: string]: unknown;
}

async function main() {
  const { folder, dryRun } = parseArgs(process.argv);

  // Resolve folder path (absolute or relative to cwd)
  const runDir = path.resolve(folder);
  if (!fs.existsSync(runDir)) {
    console.error(`Run folder not found: ${runDir}`);
    process.exit(1);
  }

  // Read report.json to get the scenario name
  const reportPath = path.join(runDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    console.error(`No report.json found in ${runDir}`);
    process.exit(1);
  }
  const report: SavedReport = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  const scenario = report.scenario;
  if (!scenario) {
    console.error("report.json has no scenario field");
    process.exit(1);
  }

  // Load the answer key for this scenario
  const answerKey = loadAnswerKey(scenario);

  // Load snapshots from night-NN.json and night-NN.txt files
  const snapshotMap = new Map<number, { snapshot: MemorySnapshot; rendered: string }>();
  const nightPattern = /^night-(\d+)\.json$/;
  const files = fs.readdirSync(runDir).filter((f) => nightPattern.test(f)).sort();

  for (const file of files) {
    const match = nightPattern.exec(file);
    if (!match) continue;
    const day = Number(match[1]);

    const jsonPath = path.join(runDir, file);
    const txtPath = path.join(runDir, file.replace(".json", ".txt"));

    const snapshot: MemorySnapshot = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const rendered = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf-8") : "";

    // Only include nights that didn't fail (check report if available)
    const nightInfo = report.nights?.find((n) => n.day === day);
    if (nightInfo?.failed) continue;

    snapshotMap.set(day, { snapshot, rendered });
  }

  // Check which checkpoints will be graded
  const checkpointDays = answerKey.checkpoints
    .filter((cp) => snapshotMap.has(cp.after_day))
    .map((cp) => cp.after_day);

  console.log(`Scenario: ${scenario}`);
  console.log(`Snapshots loaded: ${snapshotMap.size} nights`);
  console.log(`Checkpoints to grade: ${checkpointDays.length} (days: ${checkpointDays.join(", ")})`);

  if (checkpointDays.length === 0) {
    console.log("No checkpoint days match available snapshots. Nothing to grade.");
    return;
  }

  if (dryRun) {
    console.log("\nDry run: would grade the above checkpoints. No Claude calls made.");
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const graderModelName = "claude-haiku-5-5";
  const client = new Anthropic({ apiKey });
  const graderModel = makeModel(client, graderModelName);

  console.log(`\nGrading with ${graderModelName}...`);

  const grading: GradeResult = await gradeRun(graderModel, answerKey, snapshotMap);
  const gradingSpend = dollarsFor(grading.usage, graderModelName);

  // Check cost caps
  if (gradingSpend > PER_RUN_CAP) {
    console.error(`Grading spend $${gradingSpend.toFixed(2)} exceeds per-run cap of $${PER_RUN_CAP}`);
    process.exit(1);
  }

  // Print results
  console.log("\nGrading results:");
  for (const cp of grading.checkpoints) {
    if (cp.error) {
      console.log(`  Day ${cp.afterDay}: ERROR - ${cp.error}`);
      continue;
    }
    const contradictions = [...cp.mustHold, ...cp.mustNotHold].filter((v) => v.contradicted).length;
    const suffix = contradictions > 0 ? ` (${contradictions} contradicted)` : "";
    console.log(`  Day ${cp.afterDay}: must_hold=${cp.mustHoldScore.toFixed(2)} must_not_hold=${cp.mustNotHoldScore.toFixed(2)} probes=${cp.probeScore.toFixed(2)}${suffix}`);
  }
  console.log(`\nGrading spend: $${gradingSpend.toFixed(2)}`);

  // Update report.json with new grading results, preserving existing night data
  const updatedReport = {
    ...report,
    grading: {
      checkpoints: grading.checkpoints.map((c) => ({
        afterDay: c.afterDay,
        mustHoldScore: c.mustHoldScore,
        mustNotHoldScore: c.mustNotHoldScore,
        probeScore: c.probeScore,
        nearDuplicates: c.nearDuplicates,
        error: c.error,
        mustHold: c.mustHold.map((v) => ({ id: v.id, present: v.present, evidence: v.evidence, contradicted: v.contradicted, reasoning: v.reasoning })),
        mustNotHold: c.mustNotHold.map((v) => ({ id: v.id, present: v.present, evidence: v.evidence, contradicted: v.contradicted, reasoning: v.reasoning })),
        probes: c.probes.map((v) => ({ id: v.id, correct: v.correct, reasoning: v.reasoning })),
      })),
    },
    gradingError: undefined,
  };

  fs.writeFileSync(reportPath, JSON.stringify(updatedReport, null, 2));
  console.log(`\nUpdated: ${reportPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
