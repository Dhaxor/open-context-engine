/**
 * The session registry — several conversations under one server.
 *
 * Running agents in parallel is the feature T3 Code leads with and the third
 * item on that project's own list of what an agent UI should optimise for. The
 * hard part is not the UI; it is that two agents editing one checkout corrupt
 * each other. Each session therefore gets its own git worktree (see
 * worktree.ts), and this registry owns their lifecycle.
 *
 * Building a session is expensive — a whole index — so creation is serialised
 * per id and deduplicated: two clicks on "new session" produce one session.
 */

import { TraceSession } from "./session";
import { Worktree, WorktreeManager, branchNameFor } from "./worktree";

export type SessionStatus = "starting" | "ready" | "failed" | "closed";

export interface SessionEntry {
  id: string;
  title: string;
  status: SessionStatus;
  workspace: string;
  branch?: string;
  /** Absent until the session is ready. */
  session?: TraceSession;
  error?: string;
  createdAt: string;
  /** Files changed in this session's worktree, refreshed on demand. */
  changedFiles?: string[];
}

/** What a client sees. The TraceSession itself never crosses the wire. */
export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  workspace: string;
  branch?: string;
  error?: string;
  createdAt: string;
  changedFiles: number;
  running: boolean;
  turn: number;
  active: boolean;
}

export interface BuiltSessionHandle {
  session: TraceSession;
  close: () => Promise<void>;
}

export interface SessionRegistryOptions {
  /** Build a session rooted at `workspace`. Supplied by the CLI wiring. */
  build: (spec: { id: string; workspace: string; branch?: string; title: string }) => Promise<BuiltSessionHandle>;
  /** Absent for a non-git workspace: then only the primary session exists. */
  worktrees?: WorktreeManager;
  /** Hard cap; each session holds an index open. Default 6. */
  maxSessions?: number;
}

const DEFAULT_MAX = 6;

export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  private closers = new Map<string, () => Promise<void>>();
  private pending = new Map<string, Promise<SessionEntry>>();
  private listeners = new Set<() => void>();
  private activeId: string | null = null;
  private counter = 0;

  constructor(private opts: SessionRegistryOptions) {}

  /** Adopt the session the server already started, as the primary entry. */
  adopt(id: string, handle: BuiltSessionHandle, spec: { title: string; workspace: string; branch?: string }): SessionEntry {
    const entry: SessionEntry = {
      id, title: spec.title, status: "ready",
      workspace: spec.workspace, branch: spec.branch,
      session: handle.session, createdAt: new Date().toISOString(),
    };
    this.entries.set(id, entry);
    this.closers.set(id, handle.close);
    if (!this.activeId) this.activeId = id;
    this.changed();
    return entry;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) { try { fn(); } catch {} }
  }

  get(id: string): TraceSession | undefined {
    return this.entries.get(id)?.session;
  }

  active(): TraceSession | undefined {
    return this.activeId ? this.get(this.activeId) : undefined;
  }

  activeId_(): string | null { return this.activeId; }

  setActive(id: string): boolean {
    if (!this.entries.has(id)) return false;
    this.activeId = id;
    this.changed();
    return true;
  }

  list(): SessionSummary[] {
    return [...this.entries.values()].map(e => ({
      id: e.id,
      title: e.title,
      status: e.status,
      workspace: e.workspace,
      branch: e.branch,
      error: e.error,
      createdAt: e.createdAt,
      changedFiles: e.changedFiles?.length ?? 0,
      running: e.session?.isRunning() ?? false,
      turn: e.session?.meta().turn ?? 0,
      active: e.id === this.activeId,
    }));
  }

  /**
   * Start a session in its own worktree.
   *
   * The entry appears immediately as "starting" so the UI can show it before
   * the index finishes — a button that does nothing visible for thirty seconds
   * reads as broken.
   */
  async create(title: string): Promise<SessionEntry> {
    if (this.entries.size >= (this.opts.maxSessions ?? DEFAULT_MAX)) {
      throw new Error(`At most ${this.opts.maxSessions ?? DEFAULT_MAX} sessions at once — close one first.`);
    }
    const id = `s${++this.counter}-${Date.now().toString(36)}`;
    const existing = this.pending.get(id);
    if (existing) return existing;

    const promise = this.startSession(id, title);
    this.pending.set(id, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(id);
    }
  }

  private async startSession(id: string, title: string): Promise<SessionEntry> {
    const branches = this.opts.worktrees ? (await this.opts.worktrees.list()).map(w => w.branch ?? "") : [];
    const branch = this.opts.worktrees ? branchNameFor(title, branches) : undefined;

    const entry: SessionEntry = {
      id, title, status: "starting",
      workspace: "", branch,
      createdAt: new Date().toISOString(),
    };
    this.entries.set(id, entry);
    this.changed();

    let worktree: Worktree | undefined;
    try {
      if (this.opts.worktrees && branch) {
        const result = await this.opts.worktrees.create(branch);
        if (!result.ok) throw new Error(result.error ?? "could not create a worktree");
        worktree = result.worktree;
      }
      entry.workspace = worktree?.path ?? "";
      const handle = await this.opts.build({ id, workspace: entry.workspace, branch, title });
      entry.session = handle.session;
      entry.status = "ready";
      this.closers.set(id, handle.close);
    } catch (err: any) {
      entry.status = "failed";
      entry.error = String(err?.message ?? err);
      // Leave a failed worktree behind rather than force-removing it: it may
      // hold the very state that explains the failure.
    }
    this.changed();
    return entry;
  }

  /**
   * Close a session and release its index. Its worktree is removed only when
   * nothing is uncommitted there — a session's edits outliving its tab is the
   * safe default.
   */
  async close(id: string, opts: { discardChanges?: boolean } = {}): Promise<{ ok: boolean; keptWorktree?: string; error?: string }> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: "No such session." };
    if (this.entries.size === 1) return { ok: false, error: "Cannot close the last session." };

    try { await this.closers.get(id)?.(); } catch {}
    this.closers.delete(id);

    let keptWorktree: string | undefined;
    if (this.opts.worktrees && entry.workspace && entry.branch) {
      const changed = await this.opts.worktrees.changedFiles(entry.workspace);
      if (changed.length && !opts.discardChanges) {
        keptWorktree = entry.workspace;
      } else {
        await this.opts.worktrees.remove(entry.workspace, { force: !!opts.discardChanges, deleteBranch: entry.branch });
      }
    }

    entry.status = "closed";
    this.entries.delete(id);
    if (this.activeId === id) this.activeId = this.entries.keys().next().value ?? null;
    this.changed();
    return { ok: true, ...(keptWorktree ? { keptWorktree } : {}) };
  }

  /** What a session changed, for review before landing it. */
  async review(id: string): Promise<import("./worktree").SessionDiff | { error: string }> {
    const entry = this.entries.get(id);
    if (!entry) return { error: "No such session." };
    if (!this.opts.worktrees || !entry.workspace) {
      return { error: "This session has no worktree of its own, so there is nothing to compare." };
    }
    return this.opts.worktrees.review(entry.workspace);
  }

  /**
   * Merge a session's branch into `target` and close it.
   *
   * Landing implies the work is done, so the session is closed afterwards and
   * its worktree removed — leaving it open next to a merged branch invites
   * committing to a branch that is already history.
   */
  async land(id: string, opts: { target?: string; message?: string } = {}): Promise<{ ok: boolean; error?: string; branch?: string }> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: "No such session." };
    if (!this.opts.worktrees || !entry.branch || !entry.workspace) {
      return { ok: false, error: "This session has no branch to land." };
    }
    const target = opts.target ?? await this.opts.worktrees.currentBranch();
    if (!target) return { ok: false, error: "Could not determine a branch to merge into." };
    if (target === entry.branch) return { ok: false, error: "A session cannot be merged into itself." };

    const result = await this.opts.worktrees.land({
      worktreePath: entry.workspace,
      branch: entry.branch,
      target,
      message: opts.message ?? `Trace session: ${entry.title}`,
    });
    if (!result.ok) return { ok: false, error: result.error };

    // The branch is merged; force removal is safe and the tree is now clean.
    await this.close(id, { discardChanges: true });
    return { ok: true, branch: entry.branch };
  }

  /** Refresh each session's changed-file count, for the switcher. */
  async refreshChanges(): Promise<void> {
    if (!this.opts.worktrees) return;
    for (const entry of this.entries.values()) {
      if (!entry.workspace) continue;
      entry.changedFiles = await this.opts.worktrees.changedFiles(entry.workspace);
    }
    this.changed();
  }

  async closeAll(): Promise<void> {
    for (const [id, close] of this.closers) {
      try { await close(); } catch {}
      this.entries.delete(id);
    }
    this.closers.clear();
    this.activeId = null;
    this.changed();
  }
}
