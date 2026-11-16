import * as vscode from "vscode";
import type { Attention } from "./TraceHost";
import type { HostSheet } from "./protocol";

/** What the notifier needs from the host: attention events, and "now viewed". */
export interface AttentionSource {
    onDidNeedAttention: vscode.Event<Attention>;
    onDidViewSession: vscode.Event<string>;
}

/** Where the user would be looking, and how to take them there. */
export interface AttentionSurface {
    /** The session is on screen in the sidebar or the Trace tab. */
    isWatching(sessionId: string): boolean;
    onDidChangeVisibility: vscode.Event<void>;
    setBadge(count: number, tooltip: string): void;
    open(sheet: HostSheet): void;
}

/**
 * Tells you when a session you are not watching needs you: a turn finished
 * (with Review, for a parallel session), failed, or is waiting on an approval.
 *
 * Parallel worktree sessions exist so work can run while you do something
 * else, which only works if you hear when it is done — otherwise you poll the
 * tabs. Nothing is shown for the session on screen in a focused window: you
 * saw it happen. Each waiting session counts once on the activity-bar badge
 * until you look at it.
 */
export class SessionNotifier implements vscode.Disposable {
    private waiting = new Map<string, Attention>();
    private disposables: vscode.Disposable[] = [];

    constructor(source: AttentionSource, private readonly surface: AttentionSurface) {
        this.disposables.push(
            source.onDidNeedAttention(a => this.attend(a)),
            source.onDidViewSession(id => { if (this.surface.isWatching(id)) this.seen(id); }),
            surface.onDidChangeVisibility(() => {
                for (const id of [...this.waiting.keys()]) if (this.surface.isWatching(id)) this.seen(id);
            }),
        );
    }

    private attend(a: Attention): void {
        if (!vscode.workspace.getConfiguration("openContext").get<boolean>("agent.notifications.enabled", true)) return;
        const focused = vscode.window.state?.focused ?? true;
        if (focused && this.surface.isWatching(a.sessionId)) return;
        // An approval answered elsewhere, then the turn finishing: the newest
        // state is the one worth a badge.
        this.waiting.set(a.sessionId, a);
        this.updateBadge();

        const actions = a.kind === "finished" && a.worktree ? ["Review", "Show"] : ["Show"];
        const message = a.kind === "approval" ? `${a.title} is waiting for your approval: ${a.detail}`
            : a.kind === "failed" ? `${a.title} stopped: ${a.detail}`
            : `${a.title} finished — ${a.detail}.`;
        const shown = a.kind === "finished"
            ? vscode.window.showInformationMessage(message, ...actions)
            : vscode.window.showWarningMessage(message, ...actions);
        void Promise.resolve(shown).then(pick => {
            if (pick === "Review") this.surface.open({ sheet: "review", sessionId: a.sessionId });
            else if (pick === "Show") this.surface.open({ sheet: "session", sessionId: a.sessionId });
        });
    }

    private seen(id: string): void {
        if (this.waiting.delete(id)) this.updateBadge();
    }

    private updateBadge(): void {
        const n = this.waiting.size;
        const approvals = [...this.waiting.values()].filter(a => a.kind === "approval").length;
        const tooltip = approvals
            ? `${approvals} session${approvals === 1 ? "" : "s"} waiting for approval${n > approvals ? `, ${n - approvals} finished` : ""}`
            : `${n} session${n === 1 ? "" : "s"} finished while you were away`;
        this.surface.setBadge(n, tooltip);
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
    }
}
