import { readFileSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromStored, loadBaseline, producerChanges, producerFor, storeBaseline } from "../eval/baseline.js";
import type { Completer, CompletionRequest } from "../eval/claude.js";
import { FEATURES, readPages, rubricFor } from "../eval/features.js";
import { regradeConversations } from "../eval/grader.js";
import { planConversations } from "../eval/load.js";
import { comparisonLines, groupTable } from "../eval/report.js";
import { compareScores, fisherLower, groupScores, scoreCases, type CaseScore } from "../eval/score.js";
import { caseSchema, type Check, type GradedConversation, type Suite } from "../eval/types.js";

const rubric = [...new Map(Object.values(FEATURES).flatMap(rubricFor).map((r) => [r.id, r])).values()];
const check = (rule: string, pass: boolean): Check => ({ rule, pass, borderline: false, reason: "" });

/** A graded run: its key (runs of one case share it, before the "#n"), and which rules passed and failed. */
function run(key: string, pass: string[], fail: string[] = [], opts: { kind?: "case" | "scenario"; suite?: Suite } = {}): Pick<GradedConversation, "plan" | "grade"> {
  const kind = opts.kind ?? (key.startsWith("case:") ? "case" : "scenario");
  return {
    plan: { key, kind, id: key, suite: opts.suite, title: key, persona: "scripted", areaCode: "212", startTime: "18:30", timeZone: "America/New_York" },
    grade: { texts: [{ zohText: 1, checks: [...pass, ...fail].filter((r) => rubric.find((x) => x.id === r)?.scope === "text").map((r) => check(r, pass.includes(r))) }], conversation: [...pass, ...fail].filter((r) => rubric.find((x) => x.id === r)?.scope !== "text").map((r) => check(r, pass.includes(r))), summary: "" },
  };
}

/** A case with `passes` of `runs` passing every check in one group (a fail anywhere in the group fails the run). */
function runs(id: string, rule: string, passes: number, total: number, suite: Suite = "regression") {
  return Array.from({ length: total }, (_, i) => run(`case:${id}#${i + 1}`, i < passes ? [rule] : [], i < passes ? [] : [rule], { suite }));
}

const pct = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 10);

describe("eval: scores by group (#197)", () => {
  it("a run passes a group only if every check in it passed; cases are averaged first, and margins come from the spread between cases", () => {
    const scores = scoreCases(
      [
        run("case:a#1", ["not-leading", "natural", "regression"], ["short"]),
        run("case:a#2", ["not-leading", "regression"], ["natural"]),
        run("case:a#3", ["not-leading", "natural"], ["regression"]),
        run("case:b", ["not-dragging", "short", "regression"]),
        // The grader sometimes scores the case-only check on a simulated conversation: it doesn't count.
        run("sim#1", ["natural", "regression"], [], { kind: "scenario" }),
      ],
      rubric,
    );
    expect(scores.map((s) => [s.id, s.runs])).toEqual([["case:a", 3], ["case:b", 1], ["sim", 1]]);
    const a = scores[0]!;
    expect(a.groups.conversation).toEqual({ runs: 3, passes: 2, failed: ["natural"] });
    expect(a.groups.style).toEqual({ runs: 1, passes: 0, failed: ["short"] }); // style failing doesn't touch conversation
    expect(scores[2]!.groups.goal).toBeUndefined();

    const g = groupScores(scores);
    // Conversation: a 2/3, b 1/1, sim 1/1 → (0.667 + 1 + 1) / 3, not 4/5 runs pooled.
    expect(g.conversation.cases).toBe(3);
    expect(g.conversation.rate).toBeCloseTo(8 / 9, 6);
    // sd of (2/3, 1, 1) = 0.19245; × t(2 df) 4.303 / √3.
    expect(g.conversation.margin).toBeCloseTo((4.303 * 0.19245) / Math.sqrt(3), 3);
    expect(g.conversation.everyRun).toBe(2);
    // The goal: a 2/3, b 1/1 (the scenario's is ignored).
    expect(g.goal).toMatchObject({ cases: 2, everyRun: 1 });
    expect(g.goal.rate).toBeCloseTo(5 / 6, 6);
    expect(g.flow).toMatchObject({ cases: 0, rate: null, margin: null });
  });

  // #157's saved, re-graded reports: the baseline (dev) and the lean version (C), as fixed fixtures.
  const data = JSON.parse(readFileSync(new URL("./fixtures/eval-157.json", import.meta.url), "utf8")) as Record<
    "baseline" | "lean",
    { feature: string; kind: "case" | "scenario"; id: string; pass: string[]; fail: string[] }[]
  >;
  const scored = (variant: "baseline" | "lean", feature?: string): CaseScore[] =>
    scoreCases(
      data[variant].filter((c) => !feature || c.feature === feature).map((c) => run(`${c.feature}/${c.kind === "case" ? "case:" : ""}${c.id}`, c.pass, c.fail, { kind: c.kind })),
      rubric,
    );

  it("#157 by hand: the curiosity cases' own goal went 31% → 69% (8 cases, 2 runs each), likely better but within noise", () => {
    // Per case, baseline → lean: after-coffee 0/2 → 1/2, brief-done 0/2 → 2/2, emotional-kickoff-reply 0/2 → 1/2,
    // idea-for-tomorrow 2/2 → 1/2, idk-options 0/2 → 2/2, make-it-harder 0/2 → 0/2, routine-day-full 1/2 → 2/2,
    // story-three-texts 2/2 → 2/2. (#157's table said 39% → 82% because it also counted the grader's misplaced
    // `regression` checks on simulated conversations, almost all passes.)
    const before = groupScores(scored("baseline", "curiosity")).goal;
    const after = groupScores(scored("lean", "curiosity")).goal;
    expect([before.cases, pct(before.rate), before.everyRun]).toEqual([8, 31.3, 2]);
    expect([after.cases, pct(after.rate), after.everyRun]).toEqual([8, 68.8, 4]);
    const goal = compareScores(scored("lean", "curiosity"), scored("baseline", "curiosity")).groups.find((x) => x.group === "goal")!;
    // Differences +.5 +1 +.5 −.5 +1 0 +.5 0: mean .375, sd .5175, × t(7 df) 2.365 / √8 = ±.433.
    expect(goal.cases).toBe(8);
    expect(goal.diff).toBeCloseTo(0.375, 6);
    expect(goal.margin).toBeCloseTo(0.4327, 3);
    expect(goal.verdict).toBe("same");
  });

  it("#157: conversation over every case moved within noise and isn't flagged", () => {
    const cmp = compareScores(scored("lean"), scored("baseline"));
    const conversation = cmp.groups.find((x) => x.group === "conversation")!;
    expect(conversation.cases).toBe(36);
    expect(conversation.diff! - conversation.margin!).toBeLessThan(0);
    expect(conversation.diff!).toBeGreaterThan(0);
    expect(conversation.verdict).toBe("same");
  });

  it("flags a regression case that drops 3/3 → 0/3, not one that drops 3/3 → 2/3", () => {
    expect(fisherLower(3, 3, 0, 3)).toBeCloseTo(0.05, 6);
    expect(fisherLower(3, 3, 2, 3)).toBeCloseTo(0.5, 6);
    const baseline = scoreCases([...runs("x", "regression", 3, 3), ...runs("y", "regression", 3, 3), ...runs("z", "regression", 3, 3)], rubric);
    const current = scoreCases([...runs("x", "regression", 0, 3), ...runs("y", "regression", 2, 3), ...runs("z", "regression", 3, 3)], rubric);
    const cmp = compareScores(current, baseline);
    expect(cmp.drops.map((d) => [d.id, d.group, d.before.passes, d.after.passes])).toEqual([["case:x", "goal", 3, 0]]);
  });

  it("doesn't flag a group that moved within noise, and does flag one that fell beyond it", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const base = scoreCases(ids.flatMap((id) => runs(id, "natural", 2, 3)), rubric);
    const wobble = scoreCases(ids.flatMap((id, i) => runs(id, "natural", i % 2 ? 3 : 1, 3)), rubric);
    expect(compareScores(wobble, base).groups.find((g) => g.group === "conversation")!.verdict).toBe("same");
    const fell = scoreCases(ids.flatMap((id, i) => runs(id, "natural", i < 2 ? 1 : 0, 3)), rubric);
    const change = compareScores(fell, base).groups.find((g) => g.group === "conversation")!;
    expect(change.verdict).toBe("worse");
    expect(change.diff! + change.margin!).toBeLessThan(0);
    // No single case fell far enough on its own (2/3 → 0/3 is p 0.2).
    expect(compareScores(fell, base).drops).toEqual([]);
  });

  it("lists a capability case that passed every run in the baseline and again now as ready to graduate; capability drops aren't flagged", () => {
    const baseline = scoreCases([...runs("new", "regression", 3, 3, "capability"), ...runs("young", "regression", 2, 3, "capability"), ...runs("down", "regression", 3, 3, "capability")], rubric);
    const current = scoreCases([...runs("new", "regression", 3, 3, "capability"), ...runs("young", "regression", 3, 3, "capability"), ...runs("down", "regression", 0, 3, "capability"), ...runs("fresh", "regression", 3, 3, "capability")], rubric);
    const cmp = compareScores(current, baseline);
    expect(cmp.ready).toEqual(["case:new"]);
    expect(cmp.drops).toEqual([]);
    expect(cmp.unmatched).toEqual(["case:fresh"]);
  });
});

const curiosity = FEATURES.curiosity!;
const caseDef = caseSchema.parse({ id: "brief", title: "Brief done", origin: "o", testerLines: ["done", "yep"], whatWentWrong: "w", shouldHaveHappened: "s", suite: "capability" });

/** Plays nothing: wraps each plan as a finished conversation with one ZOH text and the given grade. */
function finished(pass: boolean, runsCount = 3): GradedConversation[] {
  return planConversations([], [caseDef], { runs: runsCount }).map((plan) => ({
    plan,
    phone: "+12125550101",
    context: [],
    transcript: [
      { from: "tester", text: "done", at: "2026-11-02T23:00:00Z" },
      { from: "zoh", text: "Nice, how did it feel?", at: "2026-11-02T23:00:05Z" },
    ],
    endedBy: "script",
    savedState: {},
    messageCount: 2,
    appErrors: [],
    usage: { input: 0, output: 0 },
    grade: { texts: [{ zohText: 1, checks: [check("natural", true)] }], conversation: [check("regression", pass)], summary: "" },
  }));
}

/** A grader that passes everything and records its calls. */
function countingGrader(): { complete: Completer; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const complete: Completer = async (req) => {
    calls.push(req);
    return { text: JSON.stringify({ texts: [{ zohText: 1, checks: [check("natural", true)] }], conversation: [check("regression", true)], summary: "ok" }), usage: { input: 10, output: 5 }, stopReason: "end_turn" };
  };
  return { complete, calls };
}

describe("eval: the comparison in the report (#197)", () => {
  it("says in plain words what got worse beyond noise, what didn't, and what's ready to graduate", () => {
    const baseline = scoreCases([...runs("x", "regression", 3, 3), ...runs("y", "regression", 3, 3), ...runs("cap", "regression", 3, 3, "capability")], rubric);
    const current = scoreCases([...runs("x", "regression", 0, 3), ...runs("y", "regression", 3, 3), ...runs("cap", "regression", 3, 3, "capability"), ...runs("new", "natural", 1, 3)], rubric);
    const lines = comparisonLines({ main: compareScores(current, baseline), rescripted: [] }).join("\n");
    expect(lines).toContain("⚠ **1 thing got worse beyond noise** (1 regression case)");
    expect(lines).toContain("The case's own goal: 100% → 67% on the same 3 cases (−33 points, too few cases for a margin), within noise.");
    expect(lines).toContain("`case:x` (case:x#1): The case's own goal passed 3/3 runs before, 0/3 now; failed regression.");
    expect(lines).toContain("Ready to graduate");
    expect(lines).toContain("No baseline yet, so not compared: `case:new`.");
    // One case: no margin to show. Groups that never applied get no row.
    expect(groupTable(groupScores(current))).toEqual(["| Group | Score | Cases passing every run |", "| --- | --- | --- |", "| Conversation | 33% (one case, no margin) | 0/1 |", "| The case's own goal | 67% (too few cases for a margin) | 2/3 |"]);
    expect(comparisonLines({ main: compareScores(baseline, baseline), rescripted: [] })[0]).toBe("**Nothing got worse beyond noise.**");
  });
});

describe("eval: re-grading saved conversations (#197)", () => {
  it("grades each saved conversation once with the current checks and never runs the coach", async () => {
    const saved = finished(false);
    const grader = countingGrader();
    const pages = await readPages(curiosity);
    const { convs, usage } = await regradeConversations(saved, { rubric: rubricFor(curiosity), pages, complete: grader.complete });
    expect(grader.calls).toHaveLength(3);
    expect(grader.calls[0]!.system).toContain(curiosity.rubric[0]!.label);
    // Same conversations, new grades: the transcripts are untouched (nothing was replayed).
    expect(convs.map((c) => c.transcript)).toEqual(saved.map((c) => c.transcript));
    expect(convs.every((c) => c.grade!.conversation[0]!.pass)).toBe(true);
    expect(usage).toEqual({ input: 30, output: 15 });
  });
});

describe("eval: stored baselines (#197)", () => {
  const grading = async () => ({ model: "claude-haiku-5-5", rubric: rubricFor(curiosity), pages: await readPages(curiosity) });

  it("stores one file per case, and a later comparison finds and uses it", async () => {
    const dir = `${await mkdtemp(join(tmpdir(), "zoh-baseline-"))}/`;
    const g = await grading();
    const res = await storeBaseline("curiosity", finished(true), (plan) => producerFor(plan, g), { branch: "dev", storedAt: "2026-11-15T00:00:00Z" }, dir);
    expect(res).toEqual({ stored: ["case:brief"], skipped: [] });
    expect(await readdir(`${dir}curiosity`)).toEqual(["case-brief.json"]);

    const found = await loadBaseline("curiosity", ["case:brief", "case:none"], dir);
    expect([...found.keys()]).toEqual(["case:brief"]);
    const entry = found.get("case:brief")!;
    expect(entry).toMatchObject({ suite: "capability", branch: "dev" });
    expect(entry.runs).toHaveLength(3);
    // The stored plan leaves out the case definition; it comes back from the repo's current one.
    expect(JSON.stringify(entry)).not.toContain("shouldHaveHappened");
    const plan = planConversations([], [caseDef], { runs: 1 })[0]!;
    const baselineRuns = entry.runs.map((r) => fromStored(r, plan));
    expect(baselineRuns[0]!.plan.regression?.shouldHaveHappened).toBe("s");

    // Passed every run in the baseline and again now: ready to graduate.
    const now = compareScores(scoreCases(finished(true), rubricFor(curiosity)), scoreCases(baselineRuns, rubricFor(curiosity)));
    expect(now.ready).toEqual(["case:brief"]);
    expect(now.unmatched).toEqual([]);
  });

  it("catches a changed rubric, voice page or grader as a mismatch, and a changed script as a different conversation", async () => {
    const g = await grading();
    const plan = planConversations([], [caseDef], { runs: 1 })[0]!;
    const stored = producerFor(plan, g);
    expect(producerChanges(stored, producerFor(plan, g))).toEqual([]);
    const relabeled = g.rubric.map((r) => (r.id === "natural" ? { ...r, label: `${r.label} (sharper)` } : r));
    expect(producerChanges(stored, producerFor(plan, { ...g, rubric: relabeled }))).toEqual(["checks"]);
    expect(producerChanges(stored, producerFor(plan, { ...g, pages: { ...g.pages, voice: `${g.pages.voice}\nA new line.` } }))).toEqual(["voice"]);
    expect(producerChanges(stored, producerFor(plan, { ...g, model: "claude-sonnet-5-5" }))).toEqual(["grader"]);
    // Regrouping a rule changes the score, not what the grader sees: no mismatch.
    const regrouped = g.rubric.map((r) => (r.id === "natural" ? { ...r, group: "style" as const } : r));
    expect(producerChanges(stored, producerFor(plan, { ...g, rubric: regrouped }))).toEqual([]);
    const rescripted = planConversations([], [{ ...caseDef, testerLines: ["done", "nah"] }], { runs: 1 })[0]!;
    expect(producerChanges(stored, producerFor(rescripted, g))).toEqual(["script"]);
  });
});
