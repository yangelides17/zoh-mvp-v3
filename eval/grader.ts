import { localTime } from "./clock.js";
import { addUsage, type Completer } from "./claude.js";
import type { RubricRule } from "./features.js";
import { gradeSchema, type ConversationPlan, type Grade, type TokenUsage, type TranscriptLine } from "./types.js";

export interface GraderInput {
  plan: ConversationPlan;
  /** A seeded conversation before the graded part; shown for context only. */
  context?: TranscriptLine[];
  transcript: TranscriptLine[];
  /** ZOH's memory pages after the overnight pass (memory feature), graded with the conversation. */
  memory?: string;
  /** The tester's step log as ZOH saw it (console feature). */
  record?: string;
  rubric: RubricRule[];
  /** The feature's approved checks and the voice page, read at run time. */
  pages: { rules: string; voice: string };
}

export function graderSystemPrompt(input: Pick<GraderInput, "rubric" | "pages">): string {
  const ids = (scope: RubricRule["scope"]) =>
    input.rubric.filter((r) => r.scope === scope).map((r) => `- ${r.id}: ${r.label}`);
  return [
    "You grade text conversations between ZOH, an AI coach that texts people over iMessage, and a new tester.",
    "You have never seen ZOH's code or instructions. Judge only what is in the transcript, against the written rules below.",
    "Judge like a reasonable person reading these texts: pass when the text follows the spirit of the rule, fail only on a clear miss,",
    "and mark borderline when it could go either way. Quote or point at the exact words when something fails.",
    "",
    "=== This feature's rules (approved by the founders) ===",
    input.pages.rules,
    "",
    "=== Coach voice page (applies to every feature) ===",
    input.pages.voice,
    "",
    "=== How to score ===",
    "For EACH ZOH text, list a check for every per-text rule below that applies to that text. Skip a rule only if it",
    "cannot apply (e.g. on-track when the tester didn't go off-topic, follows-style before any style request).",
    ...ids("text"),
    "",
    "Then score the whole conversation once on each of these that applies (skip reality-check if no mismatch ever",
    "came up, regression unless a regression case is given, tracking for goals where it doesn't apply AND it wasn't asked):",
    ...ids("conversation"),
    "",
    "Each check: rule id, pass true/false, borderline true when a reasonable reviewer could score it the other way,",
    "and a one-line reason (under 25 words). The conversation may have been cut off by a turn cap before onboarding",
    "finished; score wrap-up and covers-inputs as fail in that case. zohText numbers are the [ZOH n] labels.",
    "Finish with a two-sentence summary of how ZOH did.",
  ].join("\n");
}

export function graderUserPrompt(input: Pick<GraderInput, "plan" | "transcript" | "context" | "memory" | "record">): string {
  const { plan, transcript, context: earlier = [] } = input;
  let n = 0;
  const lines = transcript.map((l) => {
    const when = localTime(l.at, plan.timeZone);
    if (l.from === "zoh") {
      n += 1;
      if (l.console) return `[ZOH ${n}, to the founders in the console; the tester never sees it] (${when}) ${l.text}`;
      return `[ZOH ${n}${l.started ? ", started by ZOH, not a reply" : ""}] (${when}) ${l.text}`;
    }
    if (l.from === "founder") return `[FOUNDER, in the console] (${when}) ${l.text}`;
    return `[TESTER] (${when}) ${l.text}`;
  });
  const context = [
    `Tester's phone number: area code ${plan.areaCode}, time zone ${plan.timeZone}${plan.timeZone === "America/New_York" ? " (Eastern)" : " (outside Eastern Time)"}.`,
    `Times are the tester's local time; the conversation starts on ${new Intl.DateTimeFormat("en-US", { timeZone: plan.timeZone, weekday: "long", month: "long", day: "numeric" }).format(new Date(transcript[0]?.at ?? Date.now()))}.`,
  ];
  if (transcript.some((l) => l.from === "founder")) {
    context.push(
      "",
      "Lines marked console are ZOH and the founders (Yanni and Stamati) talking about this tester in a private chat the tester never sees.",
      "ZOH's console answers are judged as a colleague's replies to the founders (this feature's rules); the voice page's texting rules",
      "(energy, one question, coaching tone) apply only to ZOH's texts to the tester. Times are still the tester's local time.",
    );
  }
  if (plan.regression) {
    context.push(
      "",
      "This is a regression case: a scripted exchange that once went wrong. Score the `regression` rule against it.",
      `What went wrong before: ${plan.regression.whatWentWrong}`,
      `What should happen: ${plan.regression.shouldHaveHappened}`,
    );
  }
  const before = earlier.length
    ? [
        "",
        "=== Earlier conversation (context only: don't grade these texts, and don't count them as ZOH n) ===",
        ...earlier.map((l) => `${l.from === "zoh" ? "[ZOH earlier]" : "[TESTER]"} (${localTime(l.at, plan.timeZone)}) ${l.text}`),
      ]
    : [];
  const memory = input.memory
    ? [
        "",
        "=== ZOH's memory at the end (what ZOH knew about them, plus anything the overnight pass filed if the clock passed 3 am; grade the memory rules against it) ===",
        input.memory,
      ]
    : [];
  const record = input.record
    ? ["", "=== The tester's step log at the start (ZOH could see this; check its facts about their days against it) ===", input.record]
    : [];
  return [...context, ...before, ...record, "", "=== Transcript ===", ...lines, ...memory].join("\n");
}

/** JSON schema for structured output; rule ids are limited to the rubric rules of each scope. */
export function gradeJsonSchema(rubric: RubricRule[]): Record<string, unknown> {
  const idsFor = (scope: RubricRule["scope"]) => {
    const ids = rubric.filter((r) => r.scope === scope).map((r) => r.id);
    // An enum can't be empty (memory grades no single text); parseGrade moves misfiled checks.
    return ids.length ? ids : rubric.map((r) => r.id);
  };
  const check = (scope: RubricRule["scope"]) => ({
    type: "object",
    additionalProperties: false,
    required: ["rule", "pass", "borderline", "reason"],
    properties: {
      rule: { type: "string", enum: idsFor(scope) },
      pass: { type: "boolean" },
      borderline: { type: "boolean" },
      reason: { type: "string" },
    },
  });
  return {
    type: "object",
    additionalProperties: false,
    required: ["texts", "conversation", "summary"],
    properties: {
      texts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["zohText", "checks"],
          properties: { zohText: { type: "integer" }, checks: { type: "array", items: check("text") } },
        },
      },
      conversation: { type: "array", items: check("conversation") },
      summary: { type: "string" },
    },
  };
}

/**
 * Parses and sanity-checks grader output. Throws with a short reason when it's unusable. A rubric
 * rule filed under the wrong scope is repaired rather than thrown away with the whole grade: a
 * conversation check scored on one text moves to the conversation checks (unless it's already
 * there), and a per-text rule scored on the whole conversation is dropped.
 */
export function parseGrade(raw: string, rubric: RubricRule[], zohTexts: number): Grade {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("grader output is not JSON");
  }
  const parsed = gradeSchema.safeParse(json);
  if (!parsed.success) throw new Error(`grader output has the wrong shape: ${parsed.error.issues[0]?.message ?? "?"}`);
  const grade = parsed.data;
  const scopeOf = new Map(rubric.map((r) => [r.id, r.scope]));
  const conversation = grade.conversation.filter((c) => {
    const scope = scopeOf.get(c.rule);
    if (!scope) throw new Error(`"${c.rule}" is not a rubric rule`);
    return scope === "conversation";
  });
  const texts = grade.texts.map((t) => {
    if (t.zohText > zohTexts) throw new Error(`grader scored ZOH text ${t.zohText} but there are only ${zohTexts}`);
    const checks = t.checks.filter((c) => {
      const scope = scopeOf.get(c.rule);
      if (!scope) throw new Error(`"${c.rule}" is not a rubric rule`);
      if (scope === "text") return true;
      if (!conversation.some((k) => k.rule === c.rule)) conversation.push(c);
      return false;
    });
    return { ...t, checks };
  });
  return { ...grade, texts, conversation };
}

/** Grades one conversation, retrying once if the output is malformed. */
export async function gradeConversation(
  input: GraderInput,
  complete: Completer,
): Promise<{ grade?: Grade; error?: string; usage: TokenUsage }> {
  const zohTexts = input.transcript.filter((l) => l.from === "zoh").length;
  if (zohTexts === 0) return { error: "ZOH never replied, so there was nothing to grade", usage: { input: 0, output: 0 } };
  const req = {
    system: graderSystemPrompt(input),
    messages: [{ role: "user" as const, content: graderUserPrompt(input) }],
    maxTokens: 16_000,
    effort: "medium" as const,
    jsonSchema: gradeJsonSchema(input.rubric),
  };
  let usage = { input: 0, output: 0 };
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await complete(req);
    usage = addUsage(usage, res.usage);
    try {
      return { grade: parseGrade(res.text, input.rubric, zohTexts), usage };
    } catch (err) {
      lastError = `${(err as Error).message}${res.stopReason && res.stopReason !== "end_turn" ? ` (stop: ${res.stopReason})` : ""}`;
    }
  }
  return { error: `Grader output unusable after a retry: ${lastError}`, usage };
}
