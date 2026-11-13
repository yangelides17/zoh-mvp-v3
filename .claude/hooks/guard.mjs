#!/usr/bin/env node
// Guards three rules from CLAUDE.md that are expensive to get wrong, before Claude's tool call runs. Wired up as a
// PreToolUse hook in .claude/settings.json. On a match it exits 2 and the reason goes back to Claude; otherwise it
// stays silent and lets the call through.
//   1. Never edit applied migrations (`drizzle/`): change src/db/schema.ts and run npm run db:generate instead.
//   2. Never push straight to `main`: production changes only through a release or hotfix PR.
//   3. Never switch branches in the main folder (it stays on `dev`): work in a worktree under ../zoh-worktrees/.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** Why the tool call breaks a rule, or null when it's fine. */
export function check(input) {
  const tool = input?.tool_name;
  const args = input?.tool_input ?? {};
  const cwd = input?.cwd || process.cwd();
  if (EDIT_TOOLS.includes(tool)) return checkEdit(args.file_path ?? args.notebook_path, cwd);
  if (tool === "Bash" && typeof args.command === "string") return checkBash(args.command, cwd);
  return null;
}

function checkEdit(filePath, cwd) {
  if (typeof filePath !== "string") return null;
  const path = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  if (/(^|[\\/])drizzle[\\/]/.test(path) && existsSync(path)) {
    return "Applied migrations in drizzle/ are never edited (production has already run them). Change " +
      "src/db/schema.ts and run `npm run db:generate` to make a new migration.";
  }
  return null;
}

function checkBash(command, startDir) {
  let dir = startDir;
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
    if (words[0] === "cd" && words[1]) {
      dir = isAbsolute(words[1]) ? words[1] : resolve(dir, words[1]);
      continue;
    }
    const git = gitCall(words, dir);
    if (!git) continue;
    if (git.sub === "push") {
      const why = checkPush(git.rest, git.dir);
      if (why) return why;
    }
    if (git.sub === "switch" || git.sub === "checkout") {
      const why = checkSwitch(git.sub, git.rest, git.dir);
      if (why) return why;
    }
  }
  return null;
}

/** `git [-C dir] [-c k=v] <sub> ...` → the subcommand, its arguments and the folder it runs in. */
function gitCall(words, dir) {
  const at = words.indexOf("git");
  if (at === -1) return null;
  let i = at + 1;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "-C" && words[i + 1]) {
      dir = isAbsolute(words[i + 1]) ? words[i + 1] : resolve(dir, words[i + 1]);
      i += 2;
    } else if (words[i] === "-c") {
      i += 2;
    } else {
      i += 1;
    }
  }
  if (i >= words.length) return null;
  return { sub: words[i], rest: words.slice(i + 1), dir };
}

function checkPush(rest, dir) {
  const positional = rest.filter((w) => !w.startsWith("-"));
  const refspecs = positional.slice(1); // the first is the remote
  const targets = refspecs.length > 0
    ? refspecs.map((r) => (r.includes(":") ? r.slice(r.indexOf(":") + 1) : r))
    : ["HEAD"];
  const toMain = targets
    .map((t) => t.replace(/^\+/, "").replace(/^refs\/heads\//, ""))
    .some((t) => (t === "HEAD" ? currentBranch(dir) : t) === "main");
  if (!toMain) return null;
  return "Never push straight to `main` (production): it changes only through a release (`/release`) or a hotfix " +
    "PR (`/quick`, production), merged with `gh pr merge`.";
}

function checkSwitch(sub, rest, dir) {
  if (!isMainFolder(dir)) return null;
  if (sub === "checkout") {
    // Restoring files (`git checkout -- f`, `git checkout dev -- f`, `git checkout .`) doesn't move the branch.
    if (rest.includes("--") || rest.includes(".")) return null;
    const positional = rest.filter((w) => !w.startsWith("-"));
    if (!rest.some((w) => w.startsWith("-")) && positional.length > 0 && positional.every((p) => existsSync(resolve(dir, p)))) {
      return null;
    }
  }
  const target = rest.filter((w) => !w.startsWith("-"));
  const creates = rest.some((w) => ["-c", "-C", "-b", "-B", "--create", "--orphan", "--detach"].includes(w));
  if (!creates && target.length === 1 && target[0] === currentBranch(dir)) return null;
  return "The main folder stays on `dev` (other sessions build from it). Work in a worktree instead: " +
    "`git worktree add ../zoh-worktrees/<slug> -b <branch> origin/dev`, or read files with `git show origin/dev:<path>`.";
}

function runGit(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function currentBranch(dir) {
  return runGit(dir, ["branch", "--show-current"]);
}

/** The repo's main working tree (not a worktree, where switching is fine). */
function isMainFolder(dir) {
  const out = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (!out) return false;
  const [gitDir, common] = out.split("\n");
  return gitDir === common;
}

function unquote(word) {
  return word.replace(/^["']|["']$/g, "");
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const why = check(input);
  if (why) {
    process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${why}\n`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
