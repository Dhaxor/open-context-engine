import { describe, it, expect } from "vitest";
import { TraceSession } from "./session";
import { SessionRegistry } from "./registry";
import { WorktreeManager } from "./worktree";

/** Just enough TraceSession surface for the registry to summarise. */
function fakeSession(over: { running?: boolean; turn?: number } = {}): TraceSession {
  return {
    isRunning: () => over.running ?? false,
    meta: () => ({ turn: over.turn ?? 0 }),
  } as unknown as TraceSession;
}

interface Harness {
  registry: SessionRegistry;
  built: string[];
  closed: string[];
  worktrees: WorktreeManager;
  dirty: Set<string>;
  removed: string[];
  landed: { branch: string; target: string; message: string } | null;
}

function harness(opts: { git?: boolean; failBuild?: boolean; failWorktree?: boolean; failLand?: boolean; max?: number } = {}): Harness {
  const built: string[] = [];
  const closed: string[] = [];
  const removed: string[] = [];
  const dirty = new Set<string>();
  const branches: string[] = ["main"];
  const state = { landed: null as Harness["landed"] };

  const worktrees = {
    isRepo: async () => true,
    list: async () => branches.map(b => ({ path: `/wt/${b.replace(/\//g, "-")}`, branch: b, main: b === "main" })),
    create: async (branch: string) => {
      if (opts.failWorktree) return { ok: false, error: "fatal: could not create worktree" };
      branches.push(branch);
      return { ok: true, worktree: { path: `/wt/${branch.replace(/\//g, "-")}`, branch, main: false } };
    },
    remove: async (target: string) => { removed.push(target); return { ok: true }; },
    changedFiles: async (p: string) => (dirty.has(p) ? ["a.ts", "b.ts"] : []),
    prune: async () => {},
    currentBranch: async () => "main",
    review: async () => ({ files: ["a.ts"], untracked: [], diff: "+one", stat: { files: 1, added: 1, removed: 0 } }),
    land: async (input: { branch: string; target: string; message: string }) => {
      if (opts.failLand) return { ok: false, error: "CONFLICT (content): merge conflict in a.ts" };
      state.landed = { branch: input.branch, target: input.target, message: input.message };
      return { ok: true };
    },
  } as unknown as WorktreeManager;

  const registry = new SessionRegistry({
    ...(opts.git === false ? {} : { worktrees }),
    maxSessions: opts.max,
    build: async ({ id }) => {
      if (opts.failBuild) throw new Error("index failed");
      built.push(id);
      return {
        session: fakeSession(),
        close: async () => { closed.push(id); },
      };
    },
  });
  return {
    registry, built, closed, worktrees, dirty, removed,
    get landed() { return state.landed; },
  };
}

function primary(h: Harness) {
  return h.registry.adopt("primary", { session: fakeSession(), close: async () => {} }, {
    title: "Primary", workspace: "/repo", branch: "main",
  });
}

describe("SessionRegistry", () => {
  it("adopts the session the server already started as active", () => {
    const h = harness();
    primary(h);
    expect(h.registry.activeId_()).toBe("primary");
    expect(h.registry.list()).toEqual([expect.objectContaining({ id: "primary", active: true, status: "ready" })]);
  });

  it("creates a session in its own worktree and branch", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("Fix the auth flow");

    expect(entry.status).toBe("ready");
    expect(entry.branch).toBe("trace/fix-the-auth-flow");
    expect(entry.workspace).toBe("/wt/trace-fix-the-auth-flow");
    expect(h.built).toEqual([entry.id]);
    expect(h.registry.get(entry.id)).toBeDefined();
  });

  it("gives concurrent sessions different branches", async () => {
    const h = harness();
    primary(h);
    const a = await h.registry.create("fix");
    const b = await h.registry.create("fix");
    expect(a.branch).not.toBe(b.branch);
    expect(b.branch).toBe("trace/fix-2");
  });

  it("keeps the switcher informed while a session is still starting", async () => {
    const h = harness();
    primary(h);
    const seen: string[][] = [];
    h.registry.onChange(() => seen.push(h.registry.list().map(s => s.status)));
    await h.registry.create("slow one");

    // A button that does nothing visible for thirty seconds reads as broken.
    expect(seen.some(statuses => statuses.includes("starting"))).toBe(true);
    expect(seen[seen.length - 1]).toEqual(["ready", "ready"]);
  });

  it("records a failed start instead of throwing it away", async () => {
    const h = harness({ failBuild: true });
    primary(h);
    const entry = await h.registry.create("doomed");
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("index failed");
    // The entry stays so the UI can show WHY, not just that nothing happened.
    expect(h.registry.list().find(s => s.id === entry.id)?.error).toContain("index failed");
  });

  it("reports a worktree failure as the reason", async () => {
    const h = harness({ failWorktree: true });
    primary(h);
    const entry = await h.registry.create("blocked");
    expect(entry.status).toBe("failed");
    expect(entry.error).toContain("could not create worktree");
  });

  it("enforces a ceiling, because each session holds an index open", async () => {
    const h = harness({ max: 2 });
    primary(h);
    await h.registry.create("second");
    await expect(h.registry.create("third")).rejects.toThrow(/At most 2 sessions/);
  });

  it("switches the active session", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("other");
    expect(h.registry.setActive(entry.id)).toBe(true);
    expect(h.registry.active()).toBe(h.registry.get(entry.id));
    expect(h.registry.list().find(s => s.active)?.id).toBe(entry.id);
    expect(h.registry.setActive("nope")).toBe(false);
  });

  it("closes a clean session and removes its worktree", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("done with this");

    const result = await h.registry.close(entry.id);
    expect(result.ok).toBe(true);
    expect(h.closed).toEqual([entry.id]);
    expect(h.removed).toEqual([entry.workspace]);
    expect(h.registry.list()).toHaveLength(1);
  });

  it("keeps a worktree that still has uncommitted work", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("wip");
    h.dirty.add(entry.workspace);

    const result = await h.registry.close(entry.id);
    // Closing a tab must not destroy edits nobody has reviewed.
    expect(result.keptWorktree).toBe(entry.workspace);
    expect(h.removed).toEqual([]);
  });

  it("discards uncommitted work only when asked", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("wip");
    h.dirty.add(entry.workspace);

    const result = await h.registry.close(entry.id, { discardChanges: true });
    expect(result.keptWorktree).toBeUndefined();
    expect(h.removed).toEqual([entry.workspace]);
  });

  it("refuses to close the last session", async () => {
    const h = harness();
    primary(h);
    const result = await h.registry.close("primary");
    expect(result).toMatchObject({ ok: false, error: "Cannot close the last session." });
  });

  it("moves the active pointer when the active session closes", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("other");
    h.registry.setActive(entry.id);
    await h.registry.close(entry.id);
    expect(h.registry.activeId_()).toBe("primary");
    expect(h.registry.active()).toBeDefined();
  });

  it("404s an unknown session rather than falling back to the default", async () => {
    const h = harness();
    primary(h);
    expect(h.registry.get("nope")).toBeUndefined();
    expect(await h.registry.close("nope")).toMatchObject({ ok: false });
  });

  it("runs without git, as a single session", async () => {
    const h = harness({ git: false });
    primary(h);
    const entry = await h.registry.create("no worktree");
    expect(entry.branch).toBeUndefined();
    expect(entry.status).toBe("ready");
    expect(h.removed).toEqual([]);
  });

  it("reports changed-file counts for the switcher", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("busy");
    h.dirty.add(entry.workspace);

    await h.registry.refreshChanges();
    expect(h.registry.list().find(s => s.id === entry.id)?.changedFiles).toBe(2);
  });

  it("closes everything on shutdown", async () => {
    const h = harness();
    primary(h);
    await h.registry.create("a");
    await h.registry.create("b");
    await h.registry.closeAll();
    expect(h.registry.list()).toEqual([]);
  });

  it("reviews what a session changed", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("wip");
    const review = await h.registry.review(entry.id);
    expect(review).toMatchObject({ files: ["a.ts"], stat: { added: 1, removed: 0 } });
  });

  it("explains why a session with no worktree cannot be reviewed", async () => {
    const h = harness({ git: false });
    primary(h);
    const entry = await h.registry.create("no worktree");
    expect(await h.registry.review(entry.id)).toMatchObject({ error: expect.stringContaining("no worktree") });
    expect(await h.registry.review("nope")).toMatchObject({ error: "No such session." });
  });

  it("lands a session and closes it", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("ready to ship");

    const result = await h.registry.land(entry.id);
    expect(result).toMatchObject({ ok: true, branch: entry.branch });
    expect(h.landed).toMatchObject({ branch: entry.branch, target: "main" });
    // Leaving it open beside a merged branch invites committing to history.
    expect(h.registry.list().map(s => s.id)).toEqual(["primary"]);
    expect(h.closed).toEqual([entry.id]);
  });

  it("uses a supplied target and message", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("x");
    await h.registry.land(entry.id, { target: "develop", message: "custom" });
    expect(h.landed).toMatchObject({ target: "develop", message: "custom" });
  });

  it("refuses to merge a session into itself", async () => {
    const h = harness();
    primary(h);
    const entry = await h.registry.create("x");
    const result = await h.registry.land(entry.id, { target: entry.branch });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("into itself") });
  });

  it("keeps the session open when the merge fails", async () => {
    const h = harness({ failLand: true });
    primary(h);
    const entry = await h.registry.create("conflicted");

    const result = await h.registry.land(entry.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("CONFLICT");
    // Closing it here would discard the work that still needs resolving.
    expect(h.registry.get(entry.id)).toBeDefined();
  });

  it("refuses to land a session with no branch", async () => {
    const h = harness({ git: false });
    primary(h);
    const entry = await h.registry.create("x");
    expect(await h.registry.land(entry.id)).toMatchObject({ ok: false, error: expect.stringContaining("no branch") });
  });

  it("survives a listener that throws", async () => {
    const h = harness();
    h.registry.onChange(() => { throw new Error("bad UI"); });
    expect(() => primary(h)).not.toThrow();
    await expect(h.registry.create("x")).resolves.toBeDefined();
  });
});
