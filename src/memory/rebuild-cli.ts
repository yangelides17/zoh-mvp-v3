#!/usr/bin/env tsx
/**
 * Rebuild one tester's v2 memory from their saved texts (#250).
 *
 * Usage: npm run memory:rebuild -- <last 4 digits> [--dry-run] [--snapshots <folder>]
 *
 * Deletes their v2 rows (never v1), replays texts day by day through the v2 writer,
 * and sets memory_version = 'v2'. Needs DATABASE_URL and ANTHROPIC_API_KEY.
 *
 * --snapshots <folder>: write night-NN.json, night-NN.txt and report.json in the
 * lab's snapshot format after each night, so the folder loads in the Memory Lab Viewer.
 */

import { eq, like } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { createDb } from "../db/client.js";
import { testers, type Tester } from "../db/schema.js";
import type { ClaudeModel, ModelRequest, ModelResponse, TokenUsage } from "../claude/replier.js";
import { maskNumber } from "../pipeline/inbound.js";
import { ownsNumber, PRODUCTION_ONLY, type Routing } from "../testers/env.js";
import { updateTester } from "../testers/testers.js";
import { daysDue, KEEPER_MAX_TOKENS, MEMORY_RUN_AT } from "./keeper.js";
import { renderV2Memory, writeV2Day } from "./v2-keeper.js";
import { zonedTime } from "../nudges/schedule.js";
import { deleteV2Memory } from "./v2-store.js";

/** Use the same models the live nightly keeper uses (CLAUDE_MODEL env var, default matches wiring.ts). */
const WRITER_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";
const CHECKER_MODEL = "claude-haiku-4-5-20251001";

function usage(): never {
  console.error("Usage: DATABASE_URL=... ANTHROPIC_API_KEY=... npm run memory:rebuild -- <last 4 digits> [--dry-run] [--snapshots <folder>]");
  process.exit(1);
}

function makeModel(client: Anthropic, modelId: string, maxTokens: number): ClaudeModel {
  return {
    async create(req: ModelRequest): Promise<ModelResponse> {
      const response = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: req.system,
        messages: req.messages,
        tools: req.tools ?? [],
        ...(req.toolChoice ? { tool_choice: req.toolChoice === "none" ? { type: "none" as const } : { type: "auto" as const } } : {}),
      });
      const content: import("../claude/replier.js").ModelBlock[] = [];
      for (const b of response.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Anthropic SDK cache fields
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
    async check() {},
  };
}

const digits = process.argv[2]?.replace(/\D/g, "");
const dryRun = process.argv.includes("--dry-run");
const snapshotsIdx = process.argv.indexOf("--snapshots");
const snapshotsDir = snapshotsIdx !== -1 ? process.argv[snapshotsIdx + 1] : undefined;
if (snapshotsIdx !== -1 && !snapshotsDir) {
  console.error("--snapshots requires a folder path");
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!digits || digits.length < 4 || !dbUrl) usage();
if (!dryRun && !apiKey) {
  console.error("ANTHROPIC_API_KEY is required (use --dry-run to skip)");
  process.exit(1);
}

const { db, close } = createDb(dbUrl);
try {
  // Find the tester
  const found = await db.select().from(testers).where(like(testers.phone, `%${digits}`));
  if (found.length !== 1) {
    console.error(found.length ? `${found.length} testers end in ${digits}; give more digits.` : `No tester ends in ${digits}.`);
    process.exit(1);
  }
  let tester: Tester = found[0]!;
  console.log(`Found: ${tester.name ?? "(no name)"} ${maskNumber(tester.phone)}`);

  // Check owns
  const appEnv = (process.env.RAILWAY_ENVIRONMENT ?? "production") as "staging" | "production";
  const routing: Routing = {
    appEnv,
    devNumbers: (process.env.DEV_NUMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  if (!(await ownsNumber(db, routing, tester.phone))) {
    console.error(`This app (${appEnv}) doesn't own ${maskNumber(tester.phone)}. Run on the right environment.`);
    process.exit(1);
  }

  // Calculate days to replay
  const now = new Date();
  const days = daysDue({ ...tester, memoryThrough: null, memoryV2Through: null }, now);
  console.log(`Days to replay: ${days.length} (${days[0]} to ${days.at(-1)})`);

  // Cost estimate (rough: ~$0.03/night writer + ~$0.005/night checker)
  const estimatedCost = days.length * 0.035;
  console.log(`Estimated cost: ~$${estimatedCost.toFixed(2)}`);

  if (dryRun) {
    console.log("Dry run — no changes made.");
    process.exit(0);
  }

  // Confirm
  console.log(`\nThis will DELETE all v2 memory for ${maskNumber(tester.phone)} and rebuild from their texts.`);
  console.log("V1 memory is untouched. Press Ctrl+C to cancel, or wait 5 seconds...");
  await new Promise((r) => setTimeout(r, 5000));

  // Delete v2 rows
  await deleteV2Memory(db, tester.id);
  console.log("V2 memory deleted.");

  // Set up models
  const client = new Anthropic({ apiKey });
  const writerModel = makeModel(client, WRITER_MODEL, KEEPER_MAX_TOKENS);
  const checkerModel = makeModel(client, CHECKER_MODEL, 256);
  console.log(`Models: writer=${WRITER_MODEL}, checker=${CHECKER_MODEL}`);

  // Replay day by day
  let totalCost = 0;
  const nightRecords: Array<{ day: number; date: string; dollars: number; usage: { input: number; output: number } }> = [];
  for (let i = 0; i < days.length; i++) {
    const date = days[i]!;
    const dayNumber = i + 1;
    const at3am = zonedTime(date, MEMORY_RUN_AT, tester.timeZone);
    let nightUsage = { input: 0, output: 0 };
    const tracking: ClaudeModel = {
      async create(req) {
        const resp = await writerModel.create(req);
        if (resp.usage) {
          nightUsage.input += resp.usage.input;
          nightUsage.output += resp.usage.output;
        }
        return resp;
      },
      async check() {},
    };

    // Reload tester each day (previous night may have changed it)
    const [fresh] = await db.select().from(testers).where(eq(testers.id, tester.id)).limit(1);
    if (fresh) tester = fresh;

    const wrote = await writeV2Day(db, tracking, checkerModel, tester, date, at3am);
    if (wrote) {
      await updateTester(db, tester.id, { memoryV2Through: date });
      tester.memoryV2Through = date;
    }

    // Rough cost: Sonnet input ~$3/M, output ~$15/M; Haiku is negligible
    const cost = (nightUsage.input * 3 + nightUsage.output * 15) / 1_000_000;
    totalCost += cost;
    nightRecords.push({ day: dayNumber, date, dollars: cost, usage: nightUsage });
    console.log(`  ${date}: ${wrote ? "written" : "no texts"} ($${cost.toFixed(3)})`);

    // Write snapshot if requested (dynamic import: eval/ is outside src/ rootDir)
    if (snapshotsDir) {
      const { takeSnapshot, saveSnapshot } = await import("../../eval/memory-lab/snapshot.js");
      const snapshot = await takeSnapshot(db, tester.id, true);
      const rendered = await renderV2Memory(db, tester);
      saveSnapshot(snapshotsDir, dayNumber, snapshot, rendered);
    }
  }

  // Write report.json if snapshots were requested
  if (snapshotsDir) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(join(snapshotsDir, "report.json"), JSON.stringify({
      tester: tester.name ?? maskNumber(tester.phone),
      throughDay: days.length,
      nights: nightRecords,
      spend: { nights: nightRecords, total: totalCost },
    }, null, 2));
    console.log(`Snapshots written to ${snapshotsDir}`);
  }

  // Set memory_version to v2
  await updateTester(db, tester.id, { memoryVersion: "v2" });
  console.log(`\nDone. ${days.length} days replayed, $${totalCost.toFixed(2)} spent.`);
  console.log(`${maskNumber(tester.phone)} is now on memory v2.`);
} finally {
  await close();
}
