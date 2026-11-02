import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The hook that names each Claude Code session after the flow command typed into it (.claude/settings.json).
const HOOK = fileURLToPath(new URL("../.claude/hooks/session-title.mjs", import.meta.url));

function run(prompt: string): string {
  return execFileSync("node", [HOOK], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }) }).toString();
}

function title(prompt: string): string | undefined {
  const out = run(prompt);
  return out ? (JSON.parse(out) as { hookSpecificOutput: { sessionTitle: string } }).hookSpecificOutput.sessionTitle : undefined;
}

describe("session title hook", () => {
  it("names the session after the command and the issues it was run on", () => {
    expect(title("/build 80 90 120")).toBe("build 80 90 120");
    expect(title("/review 108 109")).toBe("review 108 109");
    expect(title("/plan  41\n42 ")).toBe("plan 41 42");
    expect(title("/spec")).toBe("spec");
  });

  it("keeps a long spec description short", () => {
    const t = title(`/spec ${"a nudge when they go quiet ".repeat(5)}`)!;
    expect(t.startsWith("spec a nudge when they go quiet")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(60);
  });

  it("leaves the name alone for anything else", () => {
    expect(run("merge")).toBe("");
    expect(run("/status")).toBe("");
    expect(run("/release")).toBe("");
    expect(run("please /build 12")).toBe("");
  });

  it("never fails on input it doesn't understand", () => {
    expect(execFileSync("node", [HOOK], { input: "not json" }).toString()).toBe("");
  });
});
