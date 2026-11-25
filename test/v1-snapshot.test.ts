import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEMORY } from "../src/coach/prompt.js";
import { MEMORY_TOOL_DEFINITIONS } from "../src/memory/coach-tools.js";

/**
 * #253: V1 prompt rules and tools must remain byte-for-byte unchanged.
 * If this test fails, something that only v2 testers should see leaked into v1.
 */
describe("v1 snapshot", () => {
  const baseline = JSON.parse(readFileSync(fileURLToPath(new URL("fixtures/v1-prompt-baseline.json", import.meta.url)), "utf8"));

  it("MEMORY rules are unchanged", () => {
    expect(MEMORY).toBe(baseline.memoryRules);
  });

  it("MEMORY_TOOL_DEFINITIONS are unchanged", () => {
    expect(JSON.stringify(MEMORY_TOOL_DEFINITIONS)).toBe(JSON.stringify(baseline.toolDefinitions));
  });
});
