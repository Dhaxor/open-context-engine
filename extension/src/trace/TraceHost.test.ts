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

/** Just enough TraceSession for the host: identity, mode, and a run flag. */
const built: { id: string; mode: string; resets: number }[] = [];
vi.mock("../../../src/trace/stack", () => ({
    assembleAgentStack: (input: any) => {
        const state = { id: input.sessionId, mode: input.mode, resets: 0 };
        built.push(state);
        return {
            agent: { exportSession: () => JSON.stringify({ version: 1, messages: [] }) },
            trace: {
                meta: () => ({ id: state.id, mode: state.mode, turn: 0, title: "" }),
                setMode: (m: string) => { state.mode = m; },
                isRunning: () => false,
                interrupt: () => false,
                reset: () => { state.resets++; },
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
});
