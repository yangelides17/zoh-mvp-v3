import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compare, extractFromCode, extractFromPage, kindOf, readInventory, scan } from "../scripts/prompt-inventory.js";
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

describe("the assembled instructions", () => {
  // Snapshots taken on dev before #196 touched anything. A change to what ZOH reads shows up as a diff here.
  it("are the same as before, during onboarding and after", () => {
    expect(FIXED_INSTRUCTIONS).toBe(readFileSync("test/snapshots/instructions-onboarding.txt", "utf8"));
    expect(fullVoiceInstructions(loadVoiceDoc())).toBe(readFileSync("test/snapshots/instructions-after-onboarding.txt", "utf8"));
  });
});
