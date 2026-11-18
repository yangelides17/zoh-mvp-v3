/**
 * Scoring by group, with honest margins, and comparing two runs case by case (#197).
 *
 * A conversation passes a group only if every check in that group passed (text checks on every text), so
 * formatting can't sink conversation quality or the other way round. Each case's runs are averaged first and
 * the case is the unit: margins come from how much cases differ, not from counting every run as independent.
 */
import { GROUPS, type Group, type RubricRule } from "./features.js";
import type { GradedConversation, Suite } from "./types.js";

/** Groups that decide whether a change is better or worse; style is shown but never decides. */
export const DECIDING: readonly Group[] = ["conversation", "goal", "flow"];

export const GROUP_LABELS: Record<Group, string> = {
  conversation: "Conversation",
  goal: "The case's own goal",
  flow: "Flow and facts",
  style: "Style and format",
};

/** One group's results over a case's runs. */
export interface GroupRuns {
  /** Graded runs this group applied to. */
  runs: number;
  passes: number;
  /** Rules that failed in any run. */
  failed: string[];
}

export interface CaseScore {
  /** The conversation key without its run number, e.g. "case:brief-done". */
  id: string;
  title: string;
  suite: Suite;
  /** Graded runs. */
  runs: number;
  groups: Partial<Record<Group, GroupRuns>>;
}

export interface GroupScore {
  group: Group;
  /** Cases the group applied to. */
  cases: number;
  /** Mean over cases of each case's pass share; null when no case applied. */
  rate: number | null;
  /** 95% margin (±) from the spread between cases; null with fewer than 2 cases. */
  margin: number | null;
  /** Cases that passed this group in every run. */
  everyRun: number;
}

export type Verdict = "better" | "worse" | "same";

export interface GroupChange {
  group: Group;
  /** Cases in both runs that the group applied to; the comparison is only over these. */
  cases: number;
  before: number | null;
  after: number | null;
  /** Mean of the per-case differences, with its 95% margin (null with fewer than 2 cases). */
  diff: number | null;
  margin: number | null;
  verdict: Verdict;
}

export interface CaseDrop {
  id: string;
  title: string;
  group: Group;
  before: GroupRuns;
  after: GroupRuns;
}

export interface Comparison {
  groups: GroupChange[];
  /** Regression cases worse beyond noise in a deciding group. */
  drops: CaseDrop[];
  /** Nov 15: cases that passed a deciding group less often than the baseline, not beyond noise: rerun them 3 times. */
  slipped: string[];
  /** Capability cases that passed every run in the baseline and again now. */
  ready: string[];
  /** Cases with no baseline yet. */
  unmatched: string[];
}

export function caseIdOf(key: string): string {
  return key.replace(/#\d+$/, "");
}

/** Per-case, per-group results. Ungraded runs (errors) aren't counted as passes or fails. */
export function scoreCases(convs: Pick<GradedConversation, "plan" | "grade">[], rubric: RubricRule[]): CaseScore[] {
  const groupOf = new Map(rubric.map((r) => [r.id, r.group]));
  const out = new Map<string, CaseScore>();
  for (const conv of convs) {
    if (!conv.grade) continue;
    const id = caseIdOf(conv.plan.key);
    const score = out.get(id) ?? { id, title: conv.plan.title, suite: conv.plan.suite ?? "regression", runs: 0, groups: {} };
    score.runs += 1;
    const applied = new Map<Group, Set<string>>();
    for (const c of [...conv.grade.texts.flatMap((t) => t.checks), ...conv.grade.conversation]) {
      // The case's own check means nothing on a simulated conversation, though the grader sometimes scores it there.
      if (c.rule === "regression" && conv.plan.kind !== "case") continue;
      const group = groupOf.get(c.rule) ?? "flow";
      if (!applied.has(group)) applied.set(group, new Set());
      if (!c.pass) applied.get(group)!.add(c.rule);
    }
    for (const [group, failed] of applied) {
      const g = (score.groups[group] ??= { runs: 0, passes: 0, failed: [] });
      g.runs += 1;
      if (failed.size === 0) g.passes += 1;
      for (const rule of failed) if (!g.failed.includes(rule)) g.failed.push(rule);
    }
    out.set(id, score);
  }
  return [...out.values()];
}

/** Whether a case passed every deciding group in every graded run. */
export function passedEveryRun(score: CaseScore): boolean {
  return score.runs > 0 && DECIDING.every((g) => !score.groups[g] || score.groups[g]!.passes === score.groups[g]!.runs);
}

export function groupScores(cases: CaseScore[]): Record<Group, GroupScore> {
  const out = {} as Record<Group, GroupScore>;
  for (const group of GROUPS) {
    const applied = cases.map((c) => c.groups[group]).filter((g): g is GroupRuns => !!g && g.runs > 0);
    const shares = applied.map((g) => g.passes / g.runs);
    const { mean, margin } = meanAndMargin(shares);
    out[group] = { group, cases: applied.length, rate: mean, margin, everyRun: applied.filter((g) => g.passes === g.runs).length };
  }
  return out;
}

/**
 * Compares a run with a baseline, case by case. A group is worse (or better) only when both agree:
 * the per-case differences' 95% range is wholly below (above) zero, and a Fisher test on the pooled runs
 * says the same at 5%, which keeps a few identical cases from looking certain. One case alone uses Fisher.
 * Replays should be compared on their own (they're never tuned against).
 */
export function compareScores(current: CaseScore[], baseline: CaseScore[]): Comparison {
  const before = new Map(baseline.map((c) => [c.id, c]));
  const groups: GroupChange[] = GROUPS.map((group) => {
    const pairs = current
      .map((c) => [before.get(c.id)?.groups[group], c.groups[group]] as const)
      .filter((p): p is readonly [GroupRuns, GroupRuns] => !!p[0]?.runs && !!p[1]?.runs);
    if (pairs.length === 0) return { group, cases: 0, before: null, after: null, diff: null, margin: null, verdict: "same" };
    const share = (g: GroupRuns) => g.passes / g.runs;
    const b = mean(pairs.map(([x]) => share(x)))!;
    const a = mean(pairs.map(([, y]) => share(y)))!;
    const { mean: diff, margin } = meanAndMargin(pairs.map(([x, y]) => share(y) - share(x)));
    const pooled = pairs.reduce((t, [x, y]) => ({ bp: t.bp + x.passes, bn: t.bn + x.runs, ap: t.ap + y.passes, an: t.an + y.runs }), { bp: 0, bn: 0, ap: 0, an: 0 });
    const lower = fisherLower(pooled.bp, pooled.bn, pooled.ap, pooled.an) <= ALPHA;
    const upper = fisherLower(pooled.ap, pooled.an, pooled.bp, pooled.bn) <= ALPHA;
    let verdict: Verdict = "same";
    if (margin === null) verdict = lower ? "worse" : upper ? "better" : "same";
    else if (diff! + margin < 0 && lower) verdict = "worse";
    else if (diff! - margin > 0 && upper) verdict = "better";
    return { group, cases: pairs.length, before: b, after: a, diff, margin, verdict };
  });
  const drops: CaseDrop[] = [];
  const slipped: string[] = [];
  const ready: string[] = [];
  const unmatched: string[] = [];
  for (const c of current) {
    const was = before.get(c.id);
    if (!was) {
      unmatched.push(c.id);
      continue;
    }
    if (c.suite === "regression") {
      for (const group of DECIDING) {
        const x = was.groups[group];
        const y = c.groups[group];
        if (x?.runs && y?.runs && fisherLower(x.passes, x.runs, y.passes, y.runs) <= ALPHA) drops.push({ id: c.id, title: c.title, group, before: x, after: y });
      }
    }
    const share = (g: GroupRuns) => g.passes / g.runs;
    const fell = DECIDING.some((group) => {
      const x = was.groups[group];
      const y = c.groups[group];
      return !!x?.runs && !!y?.runs && share(y) < share(x);
    });
    if (fell && c.suite !== "replay" && !drops.some((d) => d.id === c.id)) slipped.push(c.id);
    if (c.suite === "capability" && passedEveryRun(c) && passedEveryRun(was)) ready.push(c.id);
  }
  return { groups, drops, slipped, ready, unmatched };
}

// ---- Statistics ----

const ALPHA = 0.05 + 1e-9;

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Mean and 95% margin (Student's t on the spread between the values); no margin below 2 values. */
export function meanAndMargin(xs: number[]): { mean: number | null; margin: number | null } {
  const m = mean(xs);
  if (m === null || xs.length < 2) return { mean: m, margin: null };
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return { mean: m, margin: tCritical(xs.length - 1) * Math.sqrt(variance / xs.length) };
}

/** Two-sided 95% critical values of Student's t for 1 to 30 degrees of freedom. */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

export function tCritical(df: number): number {
  return T95[df - 1] ?? (df <= 60 ? 2.0 : 1.96);
}

/**
 * One-sided Fisher exact test: the chance of `afterPasses` or fewer out of `afterRuns`, if both sides
 * had the same pass rate (given the passes and runs on both). Small means "after" really is lower.
 */
export function fisherLower(beforePasses: number, beforeRuns: number, afterPasses: number, afterRuns: number): number {
  const total = beforeRuns + afterRuns;
  const passes = beforePasses + afterPasses;
  const lo = Math.max(0, passes - beforeRuns);
  let p = 0;
  for (let k = lo; k <= afterPasses; k++) p += Math.exp(logChoose(passes, k) + logChoose(total - passes, afterRuns - k) - logChoose(total, afterRuns));
  return Math.min(1, p);
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}
