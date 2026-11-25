import { WAITS_PER_CASE } from "./simulator.js";
import type { ConversationPlan } from "./types.js";

/** #230: a case with lines that wait for their moment, played by the case tester (a simulator call per such line). */
const waits = (p: ConversationPlan) => p.regression?.testerLines.some((l) => typeof l !== "string") ?? false;

/** $ per million tokens (input, output). Checked Oct 2026; unknown models fall back to Sonnet's. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50 },
};
const FALLBACK = PRICES["claude-sonnet-5-5"]!;

export function priceOf(model: string): { input: number; output: number; known: boolean } {
  const p = PRICES[model];
  return p ? { ...p, known: true } : { ...FALLBACK, known: false };
}

export interface Estimate {
  conversations: number;
  /** Tester texts, worst case (every scenario runs to the turn cap). */
  maxTurns: number;
  tokens: { low: number; high: number };
  dollars: { low: number; high: number };
}

/**
 * Rough per-call sizes, in tokens (thinking included in output):
 * the coach sees up to its history window; the simulator rereads the whole conversation;
 * the grader reads both pages plus the transcript once per conversation.
 */
/**
 * The coach, in input-price tokens (cache reads and writes folded in), fitted to two billed runs on Nov 15: about
 * $0.022 to start a conversation (its 8k to 14k token instructions written to the cache) and $0.019 a reply (each
 * re-reads them, often over several tool rounds). It was 900 in / 250 out, which counted about a fifth of it.
 */
export const COACH = { input: 7_400, output: 450 };
export const COACH_START = { input: 11_000, output: 0 };
/** One overnight memory pass (several tool rounds over the day's texts and pages); memory feature only. */
export const KEEPER = { input: 25_000, output: 3_000 };
const SIM = { inputBase: 600, perTurn: 120, output: 150 };
const GRADER = { inputBase: 1_500, perTurn: 120, output: 4_000 };

export function estimateCost(
  plans: ConversationPlan[],
  /** `gradeOnly`: re-grading saved conversations (#197), so only the grader is paid for. */
  opts: {
    maxTurns: number;
    pagesChars: number;
    coachModel: string;
    evalModel: string;
    simModel?: string;
    /** #230: the model a case's waiting lines use (decisions and replies); the scenario simulator's if not given. */
    caseSimModel?: string;
    memory?: boolean;
    gradeOnly?: boolean;
    /** Grader calls per conversation: one, plus one per `alone` rule (#197). */
    graderCalls?: number;
  },
): Estimate {
  const calls = opts.graderCalls ?? 1;
  const pagesTokens = Math.ceil(opts.pagesChars / 4);
  const run = (turns: number, simulated: boolean) => {
    const coach = opts.gradeOnly ? { input: 0, output: 0 } : { input: COACH_START.input + COACH.input * turns, output: COACH.output * turns };
    let sim = { input: 0, output: 0 };
    if (simulated && !opts.gradeOnly) {
      // The k-th simulator call rereads k-1 earlier exchanges.
      sim = { input: SIM.inputBase * turns + (SIM.perTurn * turns * (turns - 1)) / 2, output: SIM.output * turns };
    }
    const grader = { input: calls * (GRADER.inputBase + pagesTokens + GRADER.perTurn * turns), output: calls * GRADER.output };
    return { coach, sim, grader };
  };
  const coachPrice = priceOf(opts.coachModel);
  const evalPrice = priceOf(opts.evalModel);
  const simPrice = priceOf(opts.simModel ?? opts.evalModel);
  const caseSimPrice = priceOf(opts.caseSimModel ?? opts.simModel ?? opts.evalModel);
  const total = (turnsFor: (p: ConversationPlan) => number) => {
    let tokens = 0;
    let dollars = 0;
    for (const p of plans) {
      const r = run(turnsFor(p), p.kind === "scenario" || waits(p));
      const sp = waits(p) ? caseSimPrice : simPrice;
      if (opts.memory && !opts.gradeOnly) {
        // One overnight pass per conversation, on the coach's model.
        r.coach.input += KEEPER.input;
        r.coach.output += KEEPER.output;
      }
      tokens += r.coach.input + r.coach.output + r.sim.input + r.sim.output + r.grader.input + r.grader.output;
      dollars +=
        (r.coach.input * coachPrice.input +
          r.coach.output * coachPrice.output +
          r.sim.input * sp.input +
          r.sim.output * sp.output +
          r.grader.input * evalPrice.input +
          r.grader.output * evalPrice.output) /
        1_000_000;
    }
    return { tokens, dollars };
  };
  // #230: a case whose lines wait for their moment may add up to WAITS_PER_CASE extra replies.
  const caseTurns = (p: ConversationPlan, extra: number) => (p.regression?.testerLines.length ?? 0) + (waits(p) ? extra : 0);
  // Low: a typical onboarding of ~8 tester texts. High: every scenario hits the turn cap.
  const low = total((p) => (p.kind === "case" ? caseTurns(p, 0) : Math.min(8, opts.maxTurns)));
  const high = total((p) => (p.kind === "case" ? caseTurns(p, WAITS_PER_CASE) : opts.maxTurns));
  return {
    conversations: plans.length,
    maxTurns: plans.reduce((n, p) => n + (p.kind === "case" ? caseTurns(p, WAITS_PER_CASE) : opts.maxTurns), 0),
    tokens: { low: low.tokens, high: high.tokens },
    dollars: { low: low.dollars, high: high.dollars },
  };
}

/** Dollars for measured token usage at one model's prices. */
/** Tokens as the API bills them: cache reads cost 0.1x the input price, cache writes (5 minutes) 1.25x. */
export interface BilledUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export function billedDollars(usage: BilledUsage, model: string): number {
  const p = priceOf(model);
  return ((usage.input + 0.1 * usage.cacheRead + 1.25 * usage.cacheWrite) * p.input + usage.output * p.output) / 1_000_000;
}

export function dollarsFor(usage: { input: number; output: number }, model: string): number {
  const p = priceOf(model);
  return (usage.input * p.input + usage.output * p.output) / 1_000_000;
}
