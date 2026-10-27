import type { RubricRule } from "./features.js";
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
  models: { coach: string; eval: string };
  options: { persona?: string; runs: number; maxTurns: number };
  rubric: RubricRule[];
  summary: Summary;
  worst: WorstReply[];
  liveChecks: LiveCheck[];
  diff?: RunDiff;
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
    if (line.from === "tester") lastTester = line.text;
    else out.push({ text: line.text, after: lastTester });
  }
  return out;
}

/**
 * Whether an earlier run is comparable with this one: same persona filter, so a one-persona run
 * isn't compared with the full suite (or the other way round). Run counts may differ.
 */
export function sameScope(previous: Pick<ReportData["options"], "persona">, persona: string | undefined): boolean {
  return (previous.persona ?? undefined) === (persona ?? undefined);
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

export function renderMarkdown(r: ReportData): string {
  const lines: string[] = [];
  const label = new Map(r.rubric.map((x) => [x.id, x.label]));
  lines.push(`# Coach judgment: ${r.feature}`, "");
  lines.push(
    `Run ${r.startedAt} → ${r.finishedAt}. Coach model \`${r.models.coach}\`, simulator and grader \`${r.models.eval}\`.`,
    `${r.conversations.length} conversations (runs per scenario: ${r.options.runs}, turn cap: ${r.options.maxTurns}${r.options.persona ? `, persona: ${r.options.persona}` : ""}). Tokens used by the simulator and grader: ${r.usage.input.toLocaleString("en-US")} in, ${r.usage.output.toLocaleString("en-US")} out.`,
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
      else {
        n += 1;
        lines.push(`**ZOH ${n}:** ${l.text.replace(/\n/g, "  \n")}`, "");
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
