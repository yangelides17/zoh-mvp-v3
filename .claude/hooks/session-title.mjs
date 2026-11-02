#!/usr/bin/env node
// Names the Claude Code session after the flow command typed into it, e.g. "/build 80 90 120" → "build 80 90 120",
// so each terminal running a spec, plan, build or review is easy to tell apart. Wired up as a UserPromptSubmit
// hook in .claude/settings.json. Any other prompt leaves the name as it is. It never blocks a prompt.

const COMMANDS = ["spec", "plan", "build", "review"];
const MAX_CHARS = 60;

/** The session title for a prompt, or null when it isn't one of the flow commands. */
export function titleFor(prompt) {
  const match = /^\s*\/(\w+)(?:\s+([\s\S]*))?$/.exec(prompt ?? "");
  if (!match || !COMMANDS.includes(match[1])) return null;
  const title = `${match[1]} ${(match[2] ?? "").replace(/\s+/g, " ").trim()}`.trim();
  return title.length > MAX_CHARS ? `${title.slice(0, MAX_CHARS - 1).trimEnd()}…` : title;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let prompt = "";
  try {
    prompt = JSON.parse(input).prompt ?? "";
  } catch {
    return;
  }
  const title = titleFor(prompt);
  if (title) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title } }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
