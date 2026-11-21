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
import { runConversation, scriptedTester } from "../eval/harness.js";
import { loadCases, planConversations } from "../eval/load.js";
import { aggregate, renderMarkdown, type ReportData } from "../eval/report.js";
import { checkPoint, loadSimPoints } from "../eval/sim-check.js";
import { caseTester, verdictsFor } from "../eval/simulator.js";
import { caseSchema, type GradedConversation, type LineVerdict, type RegressionCase } from "../eval/types.js";

/** Echoes the tester so each reply shows which text it answered. */
class EchoReplier implements Replier {
  async reply({ turns }: ReplyInput) {
    return `got: ${turns.at(-1)?.text}`;
  }
  async check() {}
}

/**
 * A fake simulator: decision calls (structured output) get the given verdicts in order; writing calls (a waiting
 * reply or a changed line) get the given texts in order. Every request is recorded.
 */
function fakeSim(decisions: LineVerdict[], writes: string[] = []) {
  const prompts: CompletionRequest[] = [];
  let d = 0;
  let w = 0;
  const complete: Completer = async (req) => {
    prompts.push(req);
    const text = req.jsonSchema ? JSON.stringify({ reason: `reason ${d + 1}`, decision: decisions[d++] }) : (writes[w++] ?? "");
    return { text, usage: { input: 5, output: 1 }, stopReason: "end_turn" };
  };
  const decide = () => prompts.filter((p) => p.jsonSchema);
  const wrote = () => prompts.filter((p) => !p.jsonSchema);
  return { complete, prompts, decide, wrote };
}

const content = (req: CompletionRequest) => String(req.messages[0]!.content);

function makeCase(lines: z.input<typeof caseSchema>["testerLines"], extra: Record<string, unknown> = {}): RegressionCase {
  return caseSchema.parse({
    id: "anchored",
    title: "Anchored",
    origin: "test",
    testerLines: lines,
    whatWentWrong: "w",
    shouldHaveHappened: "s",
    facts: ["bar 5 is where it falls apart", "has 15 minutes at 7"],
    ...extra,
  });
}

async function play(c: RegressionCase, complete: Completer) {
  const plan = planConversations([], [c], { runs: 1 })[0]!;
  const result = await runConversation(plan, caseTester(c, complete), { maxTurns: 20, index: 4, env: {}, replier: new EchoReplier() });
  return { result, testerTexts: result.transcript.filter((l) => l.from === "tester").map((l) => l.text) };
}

const anchored = { say: "probably looking down at my left hand too early", means: "it's looking down early", when: "after ZOH asks what goes wrong at the jump", length: "short" as const };
const agree = { say: "ok yeah", when: "after ZOH proposes tomorrow's step and asks if it works", fixed: true, expected: true };

describe("eval: case lines that wait for their moment (#230)", () => {
  it("loads plain and waiting lines; rejects a waiting line with no moment, `lead` (removed) and optional + expected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anchored-"));
    try {
      await writeFile(join(dir, "001-ok.json"), JSON.stringify({ id: "ok", title: "t", origin: "o", whatWentWrong: "w", shouldHaveHappened: "s", testerLines: ["Start", anchored, { say: "hey", starts: true }] }));
      const [c] = await loadCases("x", `${dir}/`);
      expect(c!.testerLines[1]).toMatchObject({ say: anchored.say, fixed: false, optional: false, expected: false });
      await writeFile(join(dir, "002-no-when.json"), JSON.stringify({ id: "bad", title: "t", origin: "o", whatWentWrong: "w", shouldHaveHappened: "s", testerLines: ["Start", { say: "works", means: "agrees" }] }));
      await expect(loadCases("x", `${dir}/`)).rejects.toThrow(/002-no-when.json.*when/);
    } finally {
      await rm(dir, { recursive: true });
    }
    expect(() => makeCase(["Start", { ...anchored, lead: false } as unknown as typeof anchored])).toThrow(/lead/);
    expect(() => makeCase(["Start", { ...anchored, optional: true, expected: true }])).toThrow(/optional.*expected/);
    expect(() => makeCase(["Start", { say: "works", when: "after a proposal" }])).toThrow(/means/);
  });

  it("holds a line until it fits, replying to ZOH meanwhile without seeing the line, then sends it word for word", async () => {
    const sim = fakeSim(["wait", "fits"], ["it went ok, kind of messy at bar 5"]);
    const { result, testerTexts } = await play(makeCase(["Start", anchored]), sim.complete);
    expect(testerTexts).toEqual(["Start", "it went ok, kind of messy at bar 5", anchored.say]);
    expect(result.endedBy).toBe("script");
    expect(result.lines).toMatchObject({ exact: 1, adapted: 0, waited: 1, skipped: 0, passed: 0 });
    // The decision saw ZOH's latest text and the line's moment; it writes nothing itself.
    const [decision] = sim.decide();
    expect(content(decision!)).toContain("got: Start");
    expect(content(decision!)).toContain(anchored.when);
    expect(decision!.jsonSchema).toMatchObject({ properties: { reason: { type: "string" } }, required: ["reason", "decision"] });
    // The waiting reply never sees the line, so it can't give away what comes next; it knows the facts.
    const [reply] = sim.wrote();
    expect(content(reply!)).not.toContain(anchored.say);
    expect(content(reply!)).not.toContain(anchored.means);
    expect(content(reply!)).toMatch(/never propose, agree to, choose or decide/i);
    expect(reply!.system).toContain("bar 5 is where it falls apart");
    // Each decision is logged with its reason, for the report.
    expect(result.lines!.log).toEqual([
      { line: 1, say: anchored.say, decision: "wait", reason: "reason 1" },
      { line: 1, say: anchored.say, decision: "fits", reason: "reason 2" },
    ]);
  });

  it("writes a 'close' line in its own call, from ZOH's latest text, the line's point and its length only", async () => {
    const sim = fakeSim(["close"], ["looking down at my left hand, for sure"]);
    const { result, testerTexts } = await play(makeCase(["Start", anchored]), sim.complete);
    expect(testerTexts).toEqual(["Start", "looking down at my left hand, for sure"]);
    expect(result.lines).toMatchObject({ exact: 0, adapted: 1, waited: 0 });
    const [writer] = sim.wrote();
    expect(content(writer!)).toContain("got: Start");
    expect(content(writer!)).toContain(anchored.means);
    expect(content(writer!)).toMatch(/one short sentence/);
    expect(content(writer!)).toMatch(/don't agree to, choose or decide anything else/i);
    // "close" is only for ZOH asking for this very point in other words.
    expect(content(sim.decide()[0]!)).toMatch(/If ZOH asked about anything else, or proposed something, it is not close/);
  });

  it("never changes or skips a fixed line, and only an optional line can be passed", () => {
    const parsed = (l: unknown) => makeCase(["Start", l as typeof anchored]).testerLines[1] as Exclude<RegressionCase["testerLines"][number], string>;
    expect(verdictsFor(parsed(agree))).toEqual(["fits", "wait"]);
    expect(verdictsFor(parsed(anchored))).toEqual(["said", "fits", "close", "wait"]);
    expect(verdictsFor(parsed({ ...anchored, optional: true }))).toEqual(["said", "fits", "close", "wait", "passed"]);
  });

  it("treats a verdict the line doesn't allow as not yet", async () => {
    const sim = fakeSim(["close", "fits"], ["sure, works for me"]);
    const { result, testerTexts } = await play(makeCase(["Start", agree]), sim.complete);
    expect(testerTexts).toEqual(["Start", "sure, works for me", "ok yeah"]);
    expect(result.lines).toMatchObject({ exact: 1, adapted: 0, waited: 1 });
  });

  it("skips a line its own earlier texts already made, and drops an optional line ZOH moved past, in the same turn", async () => {
    const optional = { say: "that's about it for today", when: "after ZOH asks if there's anything else about today", fixed: true, optional: true };
    const sim = fakeSim(["said", "passed", "fits"]);
    const { result, testerTexts } = await play(makeCase(["Start", anchored, optional, agree]), sim.complete);
    expect(testerTexts).toEqual(["Start", "ok yeah"]);
    expect(result.lines).toMatchObject({ exact: 1, skipped: 1, passed: 1 });
    expect(content(sim.decide()[0]!)).toMatch(/YOUR earlier texts already got this text's point across/);
  });

  it("ends a line ZOH was expected to reach and never did as ZOH's miss: graded as usual, not a case problem", async () => {
    const sim = fakeSim(["wait", "wait", "wait"], ["one", "two"]);
    const { result, testerTexts } = await play(makeCase(["Start", agree]), sim.complete);
    expect(testerTexts).toEqual(["Start", "one", "two"]);
    expect(result.endedBy).toBe("script");
    expect(result.lines?.problem).toBeUndefined();
    expect(result.lines?.missed).toContain("ZOH never reached it");
  });

  it("makes any other line that never fits a case problem, after 2 extra texts on it", async () => {
    const sim = fakeSim(["wait", "wait", "wait"], ["one", "two"]);
    const { result, testerTexts } = await play(makeCase(["Start", anchored, agree]), sim.complete);
    expect(testerTexts).toEqual(["Start", "one", "two"]);
    expect(result.endedBy).toBe("case-problem");
    expect(result.lines?.problem).toContain(anchored.say);
  });

  it("makes a case problem after 4 extra texts in the whole case", async () => {
    const line = (say: string) => ({ say, when: "after a question", fixed: true });
    const sim = fakeSim(["wait", "wait", "fits", "wait", "wait", "fits", "wait"], ["w1", "w2", "w3", "w4"]);
    const { result, testerTexts } = await play(makeCase(["Start", line("a"), line("b"), line("c")]), sim.complete);
    expect(testerTexts).toEqual(["Start", "w1", "w2", "a", "w3", "w4", "b"]);
    expect(result.endedBy).toBe("case-problem");
    expect(result.lines).toMatchObject({ exact: 2, waited: 4 });
  });

  it("makes an empty reply a case problem, never a stand-in 'ok'", async () => {
    const sim = fakeSim(["wait"], ["  "]);
    const { result, testerTexts } = await play(makeCase(["Start", anchored]), sim.complete);
    expect(testerTexts).toEqual(["Start"]);
    expect(result.endedBy).toBe("case-problem");
    expect(result.lines?.problem).toMatch(/wrote nothing/);
  });

  it("sends actions, commands, plain lines and the tester's own moves without asking the simulator", async () => {
    const sim = fakeSim([]);
    const { testerTexts } = await play(makeCase(["Start", "stop", { say: "hey, back", starts: true }]), sim.complete);
    expect(testerTexts).toEqual(["Start", "stop", "hey, back"]);
    expect(sim.prompts).toHaveLength(0);
  });

  it("shows the grader only the conversation: no meanings, moments or facts", async () => {
    const c = makeCase(["Start", anchored]);
    const { result } = await play(c, fakeSim(["fits"]).complete);
    const prompt = graderUserPrompt({ plan: result.plan, transcript: result.transcript, context: result.context });
    expect(prompt).toContain(anchored.say);
    for (const hidden of [anchored.means, anchored.when, ...c.facts!]) expect(prompt).not.toContain(hidden);
  });

  it("gives the grader ZOH's own status sheet for a seeded case: earlier days, what the proof showed, the streak", async () => {
    // Priya's seed: earlier days with "1,050 words total" as the last proof, which ZOH cites and the grader used to flag as invented.
    const c = (await loadCases("reflection")).find((x) => x.id === "obstacle-gets-a-plan")!;
    const plan = planConversations([], [c], { runs: 1 })[0]!;
    const result = await runConversation(plan, scriptedTester(["hi"]), { maxTurns: 2, index: 5, env: {}, replier: new EchoReplier() });
    expect(result.knew).toContain("1,050 words total");
    expect(result.knew).toMatch(/Streak: \d+ step day/);
    const prompt = graderUserPrompt({ plan: result.plan, transcript: result.transcript, context: result.context, knew: result.knew });
    expect(prompt).toContain("What ZOH could see about the tester before this conversation");
    expect(prompt).toContain("1,050 words total");
    // A case without a seed has nothing earlier to know.
    const fresh = await play(makeCase(["Start"]), fakeSim([]).complete);
    expect(fresh.result.knew).toBeUndefined();
  });

  it("reports line counts and ZOH's misses, and lists case problems with their grade but keeps them out of the scores", () => {
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
    const passing = { texts: [], conversation: [{ rule: "regression", pass: true, borderline: false, reason: "ok" }], summary: "s" };
    const failing = { texts: [], conversation: [{ rule: "regression", pass: false, borderline: false, reason: "no" }], summary: "s" };
    const convs = [
      base("case:a", { lines: { exact: 2, adapted: 1, waited: 1, skipped: 1, passed: 1, log: [{ line: 1, say: "ok yeah", decision: "fits", reason: "ZOH proposed tomorrow and asked" }] }, grade: passing }),
      base("case:b", { endedBy: "case-problem", lines: { exact: 0, adapted: 0, waited: 3, skipped: 0, passed: 0, problem: "“works” never fit (after ZOH proposes something)", log: [] }, problemGrade: failing }),
      base("case:c", { lines: { exact: 0, adapted: 0, waited: 2, skipped: 0, passed: 0, missed: "ZOH never reached it: “ok yeah” never fit", log: [] }, grade: failing }),
    ];
    const summary = aggregate(convs);
    // The case problem's grade is never scored; ZOH's miss is.
    expect(Object.keys(summary.conversations).sort()).toEqual(["case:a", "case:c"]);
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
    expect(md).toContain(
      "Tester lines: 2 word for word, 1 changed to fit, 1 skipped (already said), 1 passed (optional), 6 extra replies while a line waited, 1 where ZOH never reached a moment it should have (graded as usual), 1 case problem",
    );
    expect(md).toMatch(/## Case problems[\s\S]*Case case:b[\s\S]*never fit[\s\S]*Grade, not scored: failed `regression`/);
    expect(md).toContain("**fits**: ZOH proposed tomorrow and asked");
    expect(md).toContain("**ZOH's miss:** ZOH never reached it");
  });

  it("sim-check: every known moment loads against its case's current line, and a moment is right only if every run is", async () => {
    const points = await loadSimPoints();
    expect(points.length).toBeGreaterThanOrEqual(12);
    const p = points.find((x) => x.point.id === "engaged-asked-to-explain-a-fix")!;
    // Right: waits each run, and the reply keeps clear of the phone.
    const good = fakeSim(["wait", "wait"], ["he rigs a centrifuge out of spare parts, kind of genius", "honestly I'd have to reread it"]);
    const ok = await checkPoint(p, good.complete, "fake", 2);
    expect(ok.result).toMatchObject({ right: true, decisions: ["wait", "wait"] });
    // The waiting reply was written from a prompt that never names the pending line (the seed's own step text does say "dresser").
    expect(content(good.wrote()[0]!)).not.toContain("the whole trick");
    // Wrong: one run gives away what the later line is for.
    const leaky = await checkPoint(p, fakeSim(["wait", "wait"], ["fine", "the phone on the dresser is the real trick"]).complete, "fake", 2);
    expect(leaky.result.right).toBe(false);
    // Wrong: one run decides something the moment doesn't allow.
    const forced = await checkPoint(p, fakeSim(["wait", "fits"], ["fine"]).complete, "fake", 2);
    expect(forced.result.right).toBe(false);
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
