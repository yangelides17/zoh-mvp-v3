/**
 * Cost tracking for memory lab replays (#147). Estimates cost before a run and
 * records actual spend per night and per run.
 */

import fs from "node:fs";
import path from "node:path";
import { KEEPER, priceOf, dollarsFor } from "../cost.js";

/** Per-run cap: a single replay + grading + forget calls. */
export const PER_RUN_CAP = 8;
/** Per-command cap: total across all runs in one invocation. */
export const COMMAND_CAP = 25;

/** Token estimate for a forget call (small: current memory + request). */
const FORGET_CALL = { input: 5_000, output: 500 };
/** Token estimate for one grader call (one checkpoint batch). */
const GRADER_CALL = { input: 8_000, output: 2_000 };

export interface CostEstimate {
  nights: number;
  forgetCalls: number;
  checkpointBatches: number;
  keeperDollars: number;
  forgetDollars: number;
  graderDollars: number;
  totalDollars: number;
}

/** Estimate cost for one replay run. */
export function estimateRunCost(opts: {
  nights: number;
  forgetCalls: number;
  /** Number of checkpoint batches (2 per checkpoint: one for hold/not-hold, one for probes). */
  checkpointBatches: number;
  keeperModel: string;
  graderModel: string;
}): CostEstimate {
  const keeperPrice = priceOf(opts.keeperModel);
  const graderPrice = priceOf(opts.graderModel);

  const keeperDollars = opts.nights * (
    (KEEPER.input * keeperPrice.input + KEEPER.output * keeperPrice.output) / 1_000_000
  );
  const forgetDollars = opts.forgetCalls * (
    (FORGET_CALL.input * keeperPrice.input + FORGET_CALL.output * keeperPrice.output) / 1_000_000
  );
  const graderDollars = opts.checkpointBatches * (
    (GRADER_CALL.input * graderPrice.input + GRADER_CALL.output * graderPrice.output) / 1_000_000
  );
  const totalDollars = keeperDollars + forgetDollars + graderDollars;

  return {
    nights: opts.nights,
    forgetCalls: opts.forgetCalls,
    checkpointBatches: opts.checkpointBatches,
    keeperDollars,
    forgetDollars,
    graderDollars,
    totalDollars,
  };
}

export interface NightSpend {
  day: number;
  dollars: number;
  usage: { input: number; output: number };
}

export interface RunSpend {
  nights: NightSpend[];
  grading: number;
  forget: number;
  total: number;
}

/** Save spend data to a JSON file in the run directory. */
export function saveSpend(dir: string, spend: RunSpend): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "spend.json"), JSON.stringify(spend, null, 2));
}

/** Calculate dollars for a given usage at a model's price. Re-exports from eval/cost.ts. */
export { dollarsFor, priceOf };
