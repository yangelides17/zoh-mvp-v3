import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NudgeRequest, Replier, ReplyInput } from "../src/claude/replier.js";
import { createSendblueClient } from "../src/sendblue/client.js";
import { appDeps } from "../src/wiring.js";
import type { Completer, CompletionRequest } from "../eval/claude.js";
import { UsageError, missingKeyMessage, parseEvalArgs } from "../eval/cli.js";
import { zonedDate } from "../eval/clock.js";
import { estimateCost } from "../eval/cost.js";
import { FEATURES, readPages, rubricFor } from "../eval/features.js";
import { overBudgetMessage, recordSpend, readLedger } from "../eval/budget.js";
import { gradeConversation, gradeJsonSchema, graderUserPrompt, parseGrade } from "../eval/grader.js";
import { evalConfig, guardFetch, runConversation, scriptedTester } from "../eval/harness.js";
import { loadCases, loadScenarios, planConversations } from "../eval/load.js";
import { aggregate, diffRuns, renderMarkdown, sameScope, suggestLiveChecks, worstReplies, type ReportData } from "../eval/report.js";
import { DONE, cleanSimulatorText, simulatedTester } from "../eval/simulator.js";
import type { Check, ConversationPlan, Grade, GradedConversation, TranscriptLine } from "../eval/types.js";

const onboarding = FEATURES.onboarding!;
const rubric = rubricFor(onboarding);

/** Echoes the tester so tests can see which text each reply answered. */
class EchoReplier implements Replier {
  received: ReplyInput["turns"][] = [];
  async reply({ turns }: ReplyInput) {
    this.received.push(turns);
    return `got: ${turns.at(-1)?.text}`;
  }
  async check() {}
}

const ok = (rule: string, reason = "fine"): Check => ({ rule, pass: true, borderline: false, reason });
const bad = (rule: string, reason = "broke it"): Check => ({ rule, pass: false, borderline: false, reason });
const meh = (rule: string, reason = "could go either way"): Check => ({ rule, pass: true, borderline: true, reason });

function conv(key: string, persona: ConversationPlan["persona"], grade: Grade, transcript?: TranscriptLine[]): GradedConversation {
  const zohCount = Math.max(...grade.texts.map((t) => t.zohText), 0);
  const lines: TranscriptLine[] =
    transcript ??
    Array.from({ length: zohCount }, (_, i) => [
      { from: "tester" as const, text: `tester ${i + 1}`, at: "2026-11-02T23:00:00Z" },
      { from: "zoh" as const, text: `zoh ${key} ${i + 1}`, at: "2026-11-02T23:00:05Z" },
    ]).flat();
  return {
    plan: { key, kind: "scenario", id: key, title: `Title ${key}`, persona, areaCode: "212", startTime: "18:30", timeZone: "America/New_York" },
    phone: "+12125550101",
    context: [],
    transcript: lines,
    endedBy: "simulator",
    savedState: {},
    messageCount: lines.length,
    appErrors: [],
    usage: { input: 0, output: 0 },
    grade,
  };
}

describe("eval: scenarios and cases", () => {
  it("loads every onboarding scenario and covers what the ticket asks for", () => {
    const scenarios = loadScenarios(onboarding);
    const ids = scenarios.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["alex-gym", "maya-all-at-once", "sam-reality-check", "sam-off-topic-book"]));
    expect(new Set(scenarios.map((s) => s.persona))).toEqual(new Set(["terse", "chatty", "joking", "confused", "all-at-once"]));
    const listGoals = new Set(scenarios.map((s) => s.goal).filter((g) => g !== "something-else"));
    expect(listGoals.size).toBeGreaterThanOrEqual(4);
    expect(scenarios.some((s) => s.timeZone !== "America/New_York")).toBe(true);
    expect(scenarios.filter((s) => s.goal === "something-else")).toHaveLength(2);
    expect(scenarios.some((s) => s.directions.some((d) => /no emojis pls/.test(d)))).toBe(true);
    expect(scenarios.some((s) => s.startTime.startsWith("23:"))).toBe(true);
    expect(scenarios.find((s) => s.id === "maya-all-at-once")?.opening).toMatch(/^hi! I'm Maya/);
  });

  it("rejects a bad scenario with its id", () => {
    const broken = { ...onboarding, scenarios: [{ ...onboarding.scenarios[0]!, areaCode: "12" }] };
    expect(() => loadScenarios(broken)).toThrow(/alex-gym/);
  });

  it("loads the example case and replays cases in file-name order", async () => {
    const shipped = await loadCases("onboarding");
    expect(shipped.map((c) => c.id)).toContain("form-in-disguise");

    const dir = await mkdtemp(join(tmpdir(), "zoh-cases-"));
    const base = { title: "t", origin: "o", whatWentWrong: "w", shouldHaveHappened: "s" };
    await writeFile(join(dir, "010-second.json"), JSON.stringify({ ...base, id: "second", testerLines: ["b"] }));
    await writeFile(join(dir, "002-first.json"), JSON.stringify({ ...base, id: "first", testerLines: ["a"] }));
    await writeFile(join(dir, "notes.txt"), "ignored");
    const cases = await loadCases("x", `${dir}/`);
    expect(cases.map((c) => c.id)).toEqual(["first", "second"]);
    expect(cases[0]).toMatchObject({ areaCode: "212", startTime: "18:30", timeZone: "America/New_York" });

    const plans = planConversations(loadScenarios(onboarding), cases, { persona: "joking", runs: 2 });
    expect(plans.filter((p) => p.kind === "scenario").every((p) => p.persona === "joking")).toBe(true);
    expect(plans.map((p) => p.key).slice(0, 2)).toEqual([expect.stringMatching(/#1$/), expect.stringMatching(/#2$/)]);
    expect(plans.slice(-2).map((p) => p.key)).toEqual(["case:first", "case:second"]);

    await writeFile(join(dir, "003-broken.json"), "{ nope");
    await expect(loadCases("x", `${dir}/`)).rejects.toThrow(/003-broken.json/);
    await rm(dir, { recursive: true });
    expect(await loadCases("no-such-feature")).toEqual([]);
  });
});

/** Echoes like EchoReplier, and writes nudges as "nudge: <moment>". */
class NudgingEcho extends EchoReplier {
  async nudge({ moment }: NudgeRequest) {
    return `nudge: ${moment}`;
  }
}

describe("eval: nudge cases", () => {
  it("\"advance to\" lines move the clock, run the tick each minute and add ZOH's own texts to the transcript", async () => {
    const cases = await loadCases("nudges");
    const silent = cases.find((c) => c.id === "silent-day")!;
    const plan = planConversations([], [silent], { runs: 1 })[0]!;
    const result = await runConversation(plan, scriptedTester(silent.testerLines), {
      maxTurns: silent.testerLines.length + 1,
      index: 2,
      env: {},
      replier: new NudgingEcho(),
    });
    expect(result.error).toBeUndefined();
    const local = (at: string) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: plan.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
    expect(result.transcript.map((l) => `${local(l.at)} ${l.text}${l.started ? " (started)" : ""}`)).toEqual([
      "09:00 nudge: kickoff (started)",
      "17:50 nudge: checkin (started)",
      "19:00 nudge: followup (started)",
    ]);
    expect(graderUserPrompt({ plan, transcript: result.transcript })).toContain("[ZOH 1, started by ZOH, not a reply]");
    expect(result.savedState).toMatchObject({ nudges: [{ kind: "kickoff" }, { kind: "checkin" }, { kind: "followup" }] });
  });

  it("every nudge case loads, with a seeded locked plan", async () => {
    const cases = await loadCases("nudges");
    expect(cases.map((c) => c.id)).toEqual(["full-pushy-day", "silent-day", "off-day", "cant-today", "day-after-a-miss", "day-three"]);
    expect(cases.every((c) => c.seed?.plan)).toBe(true);
    expect(cases.find((c) => c.id === "day-three")!.seed!.step_days).toHaveLength(4);
  });
});

describe("eval: running a conversation through the real app", () => {
  it("sends scripted lines one at a time, in order, each answered before the next", async () => {
    const [form] = await loadCases("onboarding");
    const plan = planConversations([], [form!], { runs: 1 })[0]!;
    const result = await runConversation(plan, scriptedTester(["Start", "Alex. Exercise", "mornings"]), {
      maxTurns: 10,
      index: 7,
      env: {},
      replier: new EchoReplier(),
    });
    expect(result.endedBy).toBe("script");
    expect(result.transcript.map((l) => `${l.from}: ${l.text}`)).toEqual([
      "tester: Start",
      "zoh: got: Start",
      "tester: Alex. Exercise",
      "zoh: got: Alex. Exercise",
      "tester: mornings",
      "zoh: got: mornings",
    ]);
    expect(result.phone).toBe("+12125550107");
    expect(result.messageCount).toBe(6);
    expect(result.appErrors).toEqual([]);
    // The tester T1 creates on the first text shows up in the saved state, phone masked.
    expect(result.savedState).toMatchObject({ testers: [{ phase: "onboarding", phone: "********0107" }] });
    // The injected clock starts at the case's local time and moves forward.
    expect(result.transcript[0]!.at).toBe(zonedDate("2026-11-02", "18:30", "America/New_York").toISOString());
    expect(result.transcript[5]!.at > result.transcript[0]!.at).toBe(true);
  });

  it("starts a seeded scenario partway in: saved state, a locked plan and the earlier conversation as context", async () => {
    const scenario = loadScenarios(FEATURES.plan!).find((s) => s.id === "switch-goal")!;
    const plan = planConversations([scenario], [], { runs: 1 })[0]!;
    const replier = new EchoReplier();
    let seen: string[] = [];
    const sim: Completer = async (req) => {
      seen = [String(req.messages[0]!.content)];
      return { text: DONE, usage: { input: 1, output: 1 }, stopReason: "end_turn" };
    };
    const result = await runConversation(plan, simulatedTester(scenario, sim, FEATURES.plan!.doneWhen), {
      maxTurns: 5,
      index: 3,
      env: {},
      replier,
    });
    // The opening is this tester's first text even though the seed already has lines.
    expect(result.transcript[0]).toMatchObject({ from: "tester", text: scenario.opening });
    expect(result.context.map((l) => l.from)).toEqual(["zoh", "tester", "zoh"]);
    expect(result.context.at(-1)!.at < result.transcript[0]!.at).toBe(true);
    // The coach sees the seeded conversation before the new text.
    expect(replier.received.at(0)!.map((t) => t.text)).toEqual([...scenario.seed!.history.map((h) => h.text), scenario.opening]);
    // The simulator sees it too.
    expect(seen[0]).toContain("LET'S GO 🔒");
    expect(result.savedState).toMatchObject({
      testers: [{ name: "Taylor", goal_slug: "reading", phase: "active" }],
      plans: [{ status: "locked", version: 1, step_time: "21:00", start_date: "2026-11-02T00:00:00.000Z" }],
      plan_inputs: [{ what: "The Midnight Library" }],
    });
  });

  it("stops at the turn cap and when the simulator says it's done", async () => {
    const scenario = loadScenarios(onboarding).find((s) => s.id === "all-at-once-reading-11pm")!;
    const plan = planConversations([scenario], [], { runs: 1 })[0]!;
    let calls = 0;
    const sim: Completer = async () => {
      calls += 1;
      return { text: calls >= 3 ? DONE : `text ${calls}`, usage: { input: 10, output: 2 }, stopReason: "end_turn" };
    };
    const result = await runConversation(plan, simulatedTester(scenario, sim, onboarding.doneWhen), {
      maxTurns: 20,
      index: 1,
      env: {},
      replier: new EchoReplier(),
    });
    expect(result.endedBy).toBe("simulator");
    expect(result.transcript.filter((l) => l.from === "tester")).toHaveLength(2);
    expect(result.usage).toEqual({ input: 30, output: 6 });
    expect(new Date(result.transcript[0]!.at).toISOString()).toBe(zonedDate("2026-11-02", "23:05", "America/New_York").toISOString());

    const capped = await runConversation(plan, scriptedTester(["a", "b", "c"]), {
      maxTurns: 2,
      index: 2,
      env: {},
      replier: new EchoReplier(),
    });
    expect(capped.endedBy).toBe("turn-cap");
    expect(capped.transcript.filter((l) => l.from === "tester")).toHaveLength(2);
  });

  it("can't reach Sendblue: no client from config, and fetch to Sendblue is blocked", async () => {
    const config = evalConfig({ ANTHROPIC_API_KEY: "k", SENDBLUE_API_KEY_ID: "id", SENDBLUE_API_KEY_SECRET: "s", SENDBLUE_NUMBER: "+19177412162" }, "+12125550101");
    expect(config.sendblue.apiKeyId).toBeUndefined();
    expect(config.allowedNumbers).toEqual(["+12125550101"]);
    expect(appDeps(config, {} as never).pipeline.sendblue).toBeUndefined();

    const restore = guardFetch();
    try {
      const real = createSendblueClient({ baseUrl: "https://api.sendblue.com", apiKeyId: "x", apiKeySecret: "y", fromNumber: "+1" });
      await expect(real.sendMessage({ number: "+12125550101", content: "hi" })).rejects.toThrow(/never call Sendblue/);
    } finally {
      restore();
    }
  });

  it("wiring only builds services that aren't overridden", () => {
    const config = evalConfig({ ANTHROPIC_API_KEY: "k" }, "+12125550101");
    const replier = new EchoReplier();
    const deps = appDeps(config, {} as never, { replier, allowedNumbers: ["+1"] });
    expect(deps.pipeline.replier).toBe(replier);
    expect(deps.pipeline.allowedNumbers).toEqual(["+1"]);
    expect(appDeps(config, {} as never).pipeline.replier).toBeDefined();
  });
});

describe("eval: grader", () => {
  it("shows a seeded conversation as context, separate from the graded texts", () => {
    const at = "2026-11-02T23:00:00Z";
    const prompt = graderUserPrompt({
      plan: { key: "k", kind: "scenario", id: "k", title: "t", persona: "terse", areaCode: "212", startTime: "18:00", timeZone: "America/New_York" },
      context: [{ from: "zoh", text: "Earlier ZOH line", at }],
      transcript: [
        { from: "tester", text: "hi", at },
        { from: "zoh", text: "New ZOH line", at },
      ],
    });
    expect(prompt).toContain("=== Earlier conversation (context only");
    expect(prompt).toContain("[ZOH earlier] (6:00 pm) Earlier ZOH line");
    expect(prompt).toContain("[ZOH 1] (6:00 pm) New ZOH line");
    expect(prompt.indexOf("Earlier ZOH line")).toBeLessThan(prompt.indexOf("=== Transcript ==="));
  });

  const good: Grade = {
    texts: [{ zohText: 1, checks: [ok("one-question"), bad("short")] }],
    conversation: [bad("first-text")],
    summary: "Meh.",
  };
  const plan = conv("x", "terse", good).plan;
  const transcript: TranscriptLine[] = [
    { from: "tester", text: "Start", at: "2026-11-03T04:05:00Z" },
    { from: "zoh", text: "Welcome! 1. name 2. goal", at: "2026-11-03T04:05:10Z" },
  ];

  it("grades against the feature's approved checks and the voice page", async () => {
    const pages = await readPages(onboarding);
    expect(pages.rules).toContain("One question per text");
    expect(pages.rules.split("\n")).toHaveLength(onboarding.rubric.length);
    expect(pages.voice).toContain("Coach voice");
  });

  it("labels ZOH texts and shows local time and the regression expectation", () => {
    const prompt = graderUserPrompt({ plan: { ...plan, regression: { id: "r", title: "t", origin: "o", testerLines: ["Start"], whatWentWrong: "W", shouldHaveHappened: "S", areaCode: "212", startTime: "23:05", timeZone: "America/New_York" } }, transcript });
    expect(prompt).toContain("[ZOH 1] (11:05 pm) Welcome!");
    expect(prompt).toContain("(Eastern)");
    expect(prompt).toContain("What should happen: S");
  });

  it("rejects output with unknown rules or texts that don't exist", () => {
    expect(parseGrade(JSON.stringify(good), rubric, 1)).toEqual(good);
    expect(() => parseGrade("not json", rubric, 1)).toThrow(/not JSON/);
    expect(() => parseGrade(JSON.stringify({ ...good, texts: [{ zohText: 2, checks: [] }] }), rubric, 1)).toThrow(/only 1/);
    expect(() => parseGrade(JSON.stringify({ ...good, conversation: [bad("vibes")] }), rubric, 1)).toThrow(/not a rubric rule/);
    expect(() => parseGrade(JSON.stringify({ ...good, texts: [{ zohText: 1, checks: [bad("vibes")] }] }), rubric, 1)).toThrow(/not a rubric rule/);
  });

  it("repairs rules filed under the wrong scope instead of discarding the grade", () => {
    // Seen live: the grader scored first-text on ZOH text 1 instead of the whole conversation.
    const moved = parseGrade(JSON.stringify({ ...good, texts: [{ zohText: 1, checks: [ok("one-question"), bad("first-text", "no stop line")] }], conversation: [] }), rubric, 1);
    expect(moved.texts[0]!.checks).toEqual([ok("one-question")]);
    expect(moved.conversation).toEqual([bad("first-text", "no stop line")]);
    // Already scored on the conversation: the conversation's own check wins.
    const kept = parseGrade(JSON.stringify({ ...good, texts: [{ zohText: 1, checks: [ok("first-text")] }] }), rubric, 1);
    expect(kept.texts[0]!.checks).toEqual([]);
    expect(kept.conversation).toEqual(good.conversation);
    // A per-text rule on the whole conversation is dropped.
    expect(parseGrade(JSON.stringify({ ...good, conversation: [bad("short"), bad("first-text")] }), rubric, 1).conversation).toEqual([bad("first-text")]);
  });

  it("limits each scope's rule ids in the structured-output schema", () => {
    const schema = gradeJsonSchema(rubric) as any; // nested JSON schema; typing it fully adds nothing here
    const textIds: string[] = schema.properties.texts.items.properties.checks.items.properties.rule.enum;
    const convIds: string[] = schema.properties.conversation.items.properties.rule.enum;
    expect(textIds).toContain("short");
    expect(textIds).not.toContain("first-text");
    expect(convIds).toContain("first-text");
    expect(convIds).not.toContain("short");
  });

  it("retries once on malformed output, then gives up with a reason", async () => {
    const pages = { rules: "## 4. Rules\n- x", voice: "voice" };
    const replies = ["{ broken", JSON.stringify(good)];
    const seen: CompletionRequest[] = [];
    const flaky: Completer = async (req) => {
      seen.push(req);
      return { text: replies.shift() ?? "", usage: { input: 100, output: 10 }, stopReason: "end_turn" };
    };
    const res = await gradeConversation({ plan, transcript, rubric, pages }, flaky);
    expect(res.grade).toEqual(good);
    expect(res.usage).toEqual({ input: 200, output: 20 });
    expect(seen[0]!.system).toContain("## 4. Rules");
    expect(seen[0]!.jsonSchema).toBeDefined();

    const broken: Completer = async () => ({ text: "nope", usage: { input: 1, output: 1 }, stopReason: "max_tokens" });
    const failed = await gradeConversation({ plan, transcript, rubric, pages }, broken);
    expect(failed.grade).toBeUndefined();
    expect(failed.error).toMatch(/after a retry: grader output is not JSON \(stop: max_tokens\)/);
  });
});

describe("eval: report", () => {
  const a = conv("a", "terse", {
    texts: [
      { zohText: 1, checks: [ok("one-question"), bad("short", "four sentences"), bad("voice", "flat")] },
      { zohText: 2, checks: [ok("one-question"), meh("voice")] },
    ],
    conversation: [bad("first-text", "no goal list"), ok("nothing-twice")],
    summary: "",
  });
  const b = conv("b", "chatty", {
    texts: [
      { zohText: 1, checks: [bad("one-question", "two questions"), ok("short")] },
      { zohText: 2, checks: [bad("one-question", "asks twice"), bad("short"), bad("no-repeat", "asked name again")] },
    ],
    conversation: [bad("first-text", "no stop line")],
    summary: "",
  });

  it("aggregates pass rates per rule, persona and overall", () => {
    const s = aggregate([a, b]);
    expect(s.overall).toMatchObject({ pass: 5, fail: 8, total: 13, borderline: 1 });
    expect(s.rules["one-question"]).toMatchObject({ pass: 2, total: 4, rate: 0.5 });
    expect(s.rules["first-text"]).toMatchObject({ pass: 0, total: 2, rate: 0 });
    expect(s.rules.voice).toMatchObject({ pass: 1, total: 2, borderline: 1 });
    expect(s.personas.terse).toMatchObject({ pass: 4, total: 7 });
    expect(s.personas.chatty).toMatchObject({ pass: 1, total: 6 });
    expect(s.conversations.b?.rate).toBeCloseTo(1 / 6);
    // A conversation that couldn't be graded adds nothing.
    expect(aggregate([{ ...a, grade: undefined, gradeError: "x" }]).overall.total).toBe(0);
  });

  it("picks the worst replies: most failures, then borderline, then earliest", () => {
    const worst = worstReplies([a, b], 3);
    expect(worst.map((w) => `${w.key}#${w.zohText}`)).toEqual(["b#2", "a#1", "b#1"]);
    expect(worst[0]).toMatchObject({ text: "zoh b 2", after: "tester 2" });
    expect(worst[0]!.failed.map((c) => c.rule)).toEqual(["one-question", "short", "no-repeat"]);
    expect(worstReplies([a], 3)).toHaveLength(1);
  });

  it("diffs against the previous run, ignoring small moves", () => {
    const before = aggregate([a, b]);
    const fixedB = conv("b", "chatty", {
      texts: [{ zohText: 1, checks: [ok("one-question"), ok("short")] }],
      conversation: [ok("first-text"), ok("tracking")],
      summary: "",
    });
    const after = aggregate([a, fixedB]);
    const d = diffRuns(after, before, "prev.json");
    expect(d.previousRun).toBe("prev.json");
    expect(d.overall.before).toBeCloseTo(5 / 13);
    expect(d.overall.after).toBeCloseTo(8 / 11);
    expect(d.rules.find((r) => r.name === "one-question")).toEqual({ name: "one-question", before: 0.5, after: 1 });
    expect(d.rules.find((r) => r.name === "tracking")).toEqual({ name: "tracking", before: null, after: 1 });
    expect(d.rules.find((r) => r.name === "no-repeat")).toEqual({ name: "no-repeat", before: 0, after: null });
    expect(d.rules.find((r) => r.name === "voice")).toBeUndefined();
    expect(d.personas.map((p) => p.name)).toEqual(["chatty"]);
    expect(diffRuns(before, before, "same").rules).toEqual([]);
  });

  it("suggests live checks from the most-failed rules, then borderline ones, one per rule", () => {
    const checks = suggestLiveChecks([a, b], rubric, 5);
    expect(checks.map((c) => c.rule)).toEqual(["first-text", "one-question", "short", "no-repeat", "voice"]);
    expect(checks[0]!.evidence).toBe("failed 2x in the sim; e.g. a: no goal list");
    expect(checks[1]!.suggestion).toContain("Title b");
    const onlyBorderline = conv("c", "joking", { texts: [{ zohText: 1, checks: [meh("voice", "a bit much")] }], conversation: [], summary: "" });
    expect(suggestLiveChecks([onlyBorderline], rubric)).toEqual([
      { rule: "voice", suggestion: expect.stringContaining("Title c"), evidence: "borderline in the sim; e.g. c: a bit much" },
    ]);
    expect(suggestLiveChecks([a, b], rubric, 3)).toHaveLength(3);
  });

  it("only compares with an earlier run over the same personas", () => {
    expect(sameScope({}, undefined)).toBe(true);
    expect(sameScope({ persona: "terse" }, "terse")).toBe(true);
    expect(sameScope({}, "terse")).toBe(false);
    expect(sameScope({ persona: "terse" }, undefined)).toBe(false);
    expect(sameScope({ persona: "terse" }, "chatty")).toBe(false);
    expect(sameScope({ cases: ["b", "a"] }, undefined, ["a", "b"])).toBe(true);
    expect(sameScope({ cases: ["a"] }, undefined)).toBe(false);
    expect(sameScope({}, undefined, ["a"])).toBe(false);
  });

  it("draws each live check's example from a different conversation when it can", () => {
    const c = conv("c", "joking", { texts: [{ zohText: 1, checks: [bad("short", "rambles"), bad("one-question")] }], conversation: [bad("first-text")], summary: "" });
    const checks = suggestLiveChecks([a, c, b], rubric, 3);
    expect(checks.map((k) => k.rule)).toEqual(["first-text", "one-question", "short"]);
    expect(checks.map((k) => k.evidence.split(":")[0])).toEqual([
      "failed 3x in the sim; e.g. a",
      "failed 3x in the sim; e.g. c",
      "failed 3x in the sim; e.g. b",
    ]);
  });

  it("renders a report with every section", () => {
    const report: ReportData = {
      feature: "onboarding",
      startedAt: "s",
      finishedAt: "f",
      models: { coach: "c", eval: "e" },
      options: { runs: 1, maxTurns: 20 },
      rubric,
      summary: aggregate([a, b]),
      worst: worstReplies([a, b]),
      liveChecks: suggestLiveChecks([a, b], rubric),
      diff: diffRuns(aggregate([a]), aggregate([a, b]), "prev.json"),
      usage: { input: 1, output: 2 },
      conversations: [a, b],
    };
    const md = renderMarkdown(report);
    for (const heading of ["Pass rate per rule", "Pass rate per persona", "Three worst replies", "Changed since the previous run", "Suggested live checks", "Saved state"]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain("**Overall: 38%**");
    expect(md).toContain("> zoh b 2");
  });
});

describe("eval: command line and cost", () => {
  it("parses arguments and explains mistakes", () => {
    expect(parseEvalArgs(["onboarding"])).toEqual({
      feature: "onboarding",
      runs: 1,
      maxTurns: 20,
      concurrency: 3,
      dryRun: false,
      overBudget: false,
      persona: undefined,
      cases: undefined,
      scenarios: undefined,
    });
    expect(parseEvalArgs(["plan", "--scenario", "a", "--scenario", "b"]).scenarios).toEqual(["a", "b"]);
    expect(() => parseEvalArgs(["plan", "--scenario", "a", "--persona", "terse"])).toThrow(/drop --persona/);
    expect(parseEvalArgs(["onboarding", "--case", "a", "--case", "b"]).cases).toEqual(["a", "b"]);
    expect(() => parseEvalArgs(["onboarding", "--case", "a", "--persona", "terse"])).toThrow(/drop --persona/);
    expect(parseEvalArgs(["onboarding", "--over-budget"]).overBudget).toBe(true);
    expect(parseEvalArgs(["onboarding", "--persona", "terse", "--runs", "3"])).toMatchObject({ persona: "terse", runs: 3 });
    expect(() => parseEvalArgs([])).toThrow(UsageError);
    expect(() => parseEvalArgs(["checkins"])).toThrow(/Unknown feature/);
    expect(() => parseEvalArgs(["onboarding", "--persona", "grumpy"])).toThrow(/Unknown persona/);
    expect(() => parseEvalArgs(["onboarding", "--runs", "0"])).toThrow(/at least 1/);
  });

  it("gives a clear message when the API key is missing", () => {
    expect(missingKeyMessage({})).toMatch(/ANTHROPIC_API_KEY is not set.*\n.*\.env/);
    expect(missingKeyMessage({ ANTHROPIC_API_KEY: "  " })).toBeDefined();
    expect(missingKeyMessage({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBeUndefined();
    expect(missingKeyMessage({ EVAL_ANTHROPIC_API_KEY: "sk-ant-y" })).toBeUndefined();
    expect(evalConfig({ EVAL_ANTHROPIC_API_KEY: "sk-ant-y" }, "+12125550101").claude.apiKey).toBe("sk-ant-y");
  });

  it("plays only the named scenarios with --scenario", async () => {
    const plan = FEATURES.plan!;
    const plans = planConversations(loadScenarios(plan), await loadCases("onboarding"), { scenarios: ["bedtime-late"], runs: 1 });
    expect(plans.map((p) => p.key)).toEqual(["bedtime-late"]);
    expect(plans[0]!.seed).toMatchObject({ goal: "bedtime", phase: "onboarding" });
    expect(() => planConversations(loadScenarios(plan), [], { scenarios: ["nope"], runs: 1 })).toThrow(/Unknown scenario id: nope/);
  });

  it("plays only the named cases on a targeted run", async () => {
    const cases = await loadCases("onboarding");
    const plans = planConversations(loadScenarios(onboarding), cases, { cases: ["recap-invents-details"], runs: 1 });
    expect(plans.map((p) => p.key)).toEqual(["case:recap-invents-details"]);
    expect(() => planConversations([], cases, { cases: ["nope"], runs: 1 })).toThrow(/Unknown case id: nope/);
  });

  it("estimates more for longer runs and pricier models", async () => {
    const plans = planConversations(loadScenarios(onboarding), await loadCases("onboarding"), { runs: 1 });
    const base = { maxTurns: 20, pagesChars: 20_000, coachModel: "claude-sonnet-5-5", evalModel: "claude-sonnet-5-5" };
    const est = estimateCost(plans, base);
    expect(est.conversations).toBe(plans.length);
    expect(est.tokens.high).toBeGreaterThan(est.tokens.low);
    expect(estimateCost(plans, { ...base, evalModel: "claude-opus-5-5" }).dollars.high).toBeGreaterThan(est.dollars.high);
    expect(estimateCost(plans, { ...base, maxTurns: 5 }).tokens.high).toBeLessThan(est.tokens.high);
    expect(estimateCost(plans, { ...base, simModel: "claude-haiku-5-5" }).dollars.high).toBeLessThan(est.dollars.high);
  });

  it("keeps each branch within its eval budget", async () => {
    const fit = { spentUsd: 0.5, estimateUsd: { low: 0.5, high: 1.5 }, budgetUsd: 2, branch: "feature/x" };
    expect(overBudgetMessage(fit)).toBeUndefined();
    expect(overBudgetMessage({ ...fit, spentUsd: 1.2 })).toMatch(/\$1\.20 of \$2\.00 already spent on feature\/x/);
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = `${await mkdtemp(`${tmpdir()}/ledger-`)}/spend.json`;
    expect(await readLedger(path)).toEqual({});
    await recordSpend(path, "feature/x", 0.75);
    const ledger = await recordSpend(path, "feature/x", 0.5);
    expect(ledger["feature/x"]).toEqual({ spentUsd: 1.25, runs: 2 });
  });

  it("cleans up what the simulator writes", () => {
    expect(cleanSimulatorText('YOU: "hey there"', "Alex")).toBe("hey there");
    expect(cleanSimulatorText("Alex: mornings", "Alex")).toBe("mornings");
    expect(cleanSimulatorText("Honestly: idk", "Alex")).toBe("Honestly: idk");
  });
});
