/**
 * Git worktrees — the isolation behind parallel sessions.
 *
 * Two agents editing one checkout is a race with no winner: each sees the
 * other's half-finished edits as the current state of the file. A worktree
 * gives each session its own directory and its own branch off the same object
 * store, so they can run at the same time and be reviewed and merged
 * separately.
 *
 * Everything here shells out to git rather than reimplementing it. Failures are
 * returned, never thrown: a workspace that is not a git repository is a normal
 * situation — it just means one session instead of several — and it must not
 * stop the harness starting.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const run = promisify(execFile);

export interface Worktree {
  /** Absolute path of the checkout. */
  path: string;
  branch?: string;
  head?: string;
  /** True for the directory the repository was opened from. */
  main: boolean;
}

export interface WorktreeResult {
  ok: boolean;
  worktree?: Worktree;
  error?: string;
}

export interface WorktreeManagerOptions {
  repoRoot: string;
  /** Where new worktrees are created. Default: <os.tmpdir>/oce-worktrees/<repo>. */
  baseDir?: string;
  /** Injected for tests. */
  exec?: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

/** Branch names are ours to choose, but a session title is not — sanitize it. */
export function branchNameFor(label: string, existing: string[] = []): string {
  const base = "trace/" + (label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session");
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

export class WorktreeManager {
  private exec: NonNullable<WorktreeManagerOptions["exec"]>;

  constructor(private opts: WorktreeManagerOptions) {
    this.exec = opts.exec ?? ((args, cwd) => run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }));
  }

  get baseDir(): string {
    return this.opts.baseDir ?? path.join(os.tmpdir(), "oce-worktrees", path.basename(this.opts.repoRoot));
  }

  /** False for a plain directory — the caller then runs a single session. */
  async isRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.exec(["rev-parse", "--is-inside-work-tree"], this.opts.repoRoot);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Existing worktrees, parsed from `git worktree list --porcelain`. The
   * porcelain form is the stable one; the human-readable columns are not.
   */
  async list(): Promise<Worktree[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec(["worktree", "list", "--porcelain"], this.opts.repoRoot));
    } catch {
      return [];
    }
    const worktrees: Worktree[] = [];
    let current: Partial<Worktree> | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current?.path) worktrees.push(finish(current, worktrees.length === 0));
        current = { path: line.slice("worktree ".length).trim() };
      } else if (line.startsWith("HEAD ")) {
        if (current) current.head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        if (current) current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
    }
    if (current?.path) worktrees.push(finish(current, worktrees.length === 0));
    return worktrees;
  }

  /**
   * Add a worktree on a new branch. Reuses an existing one for the same branch
   * rather than failing — reconnecting to a session must not error just because
   * its checkout is already there.
   */
  async create(branch: string): Promise<WorktreeResult> {
    const existing = (await this.list()).find(w => w.branch === branch);
    if (existing) return { ok: true, worktree: existing };

    const target = path.join(this.baseDir, branch.replace(/[/\\]/g, "-"));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await this.exec(["worktree", "add", "-b", branch, target], this.opts.repoRoot);
      // Report the path as GIT records it, not as we spelled it. They differ on
      // Windows (separators) and macOS (/var vs /private/var via symlink), and
      // a later lookup that compares the two would miss the worktree it just
      // made. One source of truth for paths: git.
      const recorded = (await this.list()).find(w => w.branch === branch);
      return { ok: true, worktree: recorded ?? { path: target, branch, main: false } };
    } catch (err: any) {
      return { ok: false, error: cleanGitError(err) };
    }
  }

  /**
   * Remove a worktree and its branch. `force` discards uncommitted work, so it
   * is opt-in: closing a session must not silently destroy edits the user has
   * not looked at yet.
   */
  async remove(target: string, opts: { force?: boolean; deleteBranch?: string } = {}): Promise<WorktreeResult> {
    try {
      await this.exec(["worktree", "remove", ...(opts.force ? ["--force"] : []), target], this.opts.repoRoot);
      if (opts.deleteBranch) {
        // Best-effort: an unmerged branch is worth keeping, not worth failing on.
        try { await this.exec(["branch", "-D", opts.deleteBranch], this.opts.repoRoot); } catch {}
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: cleanGitError(err) };
    }
  }

  /** Drop administrative records for worktrees whose directories are gone. */
  async prune(): Promise<void> {
    try { await this.exec(["worktree", "prune"], this.opts.repoRoot); } catch {}
  }

  /** Files changed in a worktree, for a "what did this session do" summary. */
  async changedFiles(worktreePath: string): Promise<string[]> {
    try {
      const { stdout } = await this.exec(["status", "--porcelain"], worktreePath);
      return stdout.split("\n")
        .map(l => l.slice(3).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Everything a session changed relative to where it branched from.
   *
   * Both committed work and the working tree are included: an agent's edits
   * usually sit uncommitted, and a review that only showed commits would show
   * nothing at all for a typical session.
   */
  async review(worktreePath: string, base = "HEAD"): Promise<SessionDiff> {
    const files = await this.changedFiles(worktreePath);
    let diff = "";
    try {
      // `--no-index`-free: comparing the worktree against the merge base picks
      // up staged, unstaged, and committed changes in one pass.
      const { stdout } = await this.exec(["diff", base, "--"], worktreePath);
      diff = stdout;
    } catch { /* a fresh branch with no base diff still lists files */ }

    let untracked: string[] = [];
    try {
      const { stdout } = await this.exec(["ls-files", "--others", "--exclude-standard"], worktreePath);
      untracked = stdout.split("\n").map(l => l.trim()).filter(Boolean);
    } catch { /* best effort */ }

    return { files, untracked, diff, stat: summarize(diff) };
  }

  /**
   * Fold a session's branch into `target`.
   *
   * Committing first is deliberate: an agent's work is normally uncommitted,
   * and a merge would silently ignore it. The merge is `--no-ff` so the
   * session stays visible in history as one reviewable unit rather than
   * dissolving into the target branch.
   */
  async land(input: { worktreePath: string; branch: string; target: string; message: string }): Promise<WorktreeResult> {
    try {
      const dirty = await this.changedFiles(input.worktreePath);
      if (dirty.length) {
        await this.exec(["add", "-A"], input.worktreePath);
        await this.exec(["commit", "-m", input.message], input.worktreePath);
      }
      // The merge happens in the MAIN checkout: a worktree cannot check out a
      // branch another worktree already holds.
      await this.exec(["checkout", input.target], this.opts.repoRoot);
      await this.exec(["merge", "--no-ff", "-m", input.message, input.branch], this.opts.repoRoot);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: cleanGitError(err) };
    }
  }

  /** The branch the main checkout is on, for a default merge target. */
  async currentBranch(): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec(["rev-parse", "--abbrev-ref", "HEAD"], this.opts.repoRoot);
      const branch = stdout.trim();
      return branch && branch !== "HEAD" ? branch : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface DiffStat { files: number; added: number; removed: number; }

export interface SessionDiff {
  /** Tracked files with changes. */
  files: string[];
  /** New files git is not tracking yet — invisible to `git diff`. */
  untracked: string[];
  diff: string;
  stat: DiffStat;
}

function summarize(diff: string): DiffStat {
  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const path = line.slice(4).replace(/^[ab]\//, "").trim();
      if (path && path !== "/dev/null") files.add(path);
    } else if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { files: files.size, added, removed };
}

function finish(partial: Partial<Worktree>, main: boolean): Worktree {
  // git prints forward slashes even on Windows; normalise to native separators
  // so these paths compare equal to anything built with path.join.
  return { path: path.resolve(partial.path!), branch: partial.branch, head: partial.head, main };
}

/** git writes the useful part to stderr; the exec wrapper's message is noise. */
function cleanGitError(err: any): string {
  const stderr = String(err?.stderr ?? "").trim();
  const message = stderr || String(err?.message ?? err);
  return message.split("\n").filter(Boolean).slice(0, 2).join(" ").trim();
}
