/**
 * Memory lab grader (#147). Scores memory snapshots against answer key checkpoints
 * using a Claude model (default: Haiku). Batched: one call per checkpoint for
 * must_hold + must_not_hold, and one per checkpoint for probes.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ClaudeModel } from "../../src/claude/replier.js";
import { answerKeySchema, type AnswerKey, type Checkpoint } from "./keys/schema.js";
import type { MemorySnapshot } from "./snapshot.js";
import { stripForGrader } from "./snapshot.js";

export interface StatementVerdict {
  id: string;
  statement: string;
  present: "yes" | "no";
  evidence: string;
  reasoning: string;
  /** True when the code-decided answer (from evidence matching) differs from the model's `present`. */
  contradicted: boolean;
}

export interface ProbeVerdict {
  id: string;
  question: string;
  expected: string;
  answer: string;
  correct: boolean;
  reasoning: string;
}

export interface CheckpointScore {
  afterDay: number;
  mustHold: StatementVerdict[];
  mustNotHold: StatementVerdict[];
  probes: ProbeVerdict[];
  nearDuplicates: string[];
  mustHoldScore: number;
  mustNotHoldScore: number;
  probeScore: number;
}

export interface GradeResult {
  scenario: string;
  checkpoints: CheckpointScore[];
  usage: { input: number; output: number };
}

/** Load and validate an answer key from the keys directory. */
export function loadAnswerKey(scenario: string): AnswerKey {
  const keyPath = path.resolve(import.meta.dirname, "keys", `${scenario}.json`);
  const raw = fs.readFileSync(keyPath, "utf-8");
  const parsed = answerKeySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid answer key ${keyPath}:\n${issues}`);
  }
  return parsed.data;
}

const statementVerdictSchema = z.array(z.object({
  id: z.string(),
  reasoning: z.string(),
  present: z.enum(["yes", "no"]),
  evidence: z.string(),
}));

const probeVerdictSchema = z.array(z.object({
  id: z.string(),
  answer: z.string(),
  correct: z.boolean(),
  reasoning: z.string(),
}));

const duplicateSchema = z.array(z.string());

/** Minimum evidence quote length to attempt matching. */
const MIN_QUOTE_LENGTH = 4;

/**
 * Collapse whitespace, straighten curly quotes and apostrophes, and lowercase
 * so that a model-returned evidence quote can be fuzzy-matched against memory text.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/\\"/g, '"')           // JSON-escaped double quotes → straight
    .replace(/\u201C|\u201D/g, '"') // curly double quotes → straight
    .replace(/\u2018|\u2019/g, "'") // curly single quotes / apostrophes → straight
    .replace(/\s+/g, " ")           // collapse whitespace
    .toLowerCase()
    .trim();
}

/**
 * Decide whether the evidence quote is genuinely found in the memory text.
 * Returns true when the normalized quote appears inside the normalized memory.
 */
function evidenceFoundInMemory(evidence: string, memoryJson: string): boolean {
  if (!evidence || evidence.toLowerCase() === "none" || evidence.length < MIN_QUOTE_LENGTH) return false;
  return normalizeForMatch(memoryJson).includes(normalizeForMatch(evidence));
}

/** Grade all checkpoint nights for one run. */
export async function gradeRun(
  model: ClaudeModel,
  answerKey: AnswerKey,
  snapshots: Map<number, { snapshot: MemorySnapshot; rendered: string }>,
): Promise<GradeResult> {
  const totalUsage = { input: 0, output: 0 };
  const checkpoints: CheckpointScore[] = [];

  for (const cp of answerKey.checkpoints) {
    const entry = snapshots.get(cp.after_day);
    if (!entry) continue;

    const stripped = stripForGrader(entry.snapshot);
    const memoryJson = JSON.stringify({
      pages: stripped.pages.map((p) => ({ id: p.id, kind: p.kind, title: p.title, summary: p.summary, body: p.body, goalSlug: p.goalSlug, status: p.status, date: p.date })),
      facts: stripped.facts.map((f) => ({ id: f.id, pageId: f.pageId, section: f.section, label: f.label, text: f.text, day: f.day })),
      links: stripped.links.map((l) => ({ fromPageId: l.fromPageId, toPageId: l.toPageId, kind: l.kind })),
    }, null, 2);

    const score = await gradeCheckpoint(model, cp, memoryJson, entry.rendered, totalUsage);
    checkpoints.push(score);
  }

  return { scenario: answerKey.scenario, checkpoints, usage: totalUsage };
}

async function gradeCheckpoint(
  model: ClaudeModel,
  cp: Checkpoint,
  memoryJson: string,
  rendered: string,
  usage: { input: number; output: number },
): Promise<CheckpointScore> {
  const mustHold: StatementVerdict[] = [];
  const mustNotHold: StatementVerdict[] = [];
  let nearDuplicates: string[] = [];

  // Batch 1: must_hold + must_not_hold + near-duplicate scan
  if (cp.must_hold.length > 0 || cp.must_not_hold.length > 0) {
    const statementsBlock = [
      ...cp.must_hold.map((s) => `[${s.id}] "${s.statement}"`),
      ...cp.must_not_hold.map((s) => `[${s.id}] "${s.statement}"`),
    ].join("\n");

    const prompt = `You are checking a coaching app's memory system. Below is the structured memory (JSON) for a tester after day ${cp.after_day}.

MEMORY (JSON):
${memoryJson}

STATEMENTS TO CHECK:
${statementsBlock}

For each statement, decide whether the information described is present in the memory above.
- If present, set "present" to "yes" and "evidence" to an exact quote from the memory JSON that supports it.
- If not present, set "present" to "no" and "evidence" to "none".

Also scan the facts for near-duplicates: facts with the same meaning but different wording on the same page.

Respond with JSON only, no other text:
{
  "verdicts": [{ "id": "<statement id>", "reasoning": "<one sentence>", "present": "yes" or "no", "evidence": "<exact quote from memory or none>" }],
  "near_duplicates": ["<description of duplicate pair>"]
}`;

    const response = await model.create({
      system: [{ type: "text", text: "You are an objective grader. Respond with valid JSON only." }],
      messages: [{ role: "user", content: prompt }],
      tools: [],
    });
    if (response.usage) {
      usage.input += response.usage.input;
      usage.output += response.usage.output;
    }

    const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
    // Extract JSON from possible markdown code block
    const jsonStr = text.replace(/^```json?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    try {
      const parsed = JSON.parse(jsonStr) as { verdicts?: unknown; near_duplicates?: unknown };
      const verdicts = statementVerdictSchema.parse(parsed.verdicts ?? []);
      nearDuplicates = duplicateSchema.parse(parsed.near_duplicates ?? []);

      for (const v of verdicts) {
        // Code-decided presence: does the evidence quote actually appear in memory?
        const codePresent = evidenceFoundInMemory(v.evidence, memoryJson);
        const contradicted = (v.present === "yes") !== codePresent;

        const verdict: Omit<StatementVerdict, "statement"> = {
          id: v.id,
          present: codePresent ? "yes" : "no",
          evidence: v.evidence,
          reasoning: v.reasoning,
          contradicted,
        };
        const mh = cp.must_hold.find((s) => s.id === v.id);
        if (mh) mustHold.push({ ...mh, ...verdict });
        const mnh = cp.must_not_hold.find((s) => s.id === v.id);
        if (mnh) mustNotHold.push({ ...mnh, ...verdict });
      }
    } catch {
      // If parsing fails, mark all as unknown
      for (const s of cp.must_hold) mustHold.push({ ...s, present: "no", evidence: "none", reasoning: "Grader response parsing failed", contradicted: false });
      for (const s of cp.must_not_hold) mustNotHold.push({ ...s, present: "yes", evidence: "none", reasoning: "Grader response parsing failed", contradicted: false });
    }
  }

  // Batch 2: probes (see the rendered memory block, not the JSON)
  const probes: ProbeVerdict[] = [];
  if (cp.probes.length > 0) {
    const probesBlock = cp.probes.map((p) => `[${p.id}] Q: "${p.question}" Expected: "${p.expected}"`).join("\n");

    const prompt = `You are grading a coaching app's memory system. Below is the rendered memory block (what the coach sees) for a tester after day ${cp.after_day}.

MEMORY BLOCK:
${rendered}

QUESTIONS TO ANSWER FROM MEMORY ALONE:
${probesBlock}

For each question, answer it using only the memory block above, then judge whether your answer matches the expected answer (correct = the essential meaning matches).

Respond with JSON only:
{ "probes": [{ "id": "<probe id>", "answer": "<your answer>", "correct": true/false, "reasoning": "<one sentence>" }] }`;

    const response = await model.create({
      system: [{ type: "text", text: "You are an objective grader. Respond with valid JSON only." }],
      messages: [{ role: "user", content: prompt }],
      tools: [],
    });
    if (response.usage) {
      usage.input += response.usage.input;
      usage.output += response.usage.output;
    }

    const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
    const jsonStr = text.replace(/^```json?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    try {
      const parsed = JSON.parse(jsonStr) as { probes?: unknown };
      const pvs = probeVerdictSchema.parse(parsed.probes ?? []);
      for (const pv of pvs) {
        const original = cp.probes.find((p) => p.id === pv.id);
        if (original) probes.push({ ...original, answer: pv.answer, correct: pv.correct, reasoning: pv.reasoning });
      }
    } catch {
      for (const p of cp.probes) probes.push({ ...p, answer: "(grader failed)", correct: false, reasoning: "Grader response parsing failed" });
    }
  }

  // Scores: must_hold passes when code-decided present, must_not_hold passes when code-decided absent
  const mustHoldScore = mustHold.length > 0 ? mustHold.filter((v) => v.present === "yes").length / mustHold.length : 1;
  const mustNotHoldScore = mustNotHold.length > 0 ? mustNotHold.filter((v) => v.present === "no").length / mustNotHold.length : 1;
  const probeScore = probes.length > 0 ? probes.filter((v) => v.correct).length / probes.length : 1;

  return {
    afterDay: cp.after_day,
    mustHold,
    mustNotHold,
    probes,
    nearDuplicates,
    mustHoldScore,
    mustNotHoldScore,
    probeScore,
  };
}
