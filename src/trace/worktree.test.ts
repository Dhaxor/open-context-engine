import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { WorktreeManager, branchNameFor } from "./worktree";

const run = promisify(execFile);

let gitAvailable = true;
beforeAll(async () => {
  try { await run("git", ["--version"]); } catch { gitAvailable = false; }
});

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A real repository with one commit — worktrees need a HEAD to branch from. */
async function repo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-repo-"));
  created.push(dir);
  await run("git", ["init"], { cwd: dir });
  // git 2.25 has no `init -b`, so the default branch is set explicitly.
  await run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

function manager(repoRoot: string): WorktreeManager {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trace-wt-"));
  created.push(base);
  return new WorktreeManager({ repoRoot, baseDir: base });
}

describe("branchNameFor", () => {
  it("turns a session title into a safe branch name", () => {
    expect(branchNameFor("Why does search degrade?")).toBe("trace/why-does-search-degrade");
    expect(branchNameFor("  Fix   the AUTH flow  ")).toBe("trace/fix-the-auth-flow");
  });

  it("never produces an empty name", () => {
    expect(branchNameFor("???")).toBe("trace/session");
    expect(branchNameFor("")).toBe("trace/session");
  });

  it("avoids collisions with existing branches", () => {
    expect(branchNameFor("fix", ["trace/fix"])).toBe("trace/fix-2");
    expect(branchNameFor("fix", ["trace/fix", "trace/fix-2"])).toBe("trace/fix-3");
  });

  it("bounds the length", () => {
    expect(branchNameFor("x".repeat(200)).length).toBeLessThanOrEqual(46);
  });
});

describe("WorktreeManager", () => {
  it("reports a plain directory as not a repository", async () => {
    if (!gitAvailable) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-plain-"));
    created.push(dir);
    // Not being a git repo is normal — it just means one session, not an error.
    expect(await manager(dir).isRepo()).toBe(false);
  });

  it("recognises a repository and lists its main worktree", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    expect(await wt.isRepo()).toBe(true);

    const list = await wt.list();
    expect(list).toHaveLength(1);
    expect(list[0].main).toBe(true);
    expect(list[0].branch).toBe("main");
    expect(fs.existsSync(list[0].path)).toBe(true);
  });

  it("creates a worktree on a new branch", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);

    const result = await wt.create("trace/fix-auth");
    expect(result.ok).toBe(true);
    expect(result.worktree!.branch).toBe("trace/fix-auth");
    // A real, separate checkout — that is the whole point.
    expect(fs.existsSync(path.join(result.worktree!.path, "a.ts"))).toBe(true);

    const list = await wt.list();
    expect(list.map(w => w.branch).sort()).toEqual(["main", "trace/fix-auth"]);
    expect(list.find(w => w.branch === "trace/fix-auth")!.main).toBe(false);
  });

  it("isolates edits between worktrees", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    const { worktree } = await wt.create("trace/parallel");

    fs.writeFileSync(path.join(worktree!.path, "a.ts"), "export const a = 999;\n");
    // Two agents editing one checkout is a race with no winner; this is why.
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain("= 1");
    expect(await wt.changedFiles(worktree!.path)).toEqual(["a.ts"]);
    expect(await wt.changedFiles(root)).toEqual([]);
  });

  it("reuses an existing worktree instead of failing", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    const first = await wt.create("trace/again");
    const second = await wt.create("trace/again");
    // Reconnecting to a session must not error because its checkout exists.
    expect(second.ok).toBe(true);
    expect(second.worktree!.path).toBe(first.worktree!.path);
    expect(await wt.list()).toHaveLength(2);
  });

  it("returns an error rather than throwing on a bad branch name", async () => {
    if (!gitAvailable) return;
    const wt = manager(await repo());
    const result = await wt.create("not a valid ref..");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("removes a clean worktree and its branch", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    const { worktree } = await wt.create("trace/temp");

    const result = await wt.remove(worktree!.path, { deleteBranch: "trace/temp" });
    expect(result.ok).toBe(true);
    expect(await wt.list()).toHaveLength(1);
    const { stdout } = await run("git", ["branch", "--list", "trace/temp"], { cwd: root });
    expect(stdout.trim()).toBe("");
  });

  it("refuses to remove a worktree with uncommitted work unless forced", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    const { worktree } = await wt.create("trace/dirty");
    fs.writeFileSync(path.join(worktree!.path, "a.ts"), "changed\n");

    // Losing unreviewed edits because a tab was closed would be unforgivable.
    expect((await wt.remove(worktree!.path)).ok).toBe(false);
    expect((await wt.remove(worktree!.path, { force: true })).ok).toBe(true);
  });

  it("reviews a session's uncommitted work", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    const { worktree } = await wt.create("trace/review-me");
    fs.writeFileSync(path.join(worktree!.path, "a.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(worktree!.path, "new.ts"), "export const b = 3;\n");

    const review = await wt.review(worktree!.path);
    // An agent's edits are normally uncommitted; a review that only showed
    // commits would show nothing at all for a typical session.
    expect(review.files).toContain("a.ts");
    expect(review.diff).toContain("export const a = 2;");
    expect(review.stat.added).toBeGreaterThan(0);
    // New files are invisible to `git diff` — they have to be listed separately.
    expect(review.untracked).toEqual(["new.ts"]);
  });

  it("reports an empty review for an untouched session", async () => {
    if (!gitAvailable) return;
    const wt = manager(await repo());
    const { worktree } = await wt.create("trace/idle");
    const review = await wt.review(worktree!.path);
    expect(review.files).toEqual([]);
    expect(review.untracked).toEqual([]);
    expect(review.stat).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it("lands a session's work onto the main branch", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    const { worktree } = await wt.create("trace/feature");
    fs.writeFileSync(path.join(worktree!.path, "a.ts"), "export const a = 42;\n");
    fs.writeFileSync(path.join(worktree!.path, "added.ts"), "export const c = 1;\n");

    const result = await wt.land({
      worktreePath: worktree!.path,
      branch: "trace/feature",
      target: "main",
      message: "Trace session: feature",
    });
    expect(result.ok).toBe(true);
    // The uncommitted work is committed first, or the merge would ignore it.
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain("= 42");
    expect(fs.existsSync(path.join(root, "added.ts"))).toBe(true);
  });

  it("keeps the session visible in history as one unit", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    const { worktree } = await wt.create("trace/unit");
    fs.writeFileSync(path.join(worktree!.path, "a.ts"), "changed\n");
    await wt.land({ worktreePath: worktree!.path, branch: "trace/unit", target: "main", message: "Trace session: unit" });

    const { stdout } = await run("git", ["log", "--merges", "--oneline"], { cwd: root });
    // --no-ff: the session does not dissolve into the target branch.
    expect(stdout).toContain("Trace session: unit");
  });

  it("reports a merge conflict rather than leaving a broken tree silently", async () => {
    if (!gitAvailable) return;
    const root = await repo();
    const wt = manager(root);
    const { worktree } = await wt.create("trace/conflict");
    fs.writeFileSync(path.join(worktree!.path, "a.ts"), "from the session\n");

    // Move main on the same line so the merge cannot fast-forward cleanly.
    fs.writeFileSync(path.join(root, "a.ts"), "from main\n");
    await run("git", ["commit", "-am", "main moves"], { cwd: root });

    const result = await wt.land({ worktreePath: worktree!.path, branch: "trace/conflict", target: "main", message: "m" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("reads the main checkout's branch as a default merge target", async () => {
    if (!gitAvailable) return;
    expect(await manager(await repo()).currentBranch()).toBe("main");
  });

  it("survives git being unavailable", async () => {
    const broken = new WorktreeManager({
      repoRoot: "/nowhere",
      exec: async () => { throw new Error("git: command not found"); },
    });
    expect(await broken.isRepo()).toBe(false);
    expect(await broken.list()).toEqual([]);
    expect(await broken.changedFiles("/nowhere")).toEqual([]);
    expect((await broken.create("trace/x")).ok).toBe(false);
    await expect(broken.prune()).resolves.toBeUndefined();
  });

  it("parses porcelain output including a detached head", async () => {
    const wt = new WorktreeManager({
      repoRoot: "/repo",
      exec: async () => ({
        stdout: [
          "worktree /repo", "HEAD abc123", "branch refs/heads/main", "",
          "worktree /tmp/wt-detached", "HEAD def456", "detached", "",
        ].join("\n"),
        stderr: "",
      }),
    });
    const list = await wt.list();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ path: "/repo", branch: "main", main: true });
    expect(list[1]).toMatchObject({ path: "/tmp/wt-detached", branch: undefined, main: false });
  });
});
