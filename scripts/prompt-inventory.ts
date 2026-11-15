/**
 * #196: the inventory of every string ZOH (the coach model) reads, and where each one lives.
 *
 *   npm run inventory            checks docs/prompt-inventory.json against the code and the voice page
 *   npm run inventory -- --write rewrites it, keeping each line's kind and change (review the diff)
 *
 * The scan is exhaustive on purpose: every sentence-like string in the files the coach's words come
 * from is listed, line by line, with what kind it is. Strings ZOH never reads (texts the app sends
 * itself, founder alerts) are listed as such, so a new instruction can't slip in unlisted. Logs and
 * thrown errors are skipped: they never reach the model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSync } from "rolldown/experimental";
import { voiceForCoach } from "../src/coach/voice.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const INVENTORY_PATH = `${ROOT}docs/prompt-inventory.json`;

/** The code files ZOH's words come from. */
export const SCANNED_FILES = [
  "src/coach/prompt.ts",
  "src/coach/coach.ts",
  "src/coach/tools.ts",
  "src/coach/state.ts",
  "src/coach/next-steps.ts",
  "src/coach/week.ts",
  "src/memory/coach-tools.ts",
  "src/memory/context.ts",
  "src/memory/render.ts",
  "src/pipeline/inbound.ts",
] as const;

export const VOICE_PAGE = "docs/coach-voice.md";

export interface Found {
  /** One line of the string (a string over several lines is listed line by line). */
  text: string;
  file: string;
  /** The enclosing declaration, function and property, or the page's heading. */
  where: string;
}

// The parser's AST is plain JSON-like objects; a loose node type keeps the walk short.
type Node = { type: string; start: number; end: number; [key: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && typeof (v as Node).type === "string";

/** A string a person or model could read: has a space, or reads as a sentence ("Saved."). */
const sentenceLike = (s: string) => /\s/.test(s.trim()) || /^[A-Z][\s\S]*[.!?:]$/.test(s);

function nameOf(n: Node | undefined, src: string): string | undefined {
  if (!n) return undefined;
  if (n.type === "Identifier") return n.name as string;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  return src.slice(n.start, n.end);
}

/** Calls whose strings never reach the model: logs, errors and patterns. */
function isSilentCall(n: Node, src: string): boolean {
  if (n.type === "NewExpression") return /Error$|^RegExp$/.test(nameOf(n.callee as Node, src) ?? "");
  if (n.type !== "CallExpression") return false;
  const callee = src.slice((n.callee as Node).start, (n.callee as Node).end);
  return /(^|\.)(log|logger|console)\.\w+$/.test(callee);
}

/** Type-level nodes hold no runtime strings; `as const`, `satisfies` and `!` wrap real values, so they're walked. */
const VALUE_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression"]);
const isTypeOnly = (n: Node) => n.type.startsWith("TS") && !VALUE_WRAPPERS.has(n.type);

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && sentenceLike(l.replace(/\$\{[^}]*\}/g, "x")));

/** Every sentence-like string literal and template in one TypeScript file, line by line. */
export function extractFromCode(file: string, src: string): Found[] {
  const parsed = parseSync(file, src, { lang: "ts" });
  if (parsed.errors.length) throw new Error(`Can't parse ${file}: ${parsed.errors[0]!.message}`);
  const found: Found[] = [];
  const add = (text: string, where: string[]) => {
    for (const line of lines(text)) found.push({ text: line, file, where: where.join(" > ") || "(top)" });
  };
  const walk = (n: Node, path: string[], parentKey: string, parent: Node | undefined) => {
    if (isSilentCall(n, src) || n.type === "TaggedTemplateExpression" || isTypeOnly(n) || n.type === "ImportDeclaration") return;
    if ((n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source) return;
    let here = path;
    if (n.type === "FunctionDeclaration" || n.type === "VariableDeclarator" || n.type === "MethodDefinition") {
      const id = nameOf((n.id ?? n.key) as Node | undefined, src);
      if (id) here = [...path, id];
    }
    if (n.type === "Property" && !n.computed && (n.value as Node | undefined)?.type !== "ObjectExpression") {
      const k = nameOf(n.key as Node, src);
      if (k) here = [...path, k];
    }
    if (n.type === "ObjectExpression") {
      // A tool definition (or any object with a name) is labelled by its name.
      const nameProp = (n.properties as Node[]).find((p) => p.type === "Property" && nameOf(p.key as Node, src) === "name");
      const value = nameProp?.value as Node | undefined;
      if (value?.type === "Literal" && typeof value.value === "string") here = [...path, value.value];
    }
    const isKey = parent?.type === "Property" && parentKey === "key" && !parent.computed;
    if (n.type === "Literal" && typeof n.value === "string") {
      if (!isKey) add(n.value, here);
      return;
    }
    if (n.type === "TemplateLiteral") {
      const quasis = n.quasis as Node[];
      const exprs = n.expressions as Node[];
      let text = "";
      quasis.forEach((q, i) => {
        const v = q.value as { cooked: string | null; raw: string };
        text += v.cooked ?? v.raw;
        if (exprs[i]) text += `\${${src.slice(exprs[i].start, exprs[i].end).replace(/\s+/g, " ")}}`;
      });
      add(text, here);
      for (const e of exprs) walk(e, here, "expression", n);
      return;
    }
    for (const [k, value] of Object.entries(n)) {
      if (Array.isArray(value)) for (const v of value) isNode(v) && walk(v, here, k, n);
      else if (isNode(value)) walk(value, here, k, n);
    }
  };
  walk(parsed.program as unknown as Node, [], "", undefined);
  return found;
}

/**
 * The voice page as the coach reads it (people-only parts left out), line by line under its heading.
 * A rule section's lines are marked with its key; its marked heading isn't read by the coach, so it isn't listed.
 */
export function extractFromPage(file: string, markdown: string): Found[] {
  const found: Found[] = [];
  let heading = "(top)";
  for (const line of voiceForCoach(markdown).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const h = /^#+\s+(.*?)(\s*<!-- rules: (\w+) -->)?$/.exec(t);
    if (h) heading = h[3] ? `${h[1]} (rules: ${h[3]})` : h[1]!;
    if (h?.[3]) continue;
    found.push({ text: t, file, where: heading });
  }
  return found;
}

export interface Entry extends Found {
  /** What it is (see KINDS). */
  kind: string;
  /** What #196 did with it: "unchanged", "moved from …", "merged: …" or "new". */
  change: string;
}

export interface Inventory {
  about: string;
  /** What each kind means. */
  kinds: Record<string, string>;
  entries: Entry[];
  /** Lines taken out because another line already said the same thing, and where that line is. */
  merged: { removed: string; from: string; keptIn: string; why: string }[];
}

export const KINDS: Record<string, string> = {
  voice: "the voice page, read word for word after onboarding",
  rule: "a rule section (the rules the voice page doesn't cover), read after onboarding and, for some, during onboarding",
  "onboarding prompt": "the condensed voice, onboarding rules and examples, read only during onboarding",
  frame: "the lines that open and join the fixed instructions",
  "status sheet": "the state block, rebuilt for every call",
  "tool description": "what each tool is for and what its inputs mean",
  "tool result": "what a tool tells the coach after it runs",
  "tool error": "what a tool tells the coach when it refuses",
  "coach note": "notes the app adds to the conversation (a dropped draft, text not sent, the nudge note, progress)",
  "media note": "what a photo, voice note, document or video becomes in the conversation",
  "memory block": "the memory block's headers and lines, after the plan is locked",
  "not read by ZOH": "texts the app sends itself and founder alerts: listed so nothing is missed",
};

const RULE_CONSTANTS = ["TOOL_RULES", "PLAN_AGREEMENT", "NUDGES", "TODAYS_STEP", "PROOF", "WEEK_LOOKBACK", "NEXT_STEPS", "TEAM", "MEMORY"];

/** The kind a line has from where it lives; `override` is for the few the rules can't tell. */
export function kindOf(f: Found): string {
  const [top = "", ...rest] = f.where.split(" > ");
  const last = rest.at(-1) ?? top;
  if (f.file === VOICE_PAGE) return /\(rules: \w+\)$/.test(f.where) ? "rule" : "voice";
  switch (f.file) {
    case "src/coach/prompt.ts":
      if (RULE_CONSTANTS.includes(top)) return "rule";
      if (["CORE_VOICE", "ONBOARDING", "EXAMPLES"].includes(top)) return "onboarding prompt";
      if (["FULL_VOICE_INTRO", "fullVoiceInstructions", "onboardingInstructions"].includes(top)) return "frame";
      return "status sheet";
    case "src/coach/coach.ts":
      // The trail of tool outcomes goes into an error message if no text comes back.
      if (last === "error") return "tool error";
      return f.text.includes("no blocks") ? "not read by ZOH" : "coach note";
    case "src/coach/tools.ts":
    case "src/memory/coach-tools.ts":
      if (/^alert/.test(top)) return "not read by ZOH";
      if (/DEFINITIONS$|^planProperties$|^schemas$/.test(top)) return "tool description";
      if (last === "error") return "tool error";
      return "tool result";
    case "src/memory/context.ts":
    case "src/memory/render.ts":
      return "memory block";
    case "src/pipeline/inbound.ts":
      // describeMedia's line is kept as the file's description, which later media notes show.
      if (["toTurns", "documentLine", "videoLine"].includes(top) || (top === "describeMedia" && f.text.startsWith("A video"))) return "media note";
      return "not read by ZOH";
    default:
      return "status sheet";
  }
}

const key = (f: Found) => `${f.file}\u0000${f.where}\u0000${f.text}`;

/** Every line found now, from the code and the page. */
export function scan(read: (path: string) => string = (p) => readFileSync(`${ROOT}${p}`, "utf8")): Found[] {
  return [...SCANNED_FILES.flatMap((f) => extractFromCode(f, read(f))), ...extractFromPage(VOICE_PAGE, read(VOICE_PAGE))];
}

/** What's found but not listed, and what's listed but gone. Duplicates count: each copy is its own line. */
export function compare(found: Found[], inventory: Inventory): { missing: Found[]; stale: Entry[] } {
  const listed = new Map<string, number>();
  for (const e of inventory.entries) listed.set(key(e), (listed.get(key(e)) ?? 0) + 1);
  const missing: Found[] = [];
  for (const f of found) {
    const n = listed.get(key(f)) ?? 0;
    if (n > 0) listed.set(key(f), n - 1);
    else missing.push(f);
  }
  const left = new Map(listed);
  const stale = inventory.entries.filter((e) => {
    const n = left.get(key(e)) ?? 0;
    if (n > 0) left.set(key(e), n - 1);
    return n > 0;
  });
  return { missing, stale };
}

/**
 * The inventory rebuilt from what's found: a line already listed keeps its change; a line listed
 * elsewhere with the same text is marked moved from there; anything else is new.
 */
export function rebuild(found: Found[], old: Inventory | undefined): Inventory {
  const byKey = new Map<string, Entry[]>();
  const byText = new Map<string, Entry[]>();
  for (const e of old?.entries ?? []) {
    (byKey.get(key(e)) ?? byKey.set(key(e), []).get(key(e))!).push(e);
    (byText.get(e.text) ?? byText.set(e.text, []).get(e.text)!).push(e);
  }
  const entries = found.map((f): Entry => {
    const same = byKey.get(key(f))?.shift();
    if (same) return { ...f, kind: kindOf(f), change: same.change };
    const moved = byText.get(f.text)?.find((e) => e.file !== f.file || e.where !== f.where);
    if (moved) return { ...f, kind: kindOf(f), change: `moved from ${moved.file} (${moved.where})` };
    return { ...f, kind: kindOf(f), change: old ? "new" : "unchanged" };
  });
  return {
    about:
      "#196: every line ZOH (the coach model) reads, where it lives and what #196 did with it. Checked by test/prompt-inventory.test.ts; rebuild with `npm run inventory -- --write` and review the diff.",
    kinds: KINDS,
    entries,
    merged: old?.merged ?? [],
  };
}

export function readInventory(): Inventory {
  return JSON.parse(readFileSync(INVENTORY_PATH, "utf8")) as Inventory;
}

function readOrNone(): Inventory | undefined {
  try {
    return readInventory();
  } catch {
    return undefined;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const found = scan();
  if (process.argv.includes("--write")) {
    const inv = rebuild(found, readOrNone());
    writeFileSync(INVENTORY_PATH, `${JSON.stringify(inv, null, 1)}\n`);
    const counts: Record<string, number> = {};
    for (const e of inv.entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    console.log(`${inv.entries.length} lines written to docs/prompt-inventory.json`, counts);
  } else {
    const inv = readOrNone();
    if (!inv) {
      console.error("No docs/prompt-inventory.json yet: run with --write.");
      process.exit(1);
    }
    const { missing, stale } = compare(found, inv);
    for (const m of missing) console.log(`not listed: ${m.file} (${m.where}): ${m.text}`);
    for (const s of stale) console.log(`listed but gone: ${s.file} (${s.where}): ${s.text}`);
    if (missing.length || stale.length) process.exit(1);
    console.log(`All ${found.length} lines are listed.`);
  }
}
