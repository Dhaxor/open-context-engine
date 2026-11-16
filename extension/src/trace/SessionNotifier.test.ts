import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { SessionNotifier, type AttentionSurface } from "./SessionNotifier";
import type { Attention } from "./TraceHost";
import type { HostSheet } from "./protocol";

function rig(watching: Set<string> = new Set()) {
    const attention = new vscode.EventEmitter<Attention>();
    const viewed = new vscode.EventEmitter<string>();
    const visibility = new vscode.EventEmitter<void>();
    const opened: HostSheet[] = [];
    const badges: number[] = [];
    const surface: AttentionSurface = {
        isWatching: id => watching.has(id),
        onDidChangeVisibility: visibility.event,
        setBadge: n => badges.push(n),
        open: sheet => opened.push(sheet),
    };
    const notifier = new SessionNotifier({ onDidNeedAttention: attention.event, onDidViewSession: viewed.event }, surface);
    return { notifier, attention, viewed, visibility, opened, badges, watching };
}

const finished: Attention = { sessionId: "s2", title: "Fix the flaky test", kind: "finished", detail: "2 files changed", worktree: true };
const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
    vscode.window._messages = [];
    vscode.window._pick = undefined;
    vscode.window.state = { focused: true };
    vscode.workspace._config = new Map();
});

describe("SessionNotifier", () => {
    it("tells you a background session finished, with Review, and badges it until you look", async () => {
        const r = rig();
        vscode.window._pick = "Review";
        r.attention.fire(finished);
        await tick();
        expect(vscode.window._messages).toEqual([{ level: "info", message: "Fix the flaky test finished — 2 files changed.", actions: ["Review", "Show"] }]);
        expect(r.opened).toEqual([{ sheet: "review", sessionId: "s2" }]);
        expect(r.badges.at(-1)).toBe(1);

        r.watching.add("s2");
        r.viewed.fire("s2");
        expect(r.badges.at(-1)).toBe(0);
    });

    it("stays quiet about the session you are watching in a focused window", async () => {
        const r = rig(new Set(["s2"]));
        r.attention.fire(finished);
        await tick();
        expect(vscode.window._messages).toEqual([]);
        expect(r.badges).toEqual([]);
    });

    it("still tells you when the window is in the background", async () => {
        const r = rig(new Set(["s2"]));
        vscode.window.state = { focused: false };
        r.attention.fire(finished);
        await tick();
        expect(vscode.window._messages).toHaveLength(1);
    });

    it("warns about approvals and failures, offering Show", async () => {
        const r = rig();
        vscode.window._pick = "Show";
        r.attention.fire({ ...finished, kind: "approval", detail: "Run npm test" });
        r.attention.fire({ sessionId: "s1", title: "Agent", kind: "failed", detail: "rate limited", worktree: false });
        await tick();
        expect(vscode.window._messages.map(m => [m.level, m.message, m.actions])).toEqual([
            ["warn", "Fix the flaky test is waiting for your approval: Run npm test", ["Show"]],
            ["warn", "Agent stopped: rate limited", ["Show"]],
        ]);
        expect(r.opened).toEqual([{ sheet: "session", sessionId: "s2" }, { sheet: "session", sessionId: "s1" }]);
        expect(r.badges.at(-1)).toBe(2);
        // Opening the sidebar onto one of them clears just that one.
        r.watching.add("s1");
        r.visibility.fire();
        expect(r.badges.at(-1)).toBe(1);
    });

    it("can be turned off", async () => {
        vscode.workspace._config.set("agent.notifications.enabled", false);
        const r = rig();
        r.attention.fire(finished);
        await tick();
        expect(vscode.window._messages).toEqual([]);
        expect(r.badges).toEqual([]);
    });
});
