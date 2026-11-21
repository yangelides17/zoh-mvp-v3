/**
 * Checks the simulated tester's decisions (#230), without running the coach: each file in `eval/known-sim/` is a
 * moment from a real eval run (the conversation up to a ZOH text, and which line of a case was waiting) with the
 * decisions a fair tester could make there. Each is asked `--runs` times per model; a moment counts as right only if
 * every run decided right (and, while waiting, the reply kept clear of what it must not give away).
 *
 *   npm run sim-check -- [--model claude-haiku-5-5 --model claude-sonnet-5-5] [--runs 3] [--point <id>]
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { budgetFor, currentBranch, overBudgetMessage, readLedger, recordSpend } from "./budget.js";
import { addUsage, createCompleter, type Completer } from "./claude.js";
import { CASE_SIM_MODEL, evalApiKey, missingKeyMessage } from "./cli.js";
import { dollarsFor } from "./cost.js";
import { REPO_ROOT, REPORTS_DIR } from "./features.js";
import { loadCases } from "./load.js";
import { caseTesterSystemPrompt, decisionSchema, lineDecisionPrompt, waitingReplyPrompt } from "./simulator.js";
import { LINE_VERDICTS, type CaseLine, type LineVerdict, type RegressionCase, type TokenUsage, type TranscriptLine } from "./types.js";

export const KNOWN_SIM_DIR = `${REPO_ROOT}eval/known-sim/`;

export const simPointSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Why these decisions are the fair ones, in a line. */
  why: z.string(),
  /** The case whose line is waiting, "feature/case-id"; its facts, seed and the line itself are read from it. */
  case: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
  /** The waiting line's position in the case's testerLines. */
  line: z.number().int().min(0),
  /** The run so far, ending with ZOH's text the line would answer (after the case's seeded history). */
  transcript: z.array(z.object({ from: z.enum(["tester", "zoh"]), text: z.string().min(1) })).min(1),
  expect: z.array(z.enum(LINE_VERDICTS)).min(1),
  /** While waiting, words the reply must not contain (what a later line is for). */
  replyMustNot: z.array(z.string()).default([]),
});
export type SimPoint = z.infer<typeof simPointSchema>;

export interface SimPointResult {
  id: string;
  model: string;
  decisions: LineVerdict[];
  replies: string[];
  right: boolean;
  why: string;
}

/** Each moment with the case it belongs to and the waiting line. */
export async function loadSimPoints(dir = KNOWN_SIM_DIR): Promise<{ point: SimPoint; c: RegressionCase; line: CaseLine }[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const cases = new Map<string, RegressionCase[]>();
  const out = [];
  for (const file of files) {
    const point = simPointSchema.parse(JSON.parse(await readFile(`${dir}${file}`, "utf8")));
    const [feature, id] = point.case.split("/") as [string, string];
    if (!cases.has(feature)) cases.set(feature, await loadCases(feature));
    const c = cases.get(feature)!.find((x) => x.id === id);
    if (!c) throw new Error(`${file}: no case ${point.case}`);
    const line = c.testerLines[point.line];
    if (!line || typeof line === "string" || line.starts) throw new Error(`${file}: line ${point.line} of ${point.case} doesn't wait for a moment`);
    for (const v of point.expect) if (v === "passed" && !line.optional) throw new Error(`${file}: expects "passed" but the line isn't optional`);
    out.push({ point, c, line });
  }
  return out;
}

/** Asks one moment `runs` times with one model: the decision, and the reply when it waits. */
export async function checkPoint(
  p: { point: SimPoint; c: RegressionCase; line: CaseLine },
  complete: Completer,
  model: string,
  runs: number,
): Promise<{ result: SimPointResult; usage: TokenUsage }> {
  const { point, c, line } = p;
  const at = "2026-11-02T23:00:00Z";
  const transcript: TranscriptLine[] = [...(c.seed?.history ?? []).map((h) => ({ ...h, at })), ...point.transcript.map((l) => ({ ...l, at }))];
  const system = caseTesterSystemPrompt(c);
  let usage: TokenUsage = { input: 0, output: 0 };
  const decisions: LineVerdict[] = [];
  const replies: string[] = [];
  let right = true;
  for (let run = 0; run < runs; run++) {
    const res = await complete({ system, messages: [{ role: "user", content: lineDecisionPrompt(transcript, line, c.testerLines[point.line + 1]) }], maxTokens: 1000, effort: "low", jsonSchema: decisionSchema(line) });
    usage = addUsage(usage, res.usage);
    const decision = (JSON.parse(res.text) as { decision: LineVerdict }).decision;
    decisions.push(decision);
    if (!point.expect.includes(decision)) right = false;
    if (decision === "wait" && point.replyMustNot.length) {
      const reply = await complete({ system, messages: [{ role: "user", content: waitingReplyPrompt(transcript) }], maxTokens: 1000, effort: "low" });
      usage = addUsage(usage, reply.usage);
      replies.push(reply.text);
      if (point.replyMustNot.some((w) => reply.text.toLowerCase().includes(w.toLowerCase()))) right = false;
    }
  }
  return { result: { id: point.id, model, decisions, replies, right, why: point.why }, usage };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { model: { type: "string", multiple: true }, runs: { type: "string", default: "3" }, point: { type: "string", multiple: true } },
  });
  if (existsSync(`${REPO_ROOT}.env`)) process.loadEnvFile(`${REPO_ROOT}.env`);
  const env = process.env;
  const keyProblem = missingKeyMessage(env);
  if (keyProblem) {
    console.error(keyProblem);
    return 1;
  }
  const models = values.model?.length ? values.model : [env.EVAL_CASE_SIM_MODEL?.trim() || CASE_SIM_MODEL];
  const runs = Number(values.runs);
  const points = (await loadSimPoints()).filter((p) => !values.point?.length || values.point.includes(p.point.id));
  if (points.length === 0) {
    console.error(`No moment matches ${values.point?.join(", ")}.`);
    return 1;
  }
  const branch = currentBranch(REPO_ROOT);
  const ledgerPath = `${REPORTS_DIR}spend.json`;
  const budgetUsd = budgetFor(env, branch);
  const spentUsd = (await readLedger(ledgerPath))[branch]?.spentUsd ?? 0;
  // About 2.5k tokens in and 150 out a decision; a sixth of the waits also write a reply.
  const estimate = models.reduce((t, m) => t + dollarsFor({ input: 3_000 * points.length * runs, output: 200 * points.length * runs }, m), 0);
  const tooMuch = overBudgetMessage({ spentUsd, estimateUsd: { low: estimate, high: estimate * 1.5 }, budgetUsd, branch });
  if (tooMuch) {
    console.error(tooMuch);
    return 1;
  }
  console.log(`Simulator check: ${points.length} moments × ${runs} runs × ${models.join(", ")}. About $${estimate.toFixed(2)}.`);
  let spent = 0;
  for (const model of models) {
    const complete = createCompleter({ apiKey: evalApiKey(env)!, model });
    let usage: TokenUsage = { input: 0, output: 0 };
    let right = 0;
    console.log(`\n${model}`);
    for (const p of points) {
      const { result, usage: u } = await checkPoint(p, complete, model, runs);
      usage = addUsage(usage, u);
      if (result.right) right += 1;
      console.log(`  ${result.right ? "✓" : "✗"} ${result.id}: ${result.decisions.join(", ")} (want ${p.point.expect.join(" or ")})${result.replies.length ? ` · replies: ${result.replies.map((r) => JSON.stringify(r)).join(" / ")}` : ""}`);
    }
    const dollars = dollarsFor(usage, model);
    spent += dollars;
    console.log(`  ${right} of ${points.length} moments right on every run · $${dollars.toFixed(3)}`);
  }
  await recordSpend(ledgerPath, branch, spent);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`Simulator check failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
