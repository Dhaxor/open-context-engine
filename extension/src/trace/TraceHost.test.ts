import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oce-host-"));
const fakeCtx = { getWorkspaceRoot: () => root, getPolicy: () => undefined, incrementalIndex: async () => ({}), close: () => {} };

vi.mock("../services/ContextService", () => ({
    ContextService: {
        getInstance: () => ({
            getContext: async () => fakeCtx,
            getIndexWorkspaceRoot: () => root,
            getContextGeneration: () => 1,
            getConfigForPath: async (p: string) => ({ workspaceRoot: p }),
            getLicenseStatus: () => ({}),
            getLLMSelection: () => undefined,
            getLLMApiKey: async () => "key",
            getWebSearchApiKey: async () => undefined,
            getIdeRetrieveOptionsForCurrentContext: async () => ({}),
        }),
    },
}));
vi.mock("../../../src/core/context", () => ({ OpenContext: { create: async () => fakeCtx } }));

/** Just enough TraceSession for the host: identity, mode, a run flag, and an
 *  event stream the test can push into (`emit`). */
type Fake = { id: string; mode: string; resets: number; memory?: unknown; workspace: string; title: string; emit: (event: any, agentId?: string) => void };
const built: Fake[] = [];
vi.mock("../../../src/trace/stack", () => ({
    assembleAgentStack: (input: any) => {
        const subs = new Set<(env: any) => void>();
        let seq = 0;
        const state: Fake = {
            id: input.sessionId, mode: input.mode, resets: 0, memory: input.memory, workspace: input.workspaceRoot, title: input.meta?.title ?? "",
            emit: (event, agentId) => { const env = { seq: ++seq, ts: "", sessionId: input.sessionId, ...(agentId ? { agentId } : {}), event }; for (const fn of subs) fn(env); },
        };
        built.push(state);
        return {
            agent: { exportSession: () => JSON.stringify({ version: 1, messages: [] }) },
            trace: {
                meta: () => ({ id: state.id, mode: state.mode, turn: 0, title: state.title }),
                setMode: (m: string) => { state.mode = m; },
                isRunning: () => false,
                interrupt: () => false,
                reset: () => { state.resets++; },
                subscribe: (fn: (env: any) => void) => { subs.add(fn); return () => subs.delete(fn); },
                cursor: () => seq,
                exportTrace: () => ({ checkpoints: [] }),
                turnCount: () => 0,
            },
        };
    },
}));
vi.mock("../../../src/trace/worktree", async (original) => ({
    ...(await original<typeof import("../../../src/trace/worktree")>()),
    WorktreeManager: class {
        async isRepo() { return true; }
        async list() { return [{ path: root, branch: "main", main: true }]; }
        async create(branch: string) { return { ok: true, worktree: { path: path.join(root, "wt", branch.replace(/\//g, "-")), branch, main: false } }; }
        async changedFiles() { return []; }
        async remove() { return { ok: true }; }
    },
}));

import { TraceHost } from "./TraceHost";

function host() {
    const review = { record: vi.fn(), clear: vi.fn() };
    const state = new Map<string, unknown>();
    const extCtx = { workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } } };
    return { host: new TraceHost(review as any, extCtx as any), review };
}

beforeEach(() => {
    built.length = 0;
    vscode.workspace._config = new Map<string, any>([["agent.memory.enabled", false], ["agent.approvalMode", "auto-edit"]]);
    vscode.workspace._configListeners = [];
});

describe("TraceHost", () => {
    it("applies an approval mode changed in settings to every open session", async () => {
        const { host: h } = host();
        const registry = await h.ready();
        await registry.create("parallel work");
        expect(built.map(b => b.mode)).toEqual(["auto-edit", "auto-edit"]);

        vscode.workspace._config.set("agent.approvalMode", "suggest");
        vscode.workspace._fireConfig("openContext.agent.approvalMode");
        // A session left in full-auto after the user asked for "suggest" is the bug.
        expect(built.map(b => b.mode)).toEqual(["suggest", "suggest"]);
    });

    it("starts a parallel session's new conversation as a fresh session, not an in-place reset", async () => {
        const { host: h, review } = host();
        const registry = await h.ready();
        const sibling = await registry.create("parallel work");
        const resets: { from: string; to: string }[] = [];
        h.onDidReset(r => resets.push(r));

        await h.newConversation(sibling.id);

        // reset() would keep the old transcript in the buffer and replay it.
        expect(built.find(b => b.id === sibling.id)!.resets).toBe(0);
        expect(resets).toHaveLength(1);
        expect(resets[0].from).toBe(sibling.id);
        expect(resets[0].to).not.toBe(sibling.id);
        expect(registry.list().map(s => s.id)).toContain(resets[0].to);
        expect(registry.list().find(s => s.id === resets[0].to)).toMatchObject({ branch: sibling.branch });
        // The main checkout's edit history belongs to the primary; leave it be.
        expect(review.clear).not.toHaveBeenCalled();
    });

    it("reports a finished, failed, or waiting turn as attention — and nothing for Stop or sub-agents", async () => {
        const { host: h } = host();
        const registry = await h.ready();
        await registry.create("Fix the flaky test");
        const sibling = built[1];
        const seen: any[] = [];
        h.onDidNeedAttention(a => seen.push(a));

        sibling.emit({ type: "turn_start", turn: 1, prompt: "go" });
        sibling.emit({ type: "edit", edit: { id: "e1", path: "a.ts" } });
        sibling.emit({ type: "edit", edit: { id: "e2", path: "a.ts" } });
        sibling.emit({ type: "checkpoint", checkpoint: { turn: 1 } }, "sub-1"); // a sub-agent's: ignored
        sibling.emit({ type: "checkpoint", checkpoint: { turn: 1 } });
        sibling.emit({ type: "approval_request", request: { title: "Run npm test" } });
        sibling.emit({ type: "turn_start", turn: 2, prompt: "again" });
        sibling.emit({ type: "notice", level: "error", message: "rate limited" });
        sibling.emit({ type: "checkpoint", checkpoint: { turn: 2 } });
        sibling.emit({ type: "turn_start", turn: 3, prompt: "stop me" });
        sibling.emit({ type: "phase", phase: "interrupted" });
        sibling.emit({ type: "checkpoint", checkpoint: { turn: 3 } });

        expect(seen.map(a => [a.kind, a.detail])).toEqual([
            ["finished", "1 file changed"],
            ["approval", "Run npm test"],
            ["failed", "rate limited"],
        ]);
        expect(seen[0]).toMatchObject({ sessionId: sibling.id, title: "Fix the flaky test", worktree: true });
    });

    describe("memory", () => {
        beforeEach(() => {
            vscode.workspace._config.set("agent.memory.enabled", true);
            fs.rmSync(path.join(root, ".open-context"), { recursive: true, force: true });
        });

        it("lists, remembers, corrects, and forgets — before any session has started", () => {
            const { host: h } = host();
            expect(h.memories()).toEqual({ enabled: true, rows: [] });
            const row = h.remember("  We deploy with Fly.io, never Heroku  ", "preference");
            expect(row).toMatchObject({ kind: "preference", content: "We deploy with Fly.io, never Heroku", source: "user" });

            const edited = h.editMemory(row.id, { content: "We deploy with Fly.io from the main branch" });
            expect(h.memories().rows.map(r => r.content)).toEqual(["We deploy with Fly.io from the main branch"]);

            expect(h.forgetMemory(edited.id)).toBe(true);
            expect(h.memories().rows).toEqual([]);
        });

        it("applies the MCP tool's rules and refuses writes while memory is off", () => {
            const { host: h } = host();
            expect(() => h.remember("hi")).toThrow(/between 5 and 500/);
            expect(() => h.remember("password: hunter2hunter2")).toThrow(/secret/);
            vscode.workspace._config.set("agent.memory.enabled", false);
            expect(h.memories().enabled).toBe(false);
            expect(() => h.remember("Use the staging cluster for load tests")).toThrow(/Memory is off/);
        });

        it("gives a parallel session the main checkout's store, not one inside its worktree", async () => {
            // A worktree is deleted when the session lands; what it learned about
            // the repository would go with it.
            const { host: h } = host();
            const registry = await h.ready();
            await registry.create("parallel work");
            const [primary, sibling] = built;
            expect(sibling.workspace).not.toBe(primary.workspace);
            expect(primary.memory).toBeDefined();
            expect(sibling.memory).toBe(primary.memory);
            h.remember("The flaky auth test needs REDIS_URL set");
            expect(h.memories().rows).toHaveLength(1);
        });
    });
});
