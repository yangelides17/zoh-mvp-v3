import { localTime } from "./clock.js";
import { addUsage, type Completer } from "./claude.js";
import type { RubricRule } from "./features.js";
import { gradeSchema, type Check, type ConversationPlan, type Grade, type GradedConversation, type TokenUsage, type TranscriptLine } from "./types.js";

export interface GraderInput {
  plan: ConversationPlan;
  /** A seeded conversation before the graded part; shown for context only. */
  context?: TranscriptLine[];
  transcript: TranscriptLine[];
  /** ZOH's memory pages after the overnight pass (memory feature), graded with the conversation. */
  memory?: string;
  /** The tester's step log as ZOH saw it (console feature). */
  record?: string;
  /** What ZOH saved during the conversation (features with `saved`). */
  saved?: string;
  /** #230: ZOH's own status sheet at the start of a seeded conversation (step days, streak, lessons, the team's notes). */
  knew?: string;
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

export function graderUserPrompt(input: Pick<GraderInput, "plan" | "transcript" | "context" | "memory" | "record" | "saved" | "knew">): string {
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
    if (l.from === "lookup") return `[ZOH LOOKED UP, for its next text; the tester never sees this] ${l.text}`;
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
  if (transcript.some((l) => l.from === "lookup")) {
    context.push(
      "",
      "Lines marked ZOH LOOKED UP are ZOH's real web searches (with the links each turned up), pages it opened and YouTube videos it watched before its next text.",
      "They are what ZOH actually found: a link in its text that none of them turned up, and that the tester didn't send, was invented. A text that",
      "only names a source it never looked up is answering from memory. They are not texts, and the voice page's texting rules don't apply to them.",
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
  // #230: what ZOH could see before the conversation, as its own status sheet showed it (step days, what the proof
  // showed, the streak, lessons, the team's notes), so using it isn't graded as invented.
  // #157: a stored run from before #230 has no sheet; the case's setup (name, saved answers, plan) stands in.
  const seed = plan.regression?.seed ?? plan.scenario?.seed ?? plan.seed;
  if (input.knew) {
    context.push("", "What ZOH could see about the tester before this conversation (its own status sheet; using any of it isn't inventing):", input.knew);
  } else if (seed) {
    const known = [
      `name ${seed.name}`,
      ...Object.entries(seed.answers ?? {}).map(([k, v]) => `${k}: ${v}`),
      ...(seed.plan ? [`plan step: ${seed.plan.step}`, `plan time: ${seed.plan.time}`] : []),
      ...(seed.today_step ? [`today's step: ${seed.today_step.step}`] : []),
    ];
    context.push("", `What ZOH already knew before this conversation (from earlier texts, not shown; using it isn't inventing): ${known.join("; ")}.`);
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
    ? ["", "=== The tester's step log (at the start unless it says otherwise; ZOH could see this; check its facts about their days against it) ===", input.record]
    : [];
  const saved = input.saved
    ? ["", "=== What ZOH saved during the conversation (the tester never sees this; check rules about flagging or saving against it) ===", input.saved]
    : [];
  return [...context, ...before, ...record, "", "=== Transcript ===", ...lines, ...memory, ...saved].join("\n");
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

/**
 * Re-grades saved conversations with the current checks and voice page (#197), without running them again:
 * one grader call per conversation that has a transcript; everything but the grade is kept.
 */
export async function regradeConversations(
  convs: GradedConversation[],
  grading: { rubric: RubricRule[]; pages: { rules: string; voice: string }; complete: Completer; concurrency?: number },
): Promise<{ convs: GradedConversation[]; usage: TokenUsage }> {
  let usage: TokenUsage = { input: 0, output: 0 };
  const out = await mapLimit(convs, grading.concurrency ?? 3, async (c) => {
    if (c.transcript.length === 0) return c;
    const g = await gradeConversation({ ...c, rubric: grading.rubric, pages: grading.pages }, grading.complete);
    usage = addUsage(usage, g.usage);
    return { ...c, grade: g.grade, gradeError: g.error };
  });
  return { convs: out, usage };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Grades one conversation: the rules counted in code are counted, each `alone` rule gets its own grader
 * call, and the rest share one (#197). Any call still unusable after a retry leaves it ungraded.
 */
export async function gradeConversation(
  input: GraderInput,
  complete: Completer,
): Promise<{ grade?: Grade; error?: string; usage: TokenUsage }> {
  const zohTexts = input.transcript.filter((l) => l.from === "zoh").length;
  if (zohTexts === 0) return { error: "ZOH never replied, so there was nothing to grade", usage: { input: 0, output: 0 } };
  const judged = input.rubric.filter((r) => !r.code);
  // The feature's rules text, less the lines for rules judged elsewhere (counted in code, or in their own call).
  const elsewhere = new Set(input.rubric.filter((r) => r.code || r.alone).map((r) => `- ${r.label}`));
  const together = { ...input.pages, rules: input.pages.rules.split("\n").filter((l) => !elsewhere.has(l)).join("\n") };
  const main = await gradeOnce({ ...input, rubric: judged.filter((r) => !r.alone), pages: together }, zohTexts, complete);
  if (!main.grade) return main;
  let { grade, usage } = main;
  for (const rule of judged.filter((r) => r.alone)) {
    const one = await gradeOnce({ ...input, rubric: [rule], pages: { ...input.pages, rules: `- ${rule.label}` } }, zohTexts, complete);
    usage = addUsage(usage, one.usage);
    if (!one.grade) return { error: `${rule.id}: ${one.error}`, usage };
    grade = mergeGrades(grade, one.grade);
  }
  return { grade: mergeGrades(grade, { texts: codeChecks(input.rubric, input.transcript), conversation: [], summary: "" }), usage };
}

/** Rules counted in code (#197), one check per ZOH text to the tester. */
export function codeChecks(rubric: RubricRule[], transcript: TranscriptLine[]): Grade["texts"] {
  const rules = rubric.filter((r) => r.code);
  if (rules.length === 0) return [];
  const out: Grade["texts"] = [];
  let n = 0;
  for (const line of transcript) {
    if (line.from !== "zoh") continue;
    n += 1;
    if (line.console) continue;
    out.push({ zohText: n, checks: rules.map((r) => questionCheck(r, line.text, n)) });
  }
  return out;
}

/** At most one question (the first text may allow more), and with `atEnd`, nothing but punctuation or emoji after it. */
export function questionCheck(rule: RubricRule, text: string, zohText: number): Check {
  const count = (text.match(/\?+/g) ?? []).length;
  const max = zohText === 1 ? (rule.code?.firstText ?? 1) : 1;
  const after = text.slice(text.lastIndexOf("?") + 1);
  if (count > max) return { rule: rule.id, pass: false, borderline: false, reason: `${count} questions in one text (counted in code)` };
  if (rule.code?.atEnd && count > 0 && /[\p{L}\p{N}]/u.test(after)) {
    return { rule: rule.id, pass: false, borderline: false, reason: "the question isn't at the end (counted in code)" };
  }
  return { rule: rule.id, pass: true, borderline: false, reason: `${count === 0 ? "no question" : count === 1 ? "one question" : `${count} questions, allowed here`} (counted in code)` };
}

function mergeGrades(a: Grade, b: Grade): Grade {
  const texts = a.texts.map((t) => ({ ...t, checks: [...t.checks] }));
  for (const t of b.texts) {
    const same = texts.find((x) => x.zohText === t.zohText);
    if (same) same.checks.push(...t.checks);
    else texts.push({ ...t, checks: [...t.checks] });
  }
  texts.sort((x, y) => x.zohText - y.zohText);
  return { texts, conversation: [...a.conversation, ...b.conversation], summary: a.summary };
}

/** One grader call on these rules, retrying once if the output is malformed. */
async function gradeOnce(input: GraderInput, zohTexts: number, complete: Completer): Promise<{ grade?: Grade; error?: string; usage: TokenUsage }> {
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
