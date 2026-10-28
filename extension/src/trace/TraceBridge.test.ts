import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "vscode";

vi.mock("../services/ContextService", () => ({
    ContextService: { getInstance: () => ({ getIndexWorkspaceRoot: () => "/ws", searchRaw: async () => [] }) },
}));

import { TraceBridge } from "./TraceBridge";

type Listener = (env: any) => void;

/** Just enough TraceSession for the bridge: a buffered stream plus the calls it forwards. */
function fakeSession(id: string) {
    const listeners = new Set<Listener>();
    const s = {
        prompts: [] as string[],
        running: false,
        buffer: [{ seq: 1, ts: "", sessionId: id, event: { type: "turn_start", turn: 1, prompt: "hi" } }],
        meta: () => ({ id }),
        isRunning: () => s.running,
        subscribe: (fn: Listener, since?: number) => {
            if (since === undefined) fn({ seq: 0, ts: "", sessionId: id, event: { type: "session", meta: { id } } });
            for (const env of s.buffer) if (since === undefined || env.seq > since) fn(env);
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        prompt: async (text: string) => { s.prompts.push(text); },
        files: (q: string) => [`src/${q}.ts`],
        emit: (env: any) => listeners.forEach(fn => fn(env)),
        listeners,
    };
    return s;
}

function harness() {
    const sessions = new Map([["s1", fakeSession("s1")]]);
    let active = "s1";
    const resets = new EventEmitter<{ from: string; to: string }>();
    const host = {
        ready: async () => ({}),
        session: (id: string | null) => sessions.get(id ?? active),
        sessionForTurn: async (id: string | null) => sessions.get(id ?? active)!,
        sessions: () => ({ sessions: [...sessions.keys()].map(id => ({ id, active: id === active })), parallel: false }),
        state: async () => ({ setup: null }),
        onDidChangeSessions: new EventEmitter<void>().event,
        onDidChangeState: new EventEmitter<void>().event,
        onDidStart: new EventEmitter<void>().event,
        onDidReset: resets.event,
    };
    const posted: any[] = [];
    let receive: (m: any) => Promise<void> | void = () => {};
    const webview = {
        postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (fn: any) => { receive = fn; return { dispose() {} }; },
    };
    const bridge = new TraceBridge(host as any, {} as any, webview as any, "sidebar");
    const send = async (m: any) => { await receive(m); await new Promise(r => setTimeout(r, 0)); };
    return {
        bridge, posted, send, sessions, resets,
        setActive: (id: string) => { active = id; },
        rpc: async (method: string, params: any = {}) => {
            const id = Math.floor(Math.random() * 1e9);
            await send({ kind: "rpc", id, method, params });
            return posted.find(m => m.kind === "rpc-result" && m.id === id);
        },
    };
}

describe("TraceBridge", () => {
    let h: ReturnType<typeof harness>;
    beforeEach(() => { h = harness(); });

    it("replays the session from the start on subscribe, then streams live", async () => {
        await h.send({ kind: "subscribe", sessionId: null, since: 0 });
        const traces = h.posted.filter(m => m.kind === "trace").map(m => m.envelope.event.type);
        expect(traces).toEqual(["session", "turn_start"]);
        expect(h.posted).toContainEqual({ kind: "connection", connected: true });

        h.sessions.get("s1")!.emit({ seq: 2, ts: "", sessionId: "s1", event: { type: "text", text: "yo" } });
        expect(h.posted.at(-1)).toMatchObject({ kind: "trace", envelope: { seq: 2 } });
    });

    it("resumes after a cursor instead of replaying what the webview has", async () => {
        await h.send({ kind: "subscribe", sessionId: "s1", since: 1 });
        expect(h.posted.filter(m => m.kind === "trace")).toHaveLength(0);
    });

    it("starts a turn without waiting for it, and refuses a second one", async () => {
        await h.send({ kind: "subscribe", sessionId: null, since: 0 });
        expect(await h.rpc("prompt", { text: "fix it" })).toMatchObject({ ok: true });
        expect(h.sessions.get("s1")!.prompts).toEqual(["fix it"]);

        h.sessions.get("s1")!.running = true;
        expect(await h.rpc("prompt", { text: "again" })).toMatchObject({ ok: false, error: expect.stringMatching(/already running/) });
    });

    it("answers unknown methods and commands with an error, not silence", async () => {
        expect(await h.rpc("rm -rf")).toMatchObject({ ok: false, error: "Unknown method: rm -rf" });
        expect(await h.rpc("command", { name: "workbench.action.terminal.sendSequence" })).toMatchObject({ ok: false });
    });

    it("follows a rebuilt session: tells the webview to reset, then replays the new one", async () => {
        await h.send({ kind: "subscribe", sessionId: null, since: 0 });
        const replacement = fakeSession("s2");
        h.sessions.delete("s1");
        h.sessions.set("s2", replacement);
        h.setActive("s2");
        h.posted.length = 0;

        h.resets.fire({ from: "s1", to: "s2" });
        await new Promise(r => setTimeout(r, 0));
        expect(h.posted[0]).toEqual({ kind: "reset", sessionId: null });
        expect(h.posted.filter(m => m.kind === "trace").map(m => m.envelope.sessionId)).toEqual(["s2", "s2"]);
    });

    it("ignores a reset for a session this webview is not watching", async () => {
        await h.send({ kind: "subscribe", sessionId: null, since: 0 });
        h.posted.length = 0;
        h.resets.fire({ from: "other", to: "other-2" });
        expect(h.posted).toEqual([]);
    });

    it("holds composer text until the webview has loaded", async () => {
        h.bridge.compose("explain this", true);
        expect(h.posted.find(m => m.kind === "compose")).toBeUndefined();
        await h.send({ kind: "ready", surface: "sidebar" });
        expect(h.posted).toContainEqual({ kind: "compose", text: "explain this", send: true });
    });
});
