/**
 * Memory lab replay runner (#147). Creates a PGlite database, loads a scenario's fixtures,
 * then steps through each day calling the real `writeDay` and any live-write events.
 * After each night it snapshots memory and runs free checks; after all nights it grades
 * checkpoint nights against the answer key.
 */

import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { messages, testers, type Tester } from "../../src/db/schema.js";
import type { Db } from "../../src/db/client.js";
import { migrationsFolder } from "../../src/db/paths.js";
import type { ClaudeModel } from "../../src/claude/replier.js";
import { writeDay } from "../../src/memory/keeper.js";
import { memoryBlock } from "../../src/memory/context.js";
import { runMemoryTool, type LookupBudget } from "../../src/memory/coach-tools.js";
import { getPages } from "../../src/memory/store.js";
import { renderPage } from "../../src/memory/render.js";
import { updateTester } from "../../src/testers/testers.js";
import { loadScenarioIncremental, parseFixture, resolveTime, resolveDate, type Fixture, type LiveWrite } from "../../src/synthetic/loader.js";
import { takeSnapshot, saveSnapshot, type MemorySnapshot } from "./snapshot.js";
import { runChecks, type CheckResult } from "./checks.js";
import { loadAnswerKey, gradeRun, type GradeResult } from "./grader.js";
import {
  estimateRunCost,
  dollarsFor,
  saveSpend,
  PER_RUN_CAP,
  COMMAND_CAP,
  type CostEstimate,
  type NightSpend,
  type RunSpend,
} from "./cost.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

export interface ReplayOptions {
  scenario: string;
  startDate: Date;
  throughDay?: number;
  /** Memory version: "current" uses the real writeDay; future versions will be added. */
  memoryVersion?: string;
  /** Keeper model (the one that writes memory). */
  keeperModel: ClaudeModel;
  /** Grader model (scores checkpoints). */
  graderModel: ClaudeModel;
  /** Model name for cost estimation (e.g. "claude-haiku-5-5"). */
  keeperModelName: string;
  graderModelName: string;
  /** Directory to write results to. */
  outputDir: string;
  /** If true, print estimate and exit without running. */
  dryRun?: boolean;
  /** Override caps for testing. */
  perRunCap?: number;
  commandCap?: number;
}

export interface NightResult {
  day: number;
  date: string;
  snapshot: MemorySnapshot;
  rendered: string;
  checks: CheckResult;
  spend: NightSpend;
  failed: boolean;
  error?: string;
}

/** A forget request that could not be resolved or failed (#149). */
export interface UnresolvedForget {
  day: number;
  request: string;
  reason: string;
}

export interface ReplayResult {
  scenario: string;
  nights: NightResult[];
  grading?: GradeResult;
  gradingError?: string;
  unresolvedForgets: UnresolvedForget[];
  spend: RunSpend;
  estimate: CostEstimate;
}

/** Load fixture files for a scenario. */
function loadFixtures(scenario: string): Fixture[] {
  const pattern = new RegExp(`^${scenario}\\.week(\\d+)\\.json$`);
  let files: string[];
  try {
    files = fs.readdirSync(FIXTURES_DIR).filter((f) => pattern.test(f)).sort((a, b) => {
      const weekA = Number(pattern.exec(a)![1]);
      const weekB = Number(pattern.exec(b)![1]);
      return weekA - weekB;
    });
  } catch {
    throw new Error(`Could not read fixtures directory: ${FIXTURES_DIR}`);
  }
  if (files.length === 0) throw new Error(`No fixture files for scenario "${scenario}" in ${FIXTURES_DIR}`);
  return files.map((file) => parseFixture(fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8"), file));
}

/** Create a fresh PGlite database, migrated and ready. */
export async function createReplayDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, client };
}

/** Find the last day with inbound messages in the fixture data. */
function lastDayWithTexts(fixtures: Fixture[]): number {
  let max = 0;
  for (const f of fixtures) {
    for (const msg of f.messages) {
      if (msg.from === "tester" && msg.day > max) max = msg.day;
    }
  }
  return max;
}

/** Count forget events up to a given day. */
function countForgetEvents(liveWrites: LiveWrite[], throughDay: number): number {
  return liveWrites.filter((w) => w.kind === "forget" && w.day <= throughDay).length;
}

/** Count checkpoint batches (2 per checkpoint with statements or probes). */
function countCheckpointBatches(scenario: string, throughDay: number): number {
  try {
    const key = loadAnswerKey(scenario);
    let batches = 0;
    for (const cp of key.checkpoints) {
      if (cp.after_day > throughDay) continue;
      if (cp.must_hold.length > 0 || cp.must_not_hold.length > 0) batches++;
      if (cp.probes.length > 0) batches++;
    }
    return batches;
  } catch {
    return 0;
  }
}

/**
 * Run a single replay. Importable for tests.
 */
export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  if (opts.memoryVersion && opts.memoryVersion !== "current") {
    throw new Error(`Unknown memory version "${opts.memoryVersion}"; only "current" is supported.`);
  }

  const fixtures = loadFixtures(opts.scenario);
  const throughDay = opts.throughDay ?? lastDayWithTexts(fixtures);

  // Parse liveWrites from fixtures directly for cost estimation (before DB exists)
  const liveWrites: LiveWrite[] = [];
  for (const f of fixtures) {
    for (const event of f.events) {
      if (event.kind === "stated_preference") {
        liveWrites.push({ kind: "stated_preference", day: event.day, time: event.time, preference: event.preference, replaces: event.replaces });
      } else if (event.kind === "forget") {
        liveWrites.push({ kind: "forget", day: event.day, time: event.time, request: event.request });
      }
    }
  }

  const forgetCalls = countForgetEvents(liveWrites, throughDay);
  const checkpointBatches = countCheckpointBatches(opts.scenario, throughDay);
  const estimate = estimateRunCost({
    nights: throughDay,
    forgetCalls,
    checkpointBatches,
    keeperModel: opts.keeperModelName,
    graderModel: opts.graderModelName,
  });

  // Check caps
  const cap = opts.perRunCap ?? PER_RUN_CAP;
  if (estimate.totalDollars > cap) {
    throw new Error(`Estimated cost $${estimate.totalDollars.toFixed(2)} exceeds per-run cap of $${cap}`);
  }

  if (opts.dryRun) {
    return {
      scenario: opts.scenario,
      nights: [],
      unresolvedForgets: [],
      spend: { nights: [], grading: 0, forget: 0, total: 0 },
      estimate,
    };
  }

  // Create fresh database and load fixtures incrementally (#150)
  const { db, client } = await createReplayDb();
  try {
    const inc = await loadScenarioIncremental(db, fixtures, opts.startDate);
    let tester: Tester = inc.tester;

    const nights: NightResult[] = [];
    const nightSpends: NightSpend[] = [];
    let totalForgetSpend = 0;
    let previousSnapshot: MemorySnapshot | undefined;
    const unresolvedForgets: UnresolvedForget[] = [];

    // Iterate days
    for (let day = 1; day <= throughDay; day++) {
      const date = resolveDate(opts.startDate, day);
      const at3am = resolveTime(opts.startDate, day + 1, "03:00", tester.timeZone);

      // Insert all fixture data through 3 am of the next day (#150).
      // This matches production: the 3 am pass's database holds texts sent up to 3 am.
      await inc.insertThrough(at3am);

      // Reload tester in case insertThrough updated it (phase, name, goalSlug, etc.)
      const [freshAfterLoad] = await db.select().from(testers).where(eq(testers.id, tester.id)).limit(1);
      if (freshAfterLoad) tester = freshAfterLoad;

      // 1. Apply stated_preference events for this day
      for (const w of inc.liveWrites) {
        if (w.kind !== "stated_preference" || w.day !== day) continue;
        const prefAt = resolveTime(opts.startDate, w.day, w.time, tester.timeZone);
        // Find the nearest inbound message to use as source
        const [nearestMsg] = await db
          .select()
          .from(messages)
          .where(eq(messages.contactNumber, tester.phone))
          .orderBy(messages.createdAt)
          .limit(1);
        const budget: LookupBudget = { lookups: 0, searches: 0 };
        const result = await runMemoryTool(db, tester, "save_preference", {
          preference: w.preference,
          replaces: w.replaces,
        }, { at: prefAt, budget, sourceMessageId: nearestMsg?.id });
        if (result.ok) tester = result.tester;
      }

      // 2. Apply forget events for this day (#149: full refs via getPages + renderPage)
      for (const w of inc.liveWrites) {
        if (w.kind !== "forget" || w.day !== day) continue;
        const forgetAt = resolveTime(opts.startDate, w.day, w.time, tester.timeZone);
        // Render every page with refs so the model sees p: and f: identifiers (#149)
        const allPages = await getPages(db, tester.id);
        const renderedPages = await Promise.all(
          allPages.map((page) => renderPage(db, tester, page, { refs: true })),
        );
        const fullMemory = renderedPages.join("\n\n");
        const forgetPrompt = `The tester said: "${w.request}". Based on their memory below, identify which facts and/or pages to forget. Return a JSON object with the fields the forget tool expects: { "facts": ["f:ref", ...], "pages": ["p:ref", ...], "note": "brief description" }

MEMORY:
${fullMemory}`;
        const response = await opts.keeperModel.create({
          system: [{ type: "text", text: "Identify memory items to forget. Respond with JSON only." }],
          messages: [{ role: "user", content: forgetPrompt }],
          tools: [],
        });
        const forgetUsage = response.usage ?? { input: 0, output: 0 };
        totalForgetSpend += dollarsFor(forgetUsage, opts.keeperModelName);

        const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
        const jsonStr = text.replace(/^```json?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
        try {
          const forgetInput = JSON.parse(jsonStr) as Record<string, unknown>;
          const budget: LookupBudget = { lookups: 0, searches: 0 };
          const result = await runMemoryTool(db, tester, "forget", forgetInput, { at: forgetAt, budget });
          if (result.ok) {
            tester = result.tester;
          } else {
            // Forget tool returned an error (#149)
            unresolvedForgets.push({ day, request: w.request, reason: result.error });
          }
        } catch (err) {
          // JSON parse failed or other error (#149)
          unresolvedForgets.push({
            day,
            request: w.request,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 3. Call writeDay
      let failed = false;
      let error: string | undefined;
      let nightUsage = { input: 0, output: 0 };

      // Create a wrapping model that tracks usage
      const trackingModel: ClaudeModel = {
        async create(req) {
          const resp = await opts.keeperModel.create(req);
          if (resp.usage) {
            nightUsage.input += resp.usage.input;
            nightUsage.output += resp.usage.output;
          }
          return resp;
        },
        async check() { await opts.keeperModel.check(); },
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Reload tester in case previous night changed it
          const fresh = await db.select().from(testers).where(eq(testers.id, tester.id)).limit(1);
          if (fresh[0]) tester = fresh[0];

          await writeDay(db, trackingModel, tester, date, at3am);
          failed = false;
          error = undefined;
          break;
        } catch (err) {
          failed = true;
          error = err instanceof Error ? err.message : String(err);
          if (attempt === 0) {
            // Retry once
            nightUsage = { input: 0, output: 0 };
          }
        }
      }

      // 4. Update memory_through
      if (!failed) {
        await updateTester(db, tester.id, { memoryThrough: date });
        tester.memoryThrough = date;
      }

      // 5. Snapshot
      const snapshot = await takeSnapshot(db, tester.id);
      const rendered = await memoryBlock(db, tester);

      // 6. Save snapshot
      saveSnapshot(opts.outputDir, day, snapshot, rendered);

      // 7. Free checks
      const checks = runChecks(snapshot, rendered, previousSnapshot);
      previousSnapshot = snapshot;

      const nightDollars = dollarsFor(nightUsage, opts.keeperModelName);
      const nightSpend: NightSpend = { day, dollars: nightDollars, usage: nightUsage };
      nightSpends.push(nightSpend);

      nights.push({ day, date, snapshot, rendered, checks, spend: nightSpend, failed, error });
    }

    // Grade checkpoint nights
    let grading: GradeResult | undefined;
    let gradingSpend = 0;
    let gradingError: string | undefined;
    try {
      const answerKey = loadAnswerKey(opts.scenario);
      const snapshotMap = new Map<number, { snapshot: MemorySnapshot; rendered: string }>();
      for (const n of nights) {
        if (!n.failed) snapshotMap.set(n.day, { snapshot: n.snapshot, rendered: n.rendered });
      }
      grading = await gradeRun(opts.graderModel, answerKey, snapshotMap);
      gradingSpend = dollarsFor(grading.usage, opts.graderModelName);
    } catch (err) {
      gradingError = err instanceof Error ? err.message : String(err);
    }

    const totalNightSpend = nightSpends.reduce((sum, n) => sum + n.dollars, 0);
    const spend: RunSpend = {
      nights: nightSpends,
      grading: gradingSpend,
      forget: totalForgetSpend,
      total: totalNightSpend + gradingSpend + totalForgetSpend,
    };
    saveSpend(opts.outputDir, spend);

    // Save report (#150: include full assertion details, #149: include unresolvedForgets)
    const report = {
      scenario: opts.scenario,
      startDate: opts.startDate.toISOString().slice(0, 10),
      throughDay,
      memoryVersion: opts.memoryVersion ?? "current",
      nights: nights.map((n) => ({
        day: n.day,
        date: n.date,
        failed: n.failed,
        error: n.error,
        checks: n.checks,
        spend: n.spend,
      })),
      grading: grading ? {
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
      } : undefined,
      gradingError,
      unresolvedForgets,
      spend,
      estimate,
    };
    fs.mkdirSync(opts.outputDir, { recursive: true });
    fs.writeFileSync(path.join(opts.outputDir, "report.json"), JSON.stringify(report, null, 2));

    return { scenario: opts.scenario, nights, grading, gradingError, unresolvedForgets, spend, estimate };
  } finally {
    await client.close();
  }
}

/**
 * Run multiple replays for stability analysis.
 */
export async function runMultipleReplays(
  opts: ReplayOptions & { runs: number },
): Promise<ReplayResult[]> {
  const commandCap = opts.commandCap ?? COMMAND_CAP;

  // Estimate total cost across all runs
  const fixtures = loadFixtures(opts.scenario);
  const throughDay = opts.throughDay ?? lastDayWithTexts(fixtures);

  const liveWrites: LiveWrite[] = [];
  for (const f of fixtures) {
    for (const event of f.events) {
      if (event.kind === "stated_preference") {
        liveWrites.push({ kind: "stated_preference", day: event.day, time: event.time, preference: event.preference, replaces: event.replaces });
      } else if (event.kind === "forget") {
        liveWrites.push({ kind: "forget", day: event.day, time: event.time, request: event.request });
      }
    }
  }

  const forgetCalls = countForgetEvents(liveWrites, throughDay);
  const checkpointBatches = countCheckpointBatches(opts.scenario, throughDay);
  const singleEstimate = estimateRunCost({
    nights: throughDay,
    forgetCalls,
    checkpointBatches,
    keeperModel: opts.keeperModelName,
    graderModel: opts.graderModelName,
  });

  const totalEstimate = singleEstimate.totalDollars * opts.runs;
  if (totalEstimate > commandCap) {
    throw new Error(`Estimated total cost $${totalEstimate.toFixed(2)} for ${opts.runs} runs exceeds command cap of $${commandCap}`);
  }

  const results: ReplayResult[] = [];
  for (let i = 0; i < opts.runs; i++) {
    const runId = `${opts.scenario}-${Date.now()}-${i}`;
    const runDir = path.join(path.dirname(opts.outputDir), runId);
    const result = await runReplay({ ...opts, outputDir: runDir });
    results.push(result);
  }
  return results;
}
