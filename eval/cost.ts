import type { ConversationPlan } from "./types.js";

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
const COACH = { input: 900, output: 250 };
const SIM = { inputBase: 600, perTurn: 120, output: 150 };
const GRADER = { inputBase: 1_500, perTurn: 120, output: 4_000 };

export function estimateCost(
  plans: ConversationPlan[],
  opts: { maxTurns: number; pagesChars: number; coachModel: string; evalModel: string },
): Estimate {
  const pagesTokens = Math.ceil(opts.pagesChars / 4);
  const run = (turns: number, simulated: boolean) => {
    const coach = { input: COACH.input * turns, output: COACH.output * turns };
    let sim = { input: 0, output: 0 };
    if (simulated) {
      // The k-th simulator call rereads k-1 earlier exchanges.
      sim = { input: SIM.inputBase * turns + (SIM.perTurn * turns * (turns - 1)) / 2, output: SIM.output * turns };
    }
    const grader = { input: GRADER.inputBase + pagesTokens + GRADER.perTurn * turns, output: GRADER.output };
    return { coach, evalIn: sim.input + grader.input, evalOut: sim.output + grader.output };
  };
  const coachPrice = priceOf(opts.coachModel);
  const evalPrice = priceOf(opts.evalModel);
  const total = (turnsFor: (p: ConversationPlan) => number) => {
    let tokens = 0;
    let dollars = 0;
    for (const p of plans) {
      const r = run(turnsFor(p), p.kind === "scenario");
      tokens += r.coach.input + r.coach.output + r.evalIn + r.evalOut;
      dollars +=
        (r.coach.input * coachPrice.input + r.coach.output * coachPrice.output + r.evalIn * evalPrice.input + r.evalOut * evalPrice.output) /
        1_000_000;
    }
    return { tokens, dollars };
  };
  const caseTurns = (p: ConversationPlan) => p.regression?.testerLines.length ?? 0;
  // Low: a typical onboarding of ~8 tester texts. High: every scenario hits the turn cap.
  const low = total((p) => (p.kind === "case" ? caseTurns(p) : Math.min(8, opts.maxTurns)));
  const high = total((p) => (p.kind === "case" ? caseTurns(p) : opts.maxTurns));
  return {
    conversations: plans.length,
    maxTurns: plans.reduce((n, p) => n + (p.kind === "case" ? caseTurns(p) : opts.maxTurns), 0),
    tokens: { low: low.tokens, high: high.tokens },
    dollars: { low: low.dollars, high: high.dollars },
  };
}
