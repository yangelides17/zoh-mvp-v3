import { describe, expect, it } from "vitest";
import type { Completer, CompletionRequest } from "../eval/claude.js";
import { FEATURES, readPages, rubricFor } from "../eval/features.js";
import { gradeConversation, questionCheck } from "../eval/grader.js";
import { agreement, checkFeel, checkKnown, knownConversation, knownRates, loadKnown, renderGraderCheck, sampleConversations, type KnownExample } from "../eval/grader-check.js";
import type { Check, ConversationPlan, Grade, GradedConversation, TranscriptLine } from "../eval/types.js";

const plan: ConversationPlan = { key: "k", kind: "scenario", id: "k", title: "t", persona: "terse", areaCode: "212", startTime: "18:30", timeZone: "America/New_York" };
const at = "2026-11-02T23:00:00Z";
const transcript: TranscriptLine[] = [
  { from: "tester", text: "hi", at },
  { from: "zoh", text: "Hey! I'm ZOH. What's your name, and which goal?", at },
  { from: "tester", text: "Sam, running", at },
  { from: "zoh", text: "Nice, Sam. What time works? And where?", at },
];

/** A grader that answers every call with a pass on each rule id it was offered, and records the calls. */
function echoGrader(): { complete: Completer; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const complete: Completer = async (req) => {
    calls.push(req);
    const schema = req.jsonSchema as { properties: { texts: { items: { properties: { checks: { items: { properties: { rule: { enum: string[] } } } } } } }; conversation: { items: { properties: { rule: { enum: string[] } } } } } };
    const textIds = schema.properties.texts.items.properties.checks.items.properties.rule.enum;
    const convIds = schema.properties.conversation.items.properties.rule.enum;
    const ok = (rule: string): Check => ({ rule, pass: true, borderline: false, reason: "ok" });
    return { text: JSON.stringify({ texts: [{ zohText: 1, checks: textIds.map(ok) }], conversation: convIds.map(ok), summary: "fine" }), usage: { input: 1, output: 1 }, stopReason: "end_turn" };
  };
  return { complete, calls };
}

describe("eval: one question per text, counted in code (#197)", () => {
  const onboarding = rubricFor(FEATURES.onboarding!).find((r) => r.id === "one-question")!;
  const planRule = rubricFor(FEATURES.plan!).find((r) => r.id === "one-question")!;

  it("fails two questions in one text, except where the first text may ask name and goal together", () => {
    expect(questionCheck(onboarding, "What time works? And where?", 2)).toMatchObject({ pass: false, reason: "2 questions in one text (counted in code)" });
    expect(questionCheck(onboarding, "What's your name? And which goal?", 1).pass).toBe(true);
    expect(questionCheck(onboarding, "Love that. See you at 7.", 3)).toMatchObject({ pass: true, reason: "no question (counted in code)" });
    expect(questionCheck(onboarding, "Wait, really?? Nice.", 2).pass).toBe(true);
  });

  it("with \"at the end\", fails a question followed by more words, not by an emoji", () => {
    expect(questionCheck(planRule, "Does 7 work? Then we lock it.", 2)).toMatchObject({ pass: false, reason: "the question isn't at the end (counted in code)" });
    expect(questionCheck(planRule, "Does 7 work? 💪", 2).pass).toBe(true);
  });

  it("never asks the grader about it, and adds the counted checks to every ZOH text", async () => {
    const grader = echoGrader();
    const pages = await readPages(FEATURES.onboarding!);
    const { grade } = await gradeConversation({ plan, transcript, rubric: rubricFor(FEATURES.onboarding!), pages }, grader.complete);
    expect(grader.calls).toHaveLength(1);
    expect(grader.calls[0]!.system).not.toContain(onboarding.label);
    expect(JSON.stringify(grader.calls[0]!.jsonSchema)).not.toContain('"one-question"');
    const counted = grade!.texts.map((t) => t.checks.find((c) => c.rule === "one-question")?.pass);
    expect(counted).toEqual([true, false]);
  });
});

/** A grader that fails `rule` on every text and the conversation when `breaks(user prompt)` says so, else passes it. */
function ruleGrader(rule: string, breaks: (prompt: string) => boolean): Completer {
  return async (req) => {
    const prompt = String(req.messages[0]!.content);
    const scored: Check = { rule, pass: !breaks(prompt), borderline: false, reason: "r" };
    const offered = JSON.stringify(req.jsonSchema);
    const isText = offered.includes(`"texts"`) && JSON.parse(offered).properties.texts.items.properties.checks.items.properties.rule.enum.includes(rule);
    return {
      text: JSON.stringify({ texts: isText ? [{ zohText: 1, checks: [scored] }] : [], conversation: isText ? [] : offered.includes(`"${rule}"`) ? [scored] : [], summary: "" }),
      usage: { input: 1, output: 1 },
      stopReason: "end_turn",
    };
  };
}

describe("eval: grader check against known answers (#197)", () => {
  it("every known-answer example loads, names a judged rule of its feature, and comes in follow/break pairs", async () => {
    const all = (await Promise.all(Object.keys(FEATURES).map((f) => loadKnown(f)))).flat();
    expect(all.length).toBeGreaterThanOrEqual(10);
    const byRule = new Map<string, Set<string>>();
    for (const ex of all) byRule.set(`${ex.feature}/${ex.rule}`, (byRule.get(`${ex.feature}/${ex.rule}`) ?? new Set()).add(ex.expect));
    expect([...byRule.keys()].sort()).toEqual(["console/asks-once", "console/proposal-asks", "curation/expert-answer", "curation/no-search-chat", "curiosity/no-assumed", "curiosity/weighs-idea", "memory/counted-proof", "onboarding/first-text", "plan/no-seam", "plan/plan-shown", "plan/quiet-hours", "proof/proof-kinds", "reflection/first-answer-held", "reflection/lands-naturally", "reflection/learning-ask", "reflection/not-forced"]);
    expect([...byRule.values()].every((s) => s.has("pass") && s.has("fail"))).toBe(true);
    // Shown to the grader as a conversation: the seed's history as context, never graded.
    const seeded = all.find((e) => e.seed)!;
    const conv = knownConversation(seeded);
    expect(conv.context.map((l) => l.text)).toEqual(seeded.seed!.history.map((l) => l.text));
    expect(conv.transcript).toHaveLength(seeded.transcript.length);
  });

  it("gives each rule's catch rate and pass rate: a grader that sees the break catches it, a lenient one doesn't", async () => {
    const examples = (await loadKnown("proof")).filter((e) => e.rule === "proof-kinds");
    const breakText = examples.find((e) => e.expect === "fail")!.transcript.find((l) => l.from === "zoh")!.text;
    const sharp = await checkKnown(examples, { runs: 3, complete: ruleGrader("proof-kinds", (p) => p.includes(breakText)) });
    expect(knownRates(sharp.results)).toEqual([{ feature: "proof", rule: "proof-kinds", breaks: 3, caught: 3, follows: 3, passed: 3, errors: 0 }]);
    const lenient = await checkKnown(examples, { runs: 2, complete: ruleGrader("proof-kinds", () => false) });
    expect(knownRates(lenient.results)).toEqual([{ feature: "proof", rule: "proof-kinds", breaks: 2, caught: 0, follows: 2, passed: 2, errors: 0 }]);
    expect(renderGraderCheck({ known: knownRates(lenient.results) })).toContain("| `proof/proof-kinds` | 0% (0/2) | 100% (2/2) |");
  });

  it("a rule the grader skipped counts as passed on a follow and missed on a break", () => {
    const ex = (expect: "pass" | "fail"): Omit<KnownExample, "transcript"> => ({ feature: "plan", id: "x", rule: "no-seam", expect, why: "", areaCode: "212", startTime: "18:30", timeZone: "America/New_York" });
    expect(knownRates([{ ...ex("pass"), said: "skipped" }, { ...ex("fail"), said: "skipped" }, { ...ex("fail"), said: "error" }])).toEqual([
      { feature: "plan", rule: "no-seam", breaks: 1, caught: 0, follows: 1, passed: 1, errors: 1 },
    ]);
  });
});

describe("eval: grader check against a stronger model (#197)", () => {
  const g = (texts: Record<number, Check[]>, conversation: Check[]): Grade => ({ texts: Object.entries(texts).map(([n, checks]) => ({ zohText: Number(n), checks })), conversation, summary: "" });
  const c = (rule: string, pass: boolean): Check => ({ rule, pass, borderline: false, reason: "" });

  it("tallies how often the regular grader failed what the stronger one failed and passed what it passed, on the checks both scored", () => {
    const rates = agreement(
      [
        // Text 1: both fail not-leading. Text 2: the stronger fails it, the regular passes it. Not-dragging: both pass.
        { regular: g({ 1: [c("not-leading", false)], 2: [c("not-leading", true)] }, [c("not-dragging", true), c("short", false)]), strong: g({ 1: [c("not-leading", false)], 2: [c("not-leading", false)] }, [c("not-dragging", true)]) },
        // The stronger passes not-dragging, the regular fails it; text 3 only the stronger scored (not paired).
        { regular: g({}, [c("not-dragging", false)]), strong: g({ 3: [c("not-leading", true)] }, [c("not-dragging", true)]) },
      ],
      ["not-leading", "not-dragging"],
    );
    expect(rates).toEqual([
      { rule: "not-dragging", strongFails: 0, caught: 0, strongPasses: 2, passed: 1 },
      { rule: "not-leading", strongFails: 2, caught: 1, strongPasses: 0, passed: 0 },
    ]);
  });

  it("has the stronger model grade only the conversation checks of a spread-out sample", async () => {
    const curiosity = FEATURES.curiosity!;
    const convs: GradedConversation[] = Array.from({ length: 8 }, (_, i) => ({
      plan: { ...plan, key: `k${i}`, id: `k${i}` },
      phone: "",
      context: [],
      transcript,
      endedBy: "script",
      savedState: {},
      messageCount: 4,
      appErrors: [],
      usage: { input: 0, output: 0 },
      grade: g({ 1: [c("not-leading", true)] }, [c("not-dragging", true)]),
    }));
    const picked = sampleConversations(convs, 3);
    expect(picked.map((x) => x.plan.key)).toEqual(["k0", "k2", "k5"]);
    const strong = echoGrader();
    const res = await checkFeel(picked, { rubric: rubricFor(curiosity), pages: await readPages(curiosity), strong: strong.complete });
    // Conversation-group rules only: the together call never sees style or flow checks like "short".
    expect(strong.calls[0]!.system).not.toContain(rubricFor(curiosity).find((r) => r.id === "short")!.label);
    expect(strong.calls).toHaveLength(9); // 3 conversations × (together + not-leading + not-dragging)
    expect(res.rates.find((r) => r.rule === "not-dragging")).toEqual({ rule: "not-dragging", strongFails: 0, caught: 0, strongPasses: 3, passed: 3 });
  });
});

describe("eval: the most-misfiring checks get their own grader call (#197)", () => {
  it("grades not-leading and not-dragging each alone, and the other checks together", async () => {
    const curiosity = FEATURES.curiosity!;
    const rubric = rubricFor(curiosity);
    const grader = echoGrader();
    const { grade } = await gradeConversation({ plan, transcript, rubric, pages: await readPages(curiosity) }, grader.complete);
    expect(grader.calls).toHaveLength(3);
    const label = (id: string) => rubric.find((r) => r.id === id)!.label;
    const [together, ...alone] = grader.calls;
    expect(together!.system).not.toContain(label("not-leading"));
    expect(together!.system).not.toContain(label("not-dragging"));
    expect(together!.system).toContain(label("natural"));
    expect(alone.map((c) => [c.system.includes(label("not-leading")), c.system.includes(label("not-dragging")), c.system.includes(label("natural"))])).toEqual([
      [true, false, false],
      [false, true, false],
    ]);
    // One grade with every call's checks.
    expect(grade!.texts[0]!.checks.map((c) => c.rule)).toEqual(expect.arrayContaining(["natural", "not-leading"]));
    expect(grade!.conversation.map((c) => c.rule)).toEqual(expect.arrayContaining(["real-moment", "not-dragging"]));
    expect(grade!.summary).toBe("fine");
  });
});
