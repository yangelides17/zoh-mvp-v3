import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The PreToolUse hook that blocks editing applied migrations, pushing to main and switching branches in the main
// folder (.claude/settings.json).
const HOOK = fileURLToPath(new URL("../.claude/hooks/guard.mjs", import.meta.url));

function run(input: object): { blocked: boolean; reason: string } {
  const res = spawnSync("node", [HOOK], { input: JSON.stringify(input) });
  return { blocked: res.status === 2, reason: res.stderr.toString() };
}

const bash = (command: string, cwd: string) => run({ tool_name: "Bash", tool_input: { command }, cwd });
const edit = (file_path: string, cwd: string) => run({ tool_name: "Edit", tool_input: { file_path }, cwd });

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe("guard hook: migrations", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-mig-"));
  mkdirSync(join(dir, "drizzle", "meta"), { recursive: true });
  writeFileSync(join(dir, "drizzle", "0000_init.sql"), "create table x ();");
  writeFileSync(join(dir, "drizzle", "meta", "0000_snapshot.json"), "{}");

  it("blocks editing an applied migration or its snapshot", () => {
    expect(edit(join(dir, "drizzle", "0000_init.sql"), dir).blocked).toBe(true);
    expect(edit("drizzle/meta/0000_snapshot.json", dir).blocked).toBe(true);
    expect(run({ tool_name: "Write", tool_input: { file_path: "drizzle/0000_init.sql" }, cwd: dir }).reason).toContain(
      "npm run db:generate",
    );
  });

  it("lets other edits through, including a new file in drizzle/", () => {
    expect(edit("drizzle/0001_new.sql", dir).blocked).toBe(false);
    expect(edit(join(dir, "src", "db", "schema.ts"), dir).blocked).toBe(false);
  });
});

describe.skipIf(!hasGit)("guard hook: git", () => {
  let main = "";
  let worktree = "";

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "guard-git-"));
    main = join(root, "repo");
    worktree = join(root, "wt");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    mkdirSync(main);
    git(main, "init", "-q", "-b", "dev");
    git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "branch", "main");
    git(main, "worktree", "add", "-q", worktree, "-b", "feature/1-x");
    writeFileSync(join(main, "a.ts"), "");
  });

  it("blocks pushing to main", () => {
    expect(bash("git push origin main", main).blocked).toBe(true);
    expect(bash("git push -u origin HEAD:main", worktree).blocked).toBe(true);
    expect(bash("git fetch origin && git push origin +refs/heads/main", main).blocked).toBe(true);
  });

  it("allows the pushes the flow makes", () => {
    expect(bash("git push origin dev", main).blocked).toBe(false);
    expect(bash("git push origin origin/main:dev", main).blocked).toBe(false);
    expect(bash("git push origin v0.4.0", main).blocked).toBe(false);
    expect(bash("git push --force-with-lease", worktree).blocked).toBe(false);
  });

  it("blocks switching branches in the main folder", () => {
    expect(bash("git switch feature/1-x", main).blocked).toBe(true);
    expect(bash("git checkout main", main).blocked).toBe(true);
    expect(bash("git checkout -b feature/2-y origin/dev", main).blocked).toBe(true);
    expect(bash(`cd ${main} && git switch -c hotfix/z`, worktree).blocked).toBe(true);
    expect(bash(`git -C ${main} checkout main`, worktree).blocked).toBe(true);
  });

  it("allows switching in a worktree, restoring files, and staying on dev", () => {
    expect(bash("git switch -c feature/3-z origin/dev", worktree).blocked).toBe(false);
    expect(bash("git checkout -- a.ts", main).blocked).toBe(false);
    expect(bash("git checkout a.ts", main).blocked).toBe(false);
    expect(bash("git checkout .", main).blocked).toBe(false);
    expect(bash("git switch dev", main).blocked).toBe(false);
    expect(bash("git worktree add ../zoh-worktrees/4-w -b feature/4-w origin/dev", main).blocked).toBe(false);
  });

  it("ignores other tools and commands", () => {
    expect(bash("npm run check", main).blocked).toBe(false);
    expect(run({ tool_name: "Read", tool_input: { file_path: "drizzle/0000_init.sql" }, cwd: main }).blocked).toBe(false);
  });
});
