import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compare, droppedSheetLines, extractFromCode, extractFromPage, kindOf, readInventory, rebuild, scan, SORTS } from "../scripts/prompt-inventory.js";
import { FIXED_INSTRUCTIONS, fullVoiceInstructions } from "../src/coach/prompt.js";
import { loadVoiceDoc } from "../src/coach/voice.js";

// #196: every line ZOH reads is listed in docs/prompt-inventory.json, and rearranging changed none of them.
describe("the prompt inventory", () => {
  it("lists every line ZOH reads, and nothing that's gone", () => {
    const { missing, stale } = compare(scan(), readInventory());
    // Run `npm run inventory -- --write` and review the diff when this fails.
    expect(missing.map((m) => `${m.file} (${m.where}): ${m.text}`)).toEqual([]);
    expect(stale.map((s) => `${s.file} (${s.where}): ${s.text}`)).toEqual([]);
  });

  it("catches a new tool error, a new status line and a new page line", () => {
    const tools = `${readFileSync("src/coach/tools.ts", "utf8")}\nfunction extra() { return { ok: false, error: "Not now: ask them first." } as const; }\n`;
    const prompt = `${readFileSync("src/coach/prompt.ts", "utf8")}\nfunction more(): string[] { return [\`Their mood: \${"x"}, keep it light.\`]; }\n`;
    const page = `${readFileSync("docs/coach-voice.md", "utf8")}\n- **A brand new rule.** Always do the new thing.\n`;
    const found = scan((p) => (p === "src/coach/tools.ts" ? tools : p === "src/coach/prompt.ts" ? prompt : p === "docs/coach-voice.md" ? page : readFileSync(p, "utf8")));
    const { missing } = compare(found, readInventory());
    expect(missing.map((m) => [m.text, kindOf(m)])).toEqual([
      ["Their mood: ${\"x\"}, keep it light.", "status sheet"],
      ["Not now: ask them first.", "tool error"],
      ["- **A brand new rule.** Always do the new thing.", "voice"],
    ]);
  });

  it("skips logs and thrown errors, and lists a long string line by line", () => {
    const found = extractFromCode(
      "src/coach/coach.ts",
      'log.warn("a log line here"); throw new Error("a thrown error here"); const NOTE = `First line here.\\n\\nSecond line here.`;',
    );
    expect(found.map((f) => f.text)).toEqual(["First line here.", "Second line here."]);
    expect(extractFromPage("docs/coach-voice.md", "# A\n<!-- people only -->\nsecret\n<!-- /people only -->\nseen line")).toEqual([
      { text: "# A", file: "docs/coach-voice.md", where: "A" },
      { text: "seen line", file: "docs/coach-voice.md", where: "A" },
    ]);
  });
});

// #199: judgment over rules. Every rule carries its reason, and the status sheet states facts, never orders.
describe("judgment over rules (#199)", () => {
  const inventory = readInventory();
  const page = loadVoiceDoc();

  it("gives every voice and rule line a reason found on the page, or marks it as not a rule", () => {
    const lines = inventory.entries.filter((e) => e.kind === "voice" || e.kind === "rule");
    expect(lines.length).toBeGreaterThan(200);
    // A new or reworded line starts untagged: look at it, then give it its reason (or rule: false).
    expect(lines.filter((e) => !e.reason && e.rule !== false).map((e) => `${e.where}: ${e.text}`)).toEqual([]);
    // The reason is one the coach reads: a quote from the page as the coach sees it.
    expect(lines.filter((e) => e.reason && !page.includes(e.reason)).map((e) => `${e.where}: ${e.reason}`)).toEqual([]);
  });

  it("carries a line's reason over while its words stay the same, and drops it once they change", () => {
    const line = (text: string) => ({ text, file: "docs/coach-voice.md", where: "How it texts" });
    const old = rebuild([line("- **Short.** One to three sentences.")], undefined);
    old.entries[0]!.reason = "their time";
    expect(rebuild([line("- **Short.** One to three sentences.")], old).entries[0]).toMatchObject({ reason: "their time" });
    expect(rebuild([line("- **Short.** One or two sentences.")], old).entries[0]!.reason).toBeUndefined();
  });

  it("records how every old status sheet line was sorted, and won't drop one without that record", () => {
    // The sorting is recorded once (78 lines when the sheet became facts) and checked against the sheet as it is.
    expect(inventory.resorted.length).toBeGreaterThanOrEqual(78);
    const sheet = new Set(inventory.entries.filter((e) => e.kind === "status sheet").map((e) => e.text));
    for (const r of inventory.resorted) {
      expect(Object.keys(SORTS), r.old).toContain(r.sort);
      expect(r.now.length && r.why.length, r.old).toBeTruthy();
      // Each one is really gone from the sheet in those words.
      expect(sheet.has(r.old), r.old).toBe(false);
    }
    // A sheet line that disappears with no record stops `npm run inventory -- --write`.
    const gone = { text: "Ask them how it went.", file: "src/coach/prompt.ts", where: "x", kind: "status sheet", change: "unchanged" };
    expect(() => rebuild([], { ...inventory, entries: [gone], resorted: [] })).toThrow(/no "resorted" entry/);
    expect(droppedSheetLines([], { ...inventory, entries: [gone] })).toEqual(["Ask them how it went."]);
  });

  it("puts no orders on the status sheet: no clause opens with an instruction", () => {
    // Tool routing beside its reference ("yes → change_plan with s:…") is allowed: the spec bans only lines on how to talk.
    const VERBS = "ask|say|don't|never|show|raise|pick|open|answer|bring|tell|use|call|give|make|keep|do|reply|send|mention|push|confirm|save|wrap|turn|work|skip|react|carry|follow|trust|see|remind|let|offer|celebrate|name|write|repeat|stop|avoid|try";
    const order = new RegExp(`(^|[.:;(—]\\s*|\\bthen\\s+)(${VERBS})\\b`, "i");
    // Reviewed: a label that happens to be a verb.
    const ALLOWED = ['Name: ${t.name ?? "not given yet"}'];
    const sheet = inventory.entries.filter((e) => e.kind === "status sheet" && !ALLOWED.includes(e.text));
    expect(sheet.length).toBeGreaterThan(50);
    expect(sheet.filter((e) => order.test(e.text.replace(/\$\{[^}]*\}/g, "x"))).map((e) => `${e.where}: ${e.text}`)).toEqual([]);
    // The old sheet's order words are gone for good.
    for (const e of sheet) expect(e.text).not.toMatch(/THIS TEXT ALSO|\bdon't\b|\bnever again\b|\bsee (NUDGES|PROOF|THE TEAM)\b/);
  });
});

describe("the assembled instructions", () => {
  // Taken on dev before #196; the rearrange matched them byte for byte, and the after-onboarding one now holds
  // #196's merges (its git history shows each). A change to what ZOH reads shows up as a diff here.
  it("are the same as before, during onboarding and after", () => {
    expect(FIXED_INSTRUCTIONS).toBe(readFileSync("test/snapshots/instructions-onboarding.txt", "utf8"));
    expect(fullVoiceInstructions()).toBe(readFileSync("test/snapshots/instructions-after-onboarding.txt", "utf8"));
  });
});
