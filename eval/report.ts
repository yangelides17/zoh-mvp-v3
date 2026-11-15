import { GROUPS, type Group, type RubricRule } from "./features.js";
import { DECIDING, GROUP_LABELS, type Comparison, type GroupChange, type GroupScore } from "./score.js";
import type { Check, GradedConversation, TokenUsage } from "./types.js";

export interface Tally {
  pass: number;
  fail: number;
  borderline: number;
  total: number;
  /** pass / total, or null when nothing was scored. */
  rate: number | null;
}

export interface Summary {
  overall: Tally;
  rules: Record<string, Tally>;
  personas: Record<string, Tally>;
  conversations: Record<string, Tally>;
}

export interface WorstReply {
  key: string;
  title: string;
  persona: string;
  zohText: number;
  text: string;
  /** The tester text it answered, for context. */
  after?: string;
  failed: Check[];
  borderline: Check[];
}

export interface RuleChange {
  name: string;
  before: number | null;
  after: number | null;
}

export interface RunDiff {
  previousRun: string;
  overall: RuleChange;
  rules: RuleChange[];
  personas: RuleChange[];
  /** Conversation keys whose pass rate moved, plus ones only one run had. */
  conversations: RuleChange[];
}

export interface LiveCheck {
  rule: string;
  suggestion: string;
  evidence: string;
}

export interface ReportData {
  feature: string;
  startedAt: string;
  finishedAt: string;
  models: { coach: string; eval: string; sim?: string };
  /** Dollars this run spent (simulator and grader measured, coach estimated). */
  costUsd?: number;
  options: { persona?: string; cases?: string[]; runs: number; maxTurns: number };
  rubric: RubricRule[];
  summary: Summary;
  worst: WorstReply[];
  liveChecks: LiveCheck[];
  diff?: RunDiff;
  /** #197: scores by group over this run's cases, real replays apart. */
  groups?: Record<Group, GroupScore>;
  replayGroups?: Record<Group, GroupScore>;
  /** #197: compared with the stored baseline, case by case. */
  comparison?: { main: Comparison; replays?: Comparison; rescripted: string[] };
  /** The saved report this one re-grades, when it does. */
  regradedFrom?: string;
  usage: TokenUsage;
  conversations: GradedConversation[];
}

const empty = (): Tally => ({ pass: 0, fail: 0, borderline: 0, total: 0, rate: null });

function add(t: Tally, c: Check): void {
  t.total += 1;
  if (c.pass) t.pass += 1;
  else t.fail += 1;
  if (c.borderline) t.borderline += 1;
  t.rate = t.pass / t.total;
}

/** Every check in a graded conversation, per-text and whole-conversation alike. */
export function allChecks(conv: GradedConversation): Check[] {
  if (!conv.grade) return [];
  return [...conv.grade.texts.flatMap((t) => t.checks), ...conv.grade.conversation];
}

/** Pass rates per rule, per persona, per conversation and overall. */
export function aggregate(convs: GradedConversation[]): Summary {
  const s: Summary = { overall: empty(), rules: {}, personas: {}, conversations: {} };
  for (const conv of convs) {
    for (const c of allChecks(conv)) {
      add(s.overall, c);
      add((s.rules[c.rule] ??= empty()), c);
      add((s.personas[conv.plan.persona] ??= empty()), c);
      add((s.conversations[conv.plan.key] ??= empty()), c);
    }
  }
  return s;
}

/** ZOH texts ranked worst first: most failed rules, then most borderline calls, then earliest. */
export function worstReplies(convs: GradedConversation[], n = 3): WorstReply[] {
  const all: (WorstReply & { order: number })[] = [];
  let order = 0;
  for (const conv of convs) {
    const zoh = zohTextsWithContext(conv);
    for (const t of conv.grade?.texts ?? []) {
      const reply = zoh[t.zohText - 1];
      if (!reply) continue;
      const failed = t.checks.filter((c) => !c.pass);
      if (failed.length === 0) continue;
      all.push({
        key: conv.plan.key,
        title: conv.plan.title,
        persona: conv.plan.persona,
        zohText: t.zohText,
        text: reply.text,
        after: reply.after,
        failed,
        borderline: t.checks.filter((c) => c.borderline),
        order: order++,
      });
    }
  }
  all.sort((a, b) => b.failed.length - a.failed.length || b.borderline.length - a.borderline.length || a.order - b.order);
  return all.slice(0, n).map(({ order: _order, ...rest }) => rest);
}

function zohTextsWithContext(conv: GradedConversation): { text: string; after?: string }[] {
  const out: { text: string; after?: string }[] = [];
  let lastTester: string | undefined;
  for (const line of conv.transcript) {
    if (line.from !== "zoh") lastTester = line.text;
    else out.push({ text: line.text, after: lastTester });
  }
  return out;
}

/**
 * Whether an earlier run is comparable with this one: same persona filter and same targeted cases,
 * so a one-persona or one-case run isn't compared with the full suite (or the other way round).
 * Run counts may differ.
 */
export function sameScope(
  previous: Pick<ReportData["options"], "persona" | "cases">,
  persona: string | undefined,
  cases?: string[],
): boolean {
  const key = (ids: string[] | undefined) => (ids?.length ? [...ids].sort().join(",") : "");
  return (previous.persona ?? undefined) === (persona ?? undefined) && key(previous.cases) === key(cases);
}

/** What moved since the previous run. Rates within `threshold` of each other count as unchanged. */
export function diffRuns(current: Summary, previous: Summary, previousRun: string, threshold = 0.05): RunDiff {
  const moved = (a: Record<string, Tally>, b: Record<string, Tally>): RuleChange[] => {
    const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return names
      .map((name) => ({ name, before: b[name]?.rate ?? null, after: a[name]?.rate ?? null }))
      .filter((c) => c.before === null || c.after === null || Math.abs(c.after - c.before) >= threshold);
  };
  return {
    previousRun,
    overall: { name: "overall", before: previous.overall.rate, after: current.overall.rate },
    rules: moved(current.rules, previous.rules),
    personas: moved(current.personas, previous.personas),
    conversations: moved(current.conversations, previous.conversations),
  };
}

/**
 * 3 to 5 things for Yanni to try on his phone: the rules that failed most first (one per rule,
 * from the conversation where it failed), then borderline passes to fill up. Each check's example
 * comes from a conversation no earlier check used, when there is one, so they don't all repeat.
 */
export function suggestLiveChecks(convs: GradedConversation[], rubric: RubricRule[], max = 5): LiveCheck[] {
  const label = new Map(rubric.map((r) => [r.id, r.label]));
  type Hit = { rule: string; conv: GradedConversation; check: Check };
  const fails = new Map<string, Hit[]>();
  const borderline = new Map<string, Hit[]>();
  for (const conv of convs) {
    for (const check of allChecks(conv)) {
      const bucket = !check.pass ? fails : check.borderline ? borderline : undefined;
      if (!bucket) continue;
      if (!bucket.has(check.rule)) bucket.set(check.rule, []);
      bucket.get(check.rule)!.push({ rule: check.rule, conv, check });
    }
  }
  const ranked = (m: Map<string, Hit[]>) => [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out: LiveCheck[] = [];
  const used = new Set<string>();
  const usedConvs = new Set<string>();
  for (const [rule, hits] of [...ranked(fails), ...ranked(borderline)]) {
    if (out.length >= max) break;
    if (used.has(rule)) continue;
    used.add(rule);
    const first = hits.find((h) => !usedConvs.has(h.conv.plan.key)) ?? hits[0]!;
    usedConvs.add(first.conv.plan.key);
    const kind = first.check.pass ? "borderline" : `failed ${hits.length}x`;
    out.push({
      rule,
      suggestion: `Text ZOH like "${first.conv.plan.title}" and check: ${label.get(rule) ?? rule}.`,
      evidence: `${kind} in the sim; e.g. ${first.conv.plan.key}: ${first.check.reason}`,
    });
  }
  return out;
}

// ---- Rendering ----

export function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

function tallyRow(name: string, t: Tally): string {
  return `| ${name} | ${pct(t.rate)} | ${t.pass}/${t.total} | ${t.borderline} |`;
}

function change(c: RuleChange): string {
  if (c.before === null) return `${c.name}: new (${pct(c.after)})`;
  if (c.after === null) return `${c.name}: not scored this run (was ${pct(c.before)})`;
  const arrow = c.after > c.before ? "▲" : c.after < c.before ? "▼" : "=";
  return `${c.name}: ${pct(c.before)} → ${pct(c.after)} ${arrow}`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function points(x: number): string {
  return `${Math.round(x * 100)}`;
}

function scoreCell(s: GroupScore): string {
  return s.rate === null ? "n/a" : `${pct(s.rate)}${s.margin === null ? "" : ` ±${points(s.margin)}`}`;
}

/** The group table (#197): one row per group that applied. */
export function groupTable(groups: Record<Group, GroupScore>): string[] {
  const out = ["| Group | Score | Cases passing every run |", "| --- | --- | --- |"];
  for (const g of GROUPS) {
    const s = groups[g];
    if (s.cases === 0) continue;
    out.push(`| ${GROUP_LABELS[g]}${DECIDING.includes(g) ? "" : " (shown, doesn't decide)"} | ${scoreCell(s)} | ${s.everyRun}/${s.cases} |`);
  }
  return out;
}

function changeLine(c: GroupChange): string {
  const name = GROUP_LABELS[c.group];
  const style = DECIDING.includes(c.group) ? "" : " Style doesn't decide.";
  const moved = c.diff === null ? "" : `${c.diff >= 0 ? "+" : "−"}${points(Math.abs(c.diff))} points${c.margin === null ? "" : `, ±${points(c.margin)}`}`;
  const span = `${pct(c.before)} → ${pct(c.after)} on the same ${c.cases === 1 ? "case" : `${c.cases} cases`} (${moved})`;
  if (c.verdict === "worse") return `${style ? "" : "⚠ "}**${name} got worse beyond noise:** ${span}.${style}`;
  if (c.verdict === "better") return `**${name} got better beyond noise:** ${span}.${style}`;
  return `${name}: ${span}, within noise.${style}`;
}

/** The comparison in plain words, for the report and the console (#197). */
export function comparisonLines(cmp: NonNullable<ReportData["comparison"]>, label: (id: string) => string = (id) => id): string[] {
  const { main } = cmp;
  const worse = main.groups.filter((g) => g.verdict === "worse" && DECIDING.includes(g.group));
  const problems = worse.length + main.drops.length;
  const out = [
    problems === 0
      ? "**Nothing got worse beyond noise.**"
      : `⚠ **${problems} thing${problems === 1 ? "" : "s"} got worse beyond noise** (${[worse.length ? `${worse.length} group${worse.length === 1 ? "" : "s"}` : "", main.drops.length ? `${main.drops.length} regression case${main.drops.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")}): read those transcripts before deciding.`,
    "",
  ];
  for (const g of main.groups) if (g.cases > 0) out.push(`- ${changeLine(g)}`);
  if (main.groups.every((g) => g.cases === 0)) out.push("- No case here has a baseline yet, so nothing was compared.");
  out.push("");
  if (main.drops.length) {
    out.push("Regression cases that got worse beyond noise:");
    for (const d of main.drops) {
      out.push(`- ⚠ \`${d.id}\` (${d.title}): ${GROUP_LABELS[d.group]} passed ${d.before.passes}/${d.before.runs} runs before, ${d.after.passes}/${d.after.runs} now${d.after.failed.length ? `; failed ${d.after.failed.map(label).join(", ")}` : ""}.`);
    }
  } else out.push("No regression case got worse beyond noise.");
  if (main.ready.length) {
    out.push("", `Ready to graduate (capability cases that passed every run in the baseline and again now): ${main.ready.map((id) => `\`${id}\``).join(", ")}. Set \`"suite": "regression"\` in their case files.`);
  }
  if (main.unmatched.length) out.push("", `No baseline yet, so not compared: ${main.unmatched.map((id) => `\`${id}\``).join(", ")}.`);
  if (cmp.rescripted.length) out.push("", `Their script changed since the baseline, so they count as new: ${cmp.rescripted.map((id) => `\`${id}\``).join(", ")}.`);
  if (cmp.replays && cmp.replays.groups.some((g) => g.cases > 0)) {
    out.push("", "Real replays (reported apart, never tuned against):");
    for (const g of cmp.replays.groups) if (g.cases > 0) out.push(`- ${changeLine(g)}`);
  }
  return out;
}

export function renderMarkdown(r: ReportData): string {
  const lines: string[] = [];
  const label = new Map(r.rubric.map((x) => [x.id, x.label]));
  lines.push(`# Coach judgment: ${r.feature}`, "");
  if (r.regradedFrom) lines.push(`Re-graded from ${r.regradedFrom} with the current checks; no conversation was run again.`, "");
  if (r.groups) {
    lines.push(
      "## Scores by group",
      "",
      "A conversation passes a group only if every check in it passed. Each case's runs are averaged first; ± is the 95% margin across cases.",
      "",
      ...groupTable(r.groups),
      "",
    );
    if (r.replayGroups && GROUPS.some((g) => r.replayGroups![g].cases > 0)) lines.push("Real replays, apart (never tuned against):", "", ...groupTable(r.replayGroups), "");
  }
  if (r.comparison) lines.push("## Compared with the baseline", "", ...comparisonLines(r.comparison, (id) => `\`${id}\``), "");
  lines.push(
    `Run ${r.startedAt} → ${r.finishedAt}. Coach model \`${r.models.coach}\`, simulator \`${r.models.sim ?? r.models.eval}\`, grader \`${r.models.eval}\`.${r.costUsd !== undefined ? ` Cost about $${r.costUsd.toFixed(2)}.` : ""}`,
    `${r.conversations.length} conversations (runs per scenario: ${r.options.runs}, turn cap: ${r.options.maxTurns}${r.options.persona ? `, persona: ${r.options.persona}` : ""}${r.options.cases?.length ? `, cases: ${r.options.cases.join(", ")}` : ""}). Tokens used by the simulator and grader: ${r.usage.input.toLocaleString("en-US")} in, ${r.usage.output.toLocaleString("en-US")} out.`,
    "",
    `**Overall: ${pct(r.summary.overall.rate)}** of checks passed (${r.summary.overall.pass}/${r.summary.overall.total}, ${r.summary.overall.borderline} borderline).`,
    "",
  );

  lines.push("## Pass rate per rule", "", "| Rule | Pass rate | Passed | Borderline |", "| --- | --- | --- | --- |");
  for (const rule of r.rubric) {
    const t = r.summary.rules[rule.id];
    if (t) lines.push(tallyRow(`\`${rule.id}\` ${rule.label}`, t));
  }
  const unscored = r.rubric.filter((x) => !r.summary.rules[x.id]).map((x) => `\`${x.id}\``);
  if (unscored.length) lines.push("", `Not scored this run (never applied): ${unscored.join(", ")}.`);

  lines.push("", "## Pass rate per persona", "", "| Persona | Pass rate | Passed | Borderline |", "| --- | --- | --- | --- |");
  for (const [name, t] of Object.entries(r.summary.personas).sort()) lines.push(tallyRow(name, t));

  lines.push("", "## Three worst replies", "");
  if (r.worst.length === 0) lines.push("No ZOH text failed a rule.");
  for (const [i, w] of r.worst.entries()) {
    lines.push(`### ${i + 1}. ${w.title} (ZOH text ${w.zohText}, ${w.persona})`, "");
    if (w.after) lines.push(`Tester: “${w.after}”`, "");
    lines.push(quote(w.text), "");
    for (const c of w.failed) lines.push(`- ✗ \`${c.rule}\`: ${c.reason}`);
    lines.push("");
  }

  lines.push("## Changed since the previous run", "");
  if (!r.diff) lines.push("No previous run of this feature to compare with.");
  else {
    lines.push(`Compared with ${r.diff.previousRun}.`, "", `- ${change(r.diff.overall)}`);
    const section = (title: string, items: RuleChange[]) => {
      lines.push(`- ${title}: ${items.length ? "" : "no change of 5 points or more"}`);
      for (const c of items) lines.push(`  - ${change(c)}`);
    };
    section("Rules", r.diff.rules);
    section("Personas", r.diff.personas);
    section("Conversations", r.diff.conversations);
  }

  lines.push("", "## Suggested live checks for Yanni", "");
  if (r.liveChecks.length === 0) lines.push("Nothing failed or was borderline; try the page's live checklist as usual.");
  for (const [i, c] of r.liveChecks.entries()) lines.push(`${i + 1}. ${c.suggestion}`, `   (${c.evidence})`);

  lines.push("", "## Conversations", "");
  for (const conv of r.conversations) {
    const t = r.summary.conversations[conv.plan.key];
    lines.push(`### ${conv.plan.title}`, "");
    lines.push(
      `\`${conv.plan.key}\` · ${conv.plan.kind} · persona ${conv.plan.persona} · area code ${conv.plan.areaCode} · starts ${conv.plan.startTime} ${conv.plan.timeZone} · ended by ${conv.endedBy} · pass rate ${pct(t?.rate ?? null)}`,
      "",
    );
    if (conv.error) lines.push(`**Run error:** ${conv.error}`, "");
    if (conv.gradeError) lines.push(`**Not graded:** ${conv.gradeError}`, "");
    if (conv.appErrors.length) lines.push(`**App errors:** ${conv.appErrors.join("; ")}`, "");
    if (conv.grade) lines.push(`Grader: ${conv.grade.summary}`, "");
    lines.push("<details><summary>Transcript and checks</summary>", "");
    let n = 0;
    for (const l of conv.transcript) {
      if (l.from === "tester") lines.push(`**Tester:** ${l.text}`, "");
      else if (l.from === "founder") lines.push(`**Founder (console):** ${l.text}`, "");
      else {
        n += 1;
        lines.push(`**ZOH ${n}${l.console ? " (console)" : ""}:** ${l.text.replace(/\n/g, "  \n")}`, "");
        const checks = conv.grade?.texts.find((x) => x.zohText === n)?.checks ?? [];
        const bad = checks.filter((c) => !c.pass || c.borderline);
        for (const c of bad) lines.push(`- ${c.pass ? "~" : "✗"} \`${c.rule}\`: ${c.reason}`);
        if (bad.length) lines.push("");
      }
    }
    for (const c of conv.grade?.conversation ?? []) {
      lines.push(`- ${c.pass ? (c.borderline ? "~" : "✓") : "✗"} \`${c.rule}\` (${label.get(c.rule) ?? c.rule}): ${c.reason}`);
    }
    lines.push("", "</details>", "");
    if (conv.memory) lines.push("Memory after the overnight pass:", "", "```", conv.memory, "```", "");
    lines.push("Saved state:", "");
    const tables = Object.keys(conv.savedState);
    if (tables.length === 0) lines.push(`Nothing saved for this tester besides the ${conv.messageCount} messages.`);
    else lines.push("```json", JSON.stringify(conv.savedState, null, 2), "```");
    lines.push("");
  }
  return lines.join("\n");
}

/** A few lines for the console. */
export function summaryLines(r: ReportData, files: { md: string; json: string }): string[] {
  const out = [
    "",
    `Coach judgment: ${r.feature}, ${r.conversations.length} conversations`,
    `Overall: ${pct(r.summary.overall.rate)} (${r.summary.overall.pass}/${r.summary.overall.total} checks)`,
    "Per persona: " +
      Object.entries(r.summary.personas)
        .sort()
        .map(([p, t]) => `${p} ${pct(t.rate)}`)
        .join(", "),
  ];
  if (r.groups) {
    out.push(
      "By group: " +
        GROUPS.filter((g) => r.groups![g].cases > 0)
          .map((g) => `${GROUP_LABELS[g].toLowerCase()} ${scoreCell(r.groups![g])}`)
          .join(", "),
    );
  }
  if (r.comparison) out.push("", ...comparisonLines(r.comparison).filter((l) => l !== "").map((l) => l.replace(/\*\*/g, "")), "");
  const weakest = Object.entries(r.summary.rules)
    .sort((a, b) => (a[1].rate ?? 1) - (b[1].rate ?? 1))
    .slice(0, 5)
    .map(([id, t]) => `${id} ${pct(t.rate)}`);
  if (weakest.length) out.push(`Weakest rules: ${weakest.join(", ")}`);
  if (r.diff) out.push(`Since last run: overall ${pct(r.diff.overall.before)} → ${pct(r.diff.overall.after)}`);
  const problems = r.conversations.filter((c) => c.error || c.gradeError).length;
  if (problems) out.push(`${problems} conversation(s) hit an error; see the report.`);
  out.push(`Report: ${files.md}`, `        ${files.json}`);
  return out;
}
