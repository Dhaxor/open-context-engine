import * as path from "path";
import * as vscode from "vscode";
import type { ApprovalDecision, ApprovalMode } from "../../../src/agent/permissions";
import { ContextService } from "../services/ContextService";
import type { EditReviewService } from "../services/EditReviewService";
import type { TraceHost } from "./TraceHost";
import type { HostMessage, SearchHit, Surface, WebviewMessage } from "./protocol";

const MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];
const DECISIONS: ApprovalDecision[] = ["allow", "always", "deny"];

type Params = Record<string, unknown>;

/**
 * Connects one webview to the TraceHost.
 *
 * Owns exactly one subscription — the session this webview is looking at —
 * and answers its RPCs. A sidebar and an editor tab each get their own bridge,
 * so they can watch different sessions at once; neither can see the other.
 */
export class TraceBridge implements vscode.Disposable {
    /** The session this webview follows; null follows the registry's active one. */
    private viewing: string | null = null;
    /** The session actually subscribed to — `viewing` resolved. */
    private attachedId: string | null = null;
    private unsubscribe: (() => void) | null = null;
    private disposables: vscode.Disposable[] = [];
    private stateTimer: ReturnType<typeof setTimeout> | null = null;
    private loaded = false;
    private pendingCompose: { text: string; send: boolean } | null = null;

    constructor(
        private readonly host: TraceHost,
        private readonly review: EditReviewService,
        private readonly webview: vscode.Webview,
        private readonly surface: Surface,
    ) {
        this.disposables.push(
            webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m)),
            host.onDidChangeSessions(() => this.post({ kind: "sessions", ...host.sessions() })),
            host.onDidChangeState(() => this.scheduleState()),
            // Subscribed while the setup gate was up, so there was nothing to
            // attach to; now there is.
            host.onDidStart(() => { if (this.loaded && !this.attachedId) void this.attach(0); }),
            host.onDidReset(({ from, to }) => {
                if (this.attachedId !== from) return;
                if (this.viewing !== null) this.viewing = to;
                this.post({ kind: "reset", sessionId: this.viewing });
                void this.attach(0);
            }),
        );
    }

    /** Put text in this webview's composer (and optionally send it). Held
     *  until the webview has loaded — a message posted earlier is lost. */
    compose(text: string, send = false): void {
        if (this.loaded) this.post({ kind: "compose", text, send });
        else this.pendingCompose = { text, send };
    }

    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.stateTimer) clearTimeout(this.stateTimer);
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
    }

    // ─── plumbing ────────────────────────────────────────────────────────────

    private post(message: HostMessage): void {
        void this.webview.postMessage(message);
    }

    private scheduleState(): void {
        // Selection changes fire per keystroke; the webview needs the settled state.
        if (this.stateTimer) clearTimeout(this.stateTimer);
        this.stateTimer = setTimeout(() => { this.stateTimer = null; void this.pushState(); }, 80);
    }

    private async pushState(): Promise<void> {
        try { this.post({ kind: "state", state: await this.host.state() }); } catch {}
    }

    private async onMessage(msg: WebviewMessage): Promise<void> {
        switch (msg.kind) {
            case "ready":
                this.loaded = true;
                await this.pushState();
                this.post({ kind: "sessions", ...this.host.sessions() });
                if (this.pendingCompose) {
                    this.post({ kind: "compose", ...this.pendingCompose });
                    this.pendingCompose = null;
                }
                return;
            case "subscribe":
                this.viewing = msg.sessionId;
                await this.attach(msg.since);
                return;
            case "rpc": {
                try {
                    const value = await this.call(msg.method, msg.params ?? {});
                    this.post({ kind: "rpc-result", id: msg.id, ok: true, value: value ?? null });
                } catch (err: any) {
                    this.post({ kind: "rpc-result", id: msg.id, ok: false, error: String(err?.message ?? err) });
                }
                return;
            }
        }
    }

    private async attach(since: number): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.attachedId = null;
        try {
            await this.host.ready();
        } catch {
            // The setup gate (no key, no folder) arrives with the state push.
            this.post({ kind: "connection", connected: false });
            await this.pushState();
            return;
        }
        const session = this.host.session(this.viewing);
        if (!session) {
            this.post({ kind: "connection", connected: false });
            return;
        }
        this.post({ kind: "sessions", ...this.host.sessions() });
        this.attachedId = session.meta().id;
        this.unsubscribe = session.subscribe(envelope => this.post({ kind: "trace", envelope }), since > 0 ? since : undefined);
        this.post({ kind: "connection", connected: true });
        await this.pushState();
    }

    private async viewed() {
        await this.host.ready();
        const session = this.host.session(this.viewing);
        if (!session) throw new Error("That session is no longer open.");
        return session;
    }

    // ─── rpc ─────────────────────────────────────────────────────────────────

    private async call(method: string, p: Params): Promise<unknown> {
        const str = (key: string) => String(p[key] ?? "");
        switch (method) {
            // The TraceTransport surface — what Studio and the sidebar share.
            case "sessions": await this.host.ready().catch(() => {}); return this.host.sessions();
            case "createSession": {
                const registry = await this.host.ready();
                const entry = await registry.create(str("title") || "Untitled session");
                if (entry.status === "failed") throw new Error(entry.error ?? "The session could not start.");
                return { id: entry.id, branch: entry.branch, title: entry.title };
            }
            case "reviewSession": {
                const result = await (await this.host.ready()).review(str("id"));
                if ("error" in result) throw new Error(result.error);
                return result;
            }
            case "landSession": {
                const result = await (await this.host.ready()).land(str("id"));
                if (!result.ok) throw new Error(result.error ?? "Could not land the session.");
                return result;
            }
            case "closeSession": {
                const result = await (await this.host.ready()).close(str("id"), { discardChanges: !!p.discardChanges });
                if (!result.ok) throw new Error(result.error ?? "Could not close the session.");
                if (result.keptWorktree) void vscode.window.showInformationMessage(`Kept the session's uncommitted changes in ${result.keptWorktree}.`);
                return result;
            }
            case "files": return (await this.viewed()).files(str("query"));
            case "prompt": {
                const session = await this.host.sessionForTurn(this.viewing);
                if (session.isRunning()) throw new Error("A turn is already running — stop it first.");
                // Not awaited: the turn streams back as events. prompt() turns
                // its own failures into notices on the stream.
                void session.prompt(str("text")).catch(() => {});
                return { ok: true };
            }
            case "shell": {
                const session = await this.viewed();
                void session.runShell(str("command")).catch(() => {});
                return { ok: true };
            }
            case "mention": return (await this.viewed()).mention((p.paths as string[] | undefined) ?? []);
            case "interrupt": return { interrupted: (await this.viewed()).interrupt() };
            case "approve": {
                const decision = str("decision") as ApprovalDecision;
                if (!DECISIONS.includes(decision)) throw new Error(`Unknown decision: ${decision}`);
                return { ok: (await this.viewed()).approve(str("id"), decision) };
            }
            case "setMode": {
                const mode = str("mode") as ApprovalMode;
                if (!MODES.includes(mode)) throw new Error(`Unknown approval mode: ${mode}`);
                await this.host.setMode(this.viewing, mode);
                return { mode };
            }
            case "compact": await (await this.viewed()).compact(); return { ok: true };
            case "reset": await this.host.newConversation(this.viewing); return { ok: true };
            case "rewind": await (await this.viewed()).rewind(str("hash")); return { ok: true };
            case "context": {
                const session = await this.viewed();
                const action = str("action");
                const id = str("entryId");
                if (action === "pin") return { ok: session.pin(id) };
                if (action === "unpin") return { ok: session.unpin(id) };
                if (action === "evict") return { ok: session.evict(id) };
                if (action === "restore") return { ok: session.restore(id) };
                throw new Error(`Unknown context action: ${action}`);
            }

            // The editor around the agent.
            case "openFile": return this.openFile(str("path"), Number(p.line ?? 0));
            case "openEdit": return this.review.openDiff(str("id"));
            case "openChanges": return this.review.openChanges((p.ids as string[] | undefined) ?? [], str("title") || "Agent changes");
            case "undoEdit": await this.review.undo(str("id")); return { status: this.review.get(str("id"))?.status ?? "applied" };
            case "redoEdit": await this.review.redo(str("id")); return { status: this.review.get(str("id"))?.status ?? "applied" };
            case "editStatus": return Object.fromEntries(((p.ids as string[] | undefined) ?? []).map(id => [id, this.review.get(id)?.status ?? null]));
            case "confirm": {
                const ok = str("confirmLabel") || "Continue";
                return (await vscode.window.showWarningMessage(str("message"), { modal: true }, ok)) === ok;
            }
            case "ask": return (await vscode.window.showInputBox({ prompt: str("message"), placeHolder: str("placeholder") })) ?? null;
            case "pickFile": {
                const session = await this.viewed();
                const picked = await vscode.window.showQuickPick(session.files("", 5000), { title: "Add a file to the conversation", placeHolder: "Search indexed files" });
                return picked ?? null;
            }
            case "copy": await vscode.env.clipboard.writeText(str("text")); return { ok: true };
            case "history": return this.host.history();
            case "resume": await this.host.resume(str("id")); return { ok: true };
            case "deleteHistory": return { ok: this.host.deleteHistory(str("id")) };
            case "search": return this.search(str("query"));
            case "command": return this.runCommand(str("name"));
            default:
                throw new Error(`Unknown method: ${method}`);
        }
    }

    private async openFile(relPath: string, line: number): Promise<void> {
        if (!relPath) return;
        const root = this.host.workspaceOf(this.viewing) ?? ContextService.getInstance().getIndexWorkspaceRoot();
        const uri = vscode.Uri.file(path.isAbsolute(relPath) ? relPath : path.resolve(root, relPath));
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: this.surface === "studio" ? vscode.ViewColumn.Beside : undefined });
        if (line > 0) {
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
    }

    private async search(query: string): Promise<SearchHit[]> {
        const results = await ContextService.getInstance().searchRaw(query);
        return results.map(r => ({
            path: r.chunk.path, startLine: r.chunk.startLine, endLine: r.chunk.endLine, score: r.score, contents: r.chunk.contents,
        }));
    }

    /** The few extension commands a webview may trigger — an allowlist, not a passthrough. */
    private async runCommand(name: string): Promise<void> {
        const allowed: Record<string, string> = {
            settings: "openContext.openSettings",
            index: "openContext.indexWorkspace",
            studio: "openContext.openTrace",
            llmKey: "openContext.setLLMApiKey",
            health: "openContext.showIndexHealth",
            folder: "vscode.openFolder",
        };
        const command = allowed[name];
        if (!command) throw new Error(`Unknown command: ${name}`);
        await vscode.commands.executeCommand(command);
    }
}
