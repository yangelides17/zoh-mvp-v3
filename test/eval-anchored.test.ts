import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Replier, ReplyInput } from "../src/claude/replier.js";
import type { Completer, CompletionRequest } from "../eval/claude.js";
import { estimateCost } from "../eval/cost.js";
import { FEATURES, rubricFor } from "../eval/features.js";
import { graderUserPrompt } from "../eval/grader.js";
import { runConversation } from "../eval/harness.js";
import { loadCases, planConversations } from "../eval/load.js";
import { aggregate, renderMarkdown, type ReportData } from "../eval/report.js";
import { caseTester } from "../eval/simulator.js";
import { caseSchema, type GradedConversation, type RegressionCase } from "../eval/types.js";

/** Echoes the tester so each reply shows which text it answered. */
class EchoReplier implements Replier {
  async reply({ turns }: ReplyInput) {
    return `got: ${turns.at(-1)?.text}`;
  }
  async check() {}
}

/** A fake simulator answering with the given decisions in order, recording every prompt it was sent. */
function fakeSim(answers: { decision: "fits" | "close" | "wait"; text: string }[], plain: string[] = []) {
  const prompts: CompletionRequest[] = [];
  let a = 0;
  let p = 0;
  const complete: Completer = async (req) => {
    prompts.push(req);
    const text = req.jsonSchema ? JSON.stringify(answers[a++]) : (plain[p++] ?? "");
    return { text, usage: { input: 5, output: 1 }, stopReason: "end_turn" };
  };
  return { complete, prompts };
}

function makeCase(lines: z.input<typeof caseSchema>["testerLines"], extra: Record<string, unknown> = {}): RegressionCase {
  return caseSchema.parse({
    id: "anchored",
    title: "Anchored",
    origin: "test",
    testerLines: lines,
    whatWentWrong: "w",
    shouldHaveHappened: "s",
    facts: ["looks down at the left hand early", "doesn't tense up"],
    ...extra,
  });
}

async function play(c: RegressionCase, complete: Completer) {
  const plan = planConversations([], [c], { runs: 1 })[0]!;
  const tester = caseTester(c, complete);
  const result = await runConversation(plan, tester, { maxTurns: 20, index: 4, env: {}, replier: new EchoReplier() });
  return { result, testerTexts: result.transcript.filter((l) => l.from === "tester").map((l) => l.text) };
}

const anchored = { say: "probably looking down at my left hand too early", means: "names looking down early", when: "after ZOH asks what went wrong", length: "short" as const };

describe("eval: anchored case lines (#230)", () => {
  it("loads a case mixing plain and anchored lines, and rejects a line that answers ZOH with no moment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anchored-"));
    try {
      await writeFile(join(dir, "001-ok.json"), JSON.stringify({ id: "ok", title: "t", origin: "o", whatWentWrong: "w", shouldHaveHappened: "s", testerLines: ["Start", anchored, { say: "hey", starts: true }] }));
      const [c] = await loadCases("x", `${dir}/`);
      expect(c!.testerLines[1]).toMatchObject({ say: anchored.say, fixed: false, lead: true });
      expect(c!.facts).toBeUndefined();
      await writeFile(join(dir, "002-no-when.json"), JSON.stringify({ id: "bad", title: "t", origin: "o", whatWentWrong: "w", shouldHaveHappened: "s", testerLines: ["Start", { say: "works", means: "agrees" }] }));
      await expect(loadCases("x", `${dir}/`)).rejects.toThrow(/002-no-when.json.*when/);
    } finally {
      await rm(dir, { recursive: true });
    }
    // An anchored line needs its meaning; a fixed one doesn't.
    expect(() => makeCase(["Start", { say: "works", when: "after a proposal" }])).toThrow(/means/);
    expect(makeCase(["Start", { say: "works", when: "after a proposal", fixed: true }]).testerLines).toHaveLength(2);
  });

  it("holds a line until ZOH's text fits it, answering from the facts meanwhile, then sends it word for word", async () => {
    const sim = fakeSim([
      { decision: "wait", text: "it went ok, a bit messy" },
      { decision: "fits", text: "something else entirely" },
    ]);
    const { result, testerTexts } = await play(makeCase(["Start", anchored]), sim.complete);
    expect(testerTexts).toEqual(["Start", "it went ok, a bit messy", anchored.say]);
    expect(result.endedBy).toBe("script");
    expect(result.lines).toEqual({ exact: 1, adapted: 0, waited: 1 });
    // The simulator saw ZOH's latest text, the facts and the line's moment.
    const first = String(sim.prompts[0]!.messages[0]!.content);
    expect(first).toContain("got: Start");
    expect(sim.prompts[0]!.system).toContain("looks down at the left hand early");
    expect(first).toContain(anchored.when);
  });

  it("changes a line as little as needed when ZOH's text is close: it sees ZOH's text, the meaning and the length", async () => {
    const sim = fakeSim([{ decision: "close", text: "looking down at my left hand, for sure" }]);
    const { result, testerTexts } = await play(makeCase(["Start", anchored]), sim.complete);
    expect(testerTexts).toEqual(["Start", "looking down at my left hand, for sure"]);
    expect(result.lines).toEqual({ exact: 0, adapted: 1, waited: 0 });
    const prompt = String(sim.prompts[0]!.messages[0]!.content);
    expect(prompt).toContain("got: Start");
    expect(prompt).toContain(anchored.means);
    expect(prompt).toMatch(/one short sentence/);
  });

  it("never changes a fixed line: 'close' counts as not yet", async () => {
    const sim = fakeSim([
      { decision: "close", text: "sure, works for me" },
      { decision: "fits", text: "" },
    ]);
    const { result, testerTexts } = await play(makeCase(["Start", { say: "works", when: "after ZOH proposes something", fixed: true }]), sim.complete);
    expect(testerTexts).toEqual(["Start", "sure, works for me", "works"]);
    expect(result.lines).toEqual({ exact: 1, adapted: 0, waited: 1 });
  });

  it("leads toward the line by default; with lead off, the waiting reply is written without it", async () => {
    const led = fakeSim([{ decision: "wait", text: "hmm" }, { decision: "fits", text: "" }]);
    await play(makeCase(["Start", anchored]), led.complete);
    expect(String(led.prompts[0]!.messages[0]!.content)).toContain(anchored.say);
    expect(led.prompts).toHaveLength(2);

    const unled = fakeSim([{ decision: "wait", text: "ignored" }, { decision: "fits", text: "" }], ["it was fine I guess"]);
    const { testerTexts } = await play(makeCase(["Start", { ...anchored, lead: false }]), unled.complete);
    expect(testerTexts).toEqual(["Start", "it was fine I guess", anchored.say]);
    // Deciding still needs the line; the reply written while it waits never sees it.
    const reply = unled.prompts.find((p) => !p.jsonSchema)!;
    expect(String(reply.messages[0]!.content) + reply.system).not.toContain(anchored.say);
    expect(String(reply.messages[0]!.content) + reply.system).not.toContain(anchored.means);
    expect(reply.system).toContain("looks down at the left hand early");
  });

  it("marks a case problem after 2 extra texts on one line", async () => {
    const sim = fakeSim([
      { decision: "wait", text: "one" },
      { decision: "wait", text: "two" },
      { decision: "wait", text: "three" },
    ]);
    const { result, testerTexts } = await play(makeCase(["Start", anchored, { say: "night!", when: "after ZOH wraps up", fixed: true }]), sim.complete);
    expect(testerTexts).toEqual(["Start", "one", "two"]);
    expect(result.endedBy).toBe("case-problem");
    expect(result.lines?.problem).toContain(anchored.say);
  });

  it("marks a case problem after 4 extra texts in the whole case", async () => {
    const line = (say: string) => ({ say, when: "after a question", fixed: true });
    const sim = fakeSim([
      { decision: "wait", text: "w1" },
      { decision: "wait", text: "w2" },
      { decision: "fits", text: "" },
      { decision: "wait", text: "w3" },
      { decision: "wait", text: "w4" },
      { decision: "fits", text: "" },
      { decision: "wait", text: "w5" },
    ]);
    const { result, testerTexts } = await play(makeCase(["Start", line("a"), line("b"), line("c")]), sim.complete);
    expect(testerTexts).toEqual(["Start", "w1", "w2", "a", "w3", "w4", "b"]);
    expect(result.endedBy).toBe("case-problem");
    expect(result.lines).toMatchObject({ exact: 2, waited: 4 });
  });

  it("sends actions, commands, plain lines and lines that start an exchange without asking the simulator", async () => {
    const sim = fakeSim([]);
    const { testerTexts } = await play(makeCase(["Start", "stop", { say: "hey, back", starts: true }]), sim.complete);
    expect(testerTexts).toEqual(["Start", "stop", "hey, back"]);
    expect(sim.prompts).toHaveLength(0);
  });

  it("shows the grader only the conversation: no meanings, moments or facts", async () => {
    const c = makeCase(["Start", anchored]);
    const sim = fakeSim([{ decision: "fits", text: "" }]);
    const { result } = await play(c, sim.complete);
    const prompt = graderUserPrompt({ plan: result.plan, transcript: result.transcript, context: result.context });
    expect(prompt).toContain(anchored.say);
    for (const hidden of [anchored.means, anchored.when, ...c.facts!]) expect(prompt).not.toContain(hidden);
  });

  it("lists case problems and line counts in the report, leaving the problem run unscored", () => {
    const base = (key: string, extra: Partial<GradedConversation>): GradedConversation => ({
      plan: { key, kind: "case", id: key, title: `Case ${key}`, persona: "scripted", areaCode: "212", startTime: "18:30", timeZone: "America/New_York" },
      phone: "",
      context: [],
      transcript: [{ from: "tester", text: "hi", at: "2026-11-02T23:00:00Z" }],
      endedBy: "script",
      savedState: {},
      messageCount: 1,
      appErrors: [],
      usage: { input: 0, output: 0 },
      ...extra,
    });
    const convs = [
      base("case:a", { lines: { exact: 2, adapted: 1, waited: 1 }, grade: { texts: [], conversation: [{ rule: "regression", pass: true, borderline: false, reason: "ok" }], summary: "s" } }),
      base("case:b", { endedBy: "case-problem", lines: { exact: 0, adapted: 0, waited: 3, problem: "“works” never fit (after ZOH proposes something)" } }),
    ];
    const summary = aggregate(convs);
    expect(Object.keys(summary.conversations)).not.toContain("case:b");
    const report: ReportData = {
      feature: "reflection",
      startedAt: "a",
      finishedAt: "b",
      models: { coach: "c", eval: "e" },
      options: { runs: 1, maxTurns: 20 },
      rubric: rubricFor(FEATURES.reflection!),
      summary,
      worst: [],
      liveChecks: [],
      usage: { input: 0, output: 0 },
      conversations: convs,
    };
    const md = renderMarkdown(report);
    expect(md).toContain("Tester lines: 2 word for word, 1 changed to fit, 4 extra replies while a line waited, 1 case problem");
    expect(md).toMatch(/## Case problems[\s\S]*Case case:b[\s\S]*never fit/);
  });

  it("counts the extra texts a waiting line can add in the cost estimate", () => {
    const plain = planConversations([], [makeCase(["Start", "ok"])], { runs: 1 });
    const waiting = planConversations([], [makeCase(["Start", anchored])], { runs: 1 });
    const est = (plans: typeof plain) => estimateCost(plans, { maxTurns: 20, pagesChars: 0, coachModel: "claude-sonnet-5-5", evalModel: "claude-haiku-5-5" });
    expect(est(waiting).dollars.low).toBeGreaterThan(est(plain).dollars.low);
    expect(est(waiting).dollars.high).toBeGreaterThan(est(waiting).dollars.low);
    expect(est(plain).dollars.high).toBe(est(plain).dollars.low);
  });
});
