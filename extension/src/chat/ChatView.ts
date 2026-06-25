import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AgentService } from "../services/AgentService";
import { ContextService } from "../services/ContextService";
import { ChatHistoryStore } from "../services/ChatHistoryStore";
import { EditReviewService } from "../services/EditReviewService";
import { chatBody } from "./chat-html";
import { VSCodeEditApplier } from "../services/VSCodeEditApplier";
import { SearchResult } from "../../../src/core/types";
import { EditProposal } from "../../../src/agent/types";
import { unifiedDiff } from "../../../src/core/diff";

type ChatMode = "agent" | "search";

const ACTIVE_SESSION_KEY = "openContext.activeChatSession";

function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

const TOOL_LABELS: Record<string, { running: string; done: string }> = {
    "codebase-retrieval": { running: "Searching codebase", done: "Searched codebase" },
    "read-file": { running: "Reading file", done: "Read file" },
    "list-files": { running: "Listing files", done: "Listed files" },
    "view-range": { running: "Viewing file", done: "Viewed file" },
    "str-replace": { running: "Editing file", done: "Edited file" },
    "create-file": { running: "Creating file", done: "Created file" },
    "remove-file": { running: "Removing file", done: "Removed file" },
    "run-command": { running: "Running command", done: "Ran command" },
    "web-search": { running: "Searching the web", done: "Searched the web" },
};

export class ChatView implements vscode.WebviewViewProvider {
    public static readonly viewType = "openContext.chat";
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _agent: AgentService = new AgentService();
    private _abort: AbortController | null = null;
    private _busy = false;
    private _history?: ChatHistoryStore;
    private _sessionId: string | null = null;
    private _pendingAssistant: string[] = [];
    private _review: EditReviewService;
    private _extCtx?: vscode.ExtensionContext;

    constructor(extensionUri: vscode.Uri, extCtx?: vscode.ExtensionContext, review?: EditReviewService) {
        this._extensionUri = extensionUri;
        this._extCtx = extCtx;
        if (extCtx) this._history = new ChatHistoryStore(extCtx);
        this._review = review ?? new EditReviewService(async () => (await ContextService.getInstance().getContext()).getWorkspaceRoot());
        const last = extCtx?.workspaceState.get<string>(ACTIVE_SESSION_KEY);
        if (last && this._history?.get(last)) this._sessionId = last;
    }

    private _setSessionId(id: string | null): void {
        this._sessionId = id;
        void this._extCtx?.workspaceState.update(ACTIVE_SESSION_KEY, id ?? undefined);
    }

    public getReview(): EditReviewService {
        return this._review;
    }

    public getAgentService(): AgentService {
        return this._agent;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case "ready":
                    this._sendModelInfo();
                    await this._sendConfig();
                    this._sendHistoryList();
                    this._sendLicense();
                    this._sendContext();
                    this._restoreActiveSession();
                    break;
                case "query":
                    if (msg.text?.trim()) {
                        const mode: ChatMode = msg.mode === "search" ? "search" : "agent";
                        if (mode === "search") {
                            if (msg.multi) await this._processMultiSearch(msg.text.trim());
                            else await this._processSearch(msg.text.trim());
                        } else this._processQuery(msg.text.trim());
                    }
                    break;
                case "cancel":
                    this._abort?.abort();
                    break;
                case "insertCode": {
                    const editor = vscode.window.activeTextEditor;
                    if (editor && msg.code) await editor.edit(e => e.insert(editor.selection.active, msg.code));
                    break;
                }
                case "copyText":
                    if (msg.text) await vscode.env.clipboard.writeText(String(msg.text));
                    break;
                case "openFile":
                    if (msg.path) await this._openFile(String(msg.path), Number(msg.line ?? 0));
                    break;
                case "openDiff":
                    if (msg.id) await this._review.openDiff(String(msg.id));
                    break;
                case "undoEdit":
                    if (msg.id) await this._handleUndo([String(msg.id)]);
                    break;
                case "redoEdit":
                    if (msg.id) await this._handleRedo(String(msg.id));
                    break;
                case "undoEdits":
                    if (Array.isArray(msg.ids)) await this._handleUndo(msg.ids.map(String));
                    break;
                case "clear":
                    this.clearChat();
                    break;
                case "openSettings":
                    vscode.commands.executeCommand("workbench.action.openSettings", "openContext");
                    break;
                case "chooseIndexWorkspace":
                    await vscode.commands.executeCommand("openContext.selectIndexWorkspace");
                    await this._sendConfig();
                    break;
                case "setLLMKey":
                    vscode.commands.executeCommand("openContext.setLLMApiKey");
                    break;
                case "setMode":
                    break;
                case "setLLMSelection":
                    if (msg.provider && msg.model) {
                        await ContextService.getInstance().setLLMSelection(String(msg.provider), String(msg.model));
                        this._sendModelInfo();
                    }
                    break;
                case "saveLLMKey":
                    if (typeof msg.apiKey === "string") {
                        await ContextService.getInstance().setLLMApiKey(msg.apiKey, msg.provider ? String(msg.provider) : undefined);
                        await this._sendConfig();
                    }
                    break;
                case "setLLMBaseUrl":
                    if (typeof msg.baseUrl === "string") {
                        await ContextService.getInstance().setLLMBaseUrl(String(msg.baseUrl));
                        await this._sendConfig();
                    }
                    break;
                case "saveEmbeddingKey":
                    if (typeof msg.apiKey === "string") {
                        await ContextService.getInstance().setEmbeddingApiKey(msg.apiKey);
                        await this._sendConfig();
                    }
                    break;
                case "getConfig":
                    await this._sendConfig();
                    break;
                case "listHistory":
                    this._sendHistoryList();
                    break;
                case "loadHistory":
                    if (msg.id) this._loadSession(String(msg.id));
                    break;
                case "newSession":
                    this._startNewSession();
                    break;
                case "deleteHistory":
                    if (msg.id) {
                        this._history?.delete(String(msg.id));
                        if (this._sessionId === msg.id) this._startNewSession();
                        this._sendHistoryList();
                    }
                    break;
                case "setWebSearchKey":
                    if (typeof msg.apiKey === "string") {
                        await ContextService.getInstance().setWebSearchApiKey(msg.apiKey);
                        await this._sendConfig();
                    }
                    break;
                case "getLicense":
                    this._sendLicense();
                    break;
                case "activateLicense":
                    if (typeof msg.key === "string") {
                        const r = ContextService.getInstance().activateLicense(msg.key.trim());
                        if (r.ok) vscode.window.showInformationMessage(`Activated ${r.status.plan} license.`);
                        else vscode.window.showErrorMessage(`Activation failed: ${r.error}`);
                        this._sendLicense();
                    }
                    break;
                case "deactivateLicense":
                    ContextService.getInstance().deactivateLicense();
                    vscode.window.showInformationMessage("License removed — running as Community edition.");
                    this._sendLicense();
                    break;
                case "openExternal":
                    if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
                    break;
                case "pickContextFile": {
                    try {
                        const ctx = await ContextService.getInstance().getContext();
                        const files = await ctx.listFiles();
                        const picked = await vscode.window.showQuickPick(files, { title: "Add file to context", placeHolder: "Reference a file in your message" });
                        if (picked) this._view?.webview.postMessage({ type: "insertMention", path: picked });
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Could not list files: ${err?.message ?? String(err)}`);
                    }
                    break;
                }
                case "applyCode":
                    if (typeof msg.code === "string") await this._applyCode(msg.code, typeof msg.file === "string" ? msg.file : "");
                    break;
            }
        });
        webviewView.onDidChangeVisibility(() => { if (webviewView.visible) { this._sendModelInfo(); this._sendConfig(); this._sendLicense(); this._sendContext(); } });
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("openContext.llm")) { this._sendModelInfo(); this._sendConfig(); }
        });
        vscode.window.onDidChangeActiveTextEditor(() => this._sendContext());
        vscode.window.onDidChangeTextEditorSelection(() => this._sendContext());
    }

    public focus(): void {
        this._view?.show(true);
    }

    public addMessage(text: string): void {
        this._view?.webview.postMessage({ type: "addUserMessage", text });
        this._processQuery(text);
    }

    public clearChat(): void {
        this._startNewSession();
    }

    public refreshConfig(): void {
        void this._sendConfig();
    }

    public refreshLicense(): void {
        this._sendLicense();
    }

    private _sendLicense(): void {
        this._view?.webview.postMessage({ type: "license", status: ContextService.getInstance().getLicenseStatus() });
    }

    private _sendContext(): void {
        const ed = vscode.window.activeTextEditor;
        let activeFile = "";
        if (ed) {
            const root = ContextService.getInstance().getIndexWorkspaceRoot();
            const rel = root ? path.relative(root, ed.document.uri.fsPath).replace(/\\/g, "/") : "";
            activeFile = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(ed.document.uri.fsPath);
        }
        const hasSelection = !!ed && !ed.selection.isEmpty;
        this._view?.webview.postMessage({ type: "context", activeFile, hasSelection });
    }

    private async _applyCode(code: string, file: string): Promise<void> {
        if (!file) {
            const editor = vscode.window.activeTextEditor;
            if (editor) await editor.edit(e => e.insert(editor.selection.active, code));
            else vscode.window.showWarningMessage("Open a file to insert into, or tag the code block with a path, e.g. ```ts src/foo.ts");
            return;
        }
        try {
            const ctx = await ContextService.getInstance().getContext();
            const root = ctx.getWorkspaceRoot();
            const abs = path.resolve(root, file);
            let oldContents = "", exists = true;
            try { oldContents = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(abs))); } catch { exists = false; }
            await new VSCodeEditApplier(root).writeFile(file, code);
            try { await ctx.addFiles([{ path: file, contents: code }]); } catch {}
            const edit: EditProposal = {
                id: "apply-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                kind: exists ? "str-replace" : "create",
                path: file,
                oldContents: exists ? oldContents : undefined,
                newContents: code,
                diff: unifiedDiff(oldContents, code),
            };
            this._review.record(edit);
            this._view?.webview.postMessage({ type: "edit", edit: { id: edit.id, path: edit.path, kind: edit.kind, diff: edit.diff } });
            vscode.window.showInformationMessage(`Applied to ${file}.`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Apply failed: ${err?.message ?? String(err)}`);
        }
    }

    private _startNewSession(): void {
        this._abort?.abort();
        this._agent.reset();
        this._review.clear();
        this._setSessionId(null);
        this._pendingAssistant = [];
        this._view?.webview.postMessage({ type: "clear" });
        this._sendHistoryList();
    }

    private _ensureSession(): string | null {
        if (!this._history) return null;
        if (this._sessionId) return this._sessionId;
        const cfg = vscode.workspace.getConfiguration("openContext");
        const provider = cfg.get<string>("llm.provider", "openai");
        const model = cfg.get<string>("llm.model", "") || defaultModelFor(provider);
        const s = this._history.create(provider, model);
        this._setSessionId(s.id);
        return s.id;
    }

    private _sendHistoryList(): void {
        if (!this._history) return;
        this._view?.webview.postMessage({ type: "history_list", sessions: this._history.list(), currentId: this._sessionId });
    }

    private _loadSession(id: string): void {
        if (!this._history) return;
        const s = this._history.get(id);
        if (!s) return;
        this._abort?.abort();
        this._agent.reset();
        this._review.clear();
        this._setSessionId(s.id);
        this._pendingAssistant = [];
        this._view?.webview.postMessage({
            type: "history_load",
            session: { id: s.id, title: s.title, provider: s.provider, model: s.model, messages: s.messages },
        });
        this._sendHistoryList();
    }

    private _sendModelInfo(): void {
        const cfg = vscode.workspace.getConfiguration("openContext");
        const provider = cfg.get<string>("llm.provider", "openai");
        const model = cfg.get<string>("llm.model", "") || defaultModelFor(provider);
        this._view?.webview.postMessage({ type: "model", provider, model });
    }

    private async _sendConfig(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        const provider = cfg.get<string>("llm.provider", "openai");
        const model = cfg.get<string>("llm.model", "") || defaultModelFor(provider);
        const baseUrl = cfg.get<string>("llm.baseUrl", "");
        const embeddingProvider = cfg.get<string>("embedding.provider", "voyage");
        const embeddingModel = cfg.get<string>("embedding.model", "");
        const svc = ContextService.getInstance();
        const hasKey: Record<string, boolean> = {
            openai: await svc.hasLLMApiKey("openai"),
            anthropic: await svc.hasLLMApiKey("anthropic"),
            google: await svc.hasLLMApiKey("google"),
            custom: await svc.hasLLMApiKey("custom"),
        };
        const hasWebSearchKey = await svc.hasWebSearchApiKey();
        const hasEmbeddingKey = await svc.hasEmbeddingApiKey();
        this._view?.webview.postMessage({
            type: "config",
            provider,
            model,
            baseUrl,
            hasKey,
            hasWebSearchKey,
            hasEmbeddingKey,
            embeddingProvider,
            embeddingModel,
            indexWorkspaceRoot: svc.getIndexWorkspaceRoot(),
        });
    }

    private async _processSearch(query: string): Promise<void> {
        const post = (m: any) => this._view?.webview.postMessage(m);
        this._busy = true;
        const sessionId = this._ensureSession();
        if (sessionId) this._history?.appendMessage(sessionId, "user", `[search] ${query}`);
        post({ type: "search_start" });
        try {
            const results = await ContextService.getInstance().searchRaw(query);
            post({ type: "search_result", results: results.map((r: SearchResult) => ({
                path: r.chunk.path,
                startLine: r.chunk.startLine,
                endLine: r.chunk.endLine,
                score: r.score,
                contents: r.chunk.contents,
            })) });
            if (sessionId) {
                const summary = results.slice(0, 5).map(r => `- ${r.chunk.path}:${r.chunk.startLine}-${r.chunk.endLine}`).join("\n");
                this._history?.appendMessage(sessionId, "assistant", `Found ${results.length} result${results.length === 1 ? "" : "s"}${summary ? "\n" + summary : ""}`);
            }
        } catch (err: any) {
            post({ type: "error", text: err?.message ?? String(err) });
        } finally {
            this._busy = false;
            post({ type: "done" });
            this._sendHistoryList();
        }
    }

    private async _processMultiSearch(query: string): Promise<void> {
        const post = (m: any) => this._view?.webview.postMessage(m);
        this._busy = true;
        const sessionId = this._ensureSession();
        if (sessionId) this._history?.appendMessage(sessionId, "user", `[multi-repo search] ${query}`);
        post({ type: "search_start" });
        try {
            const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
            if (!folders.length) throw new Error("Open a folder (or a multi-root workspace) to search across repos.");
            const results = await ContextService.getInstance().multiRepoSearch(query, folders);
            post({ type: "search_result", results: results.map((r) => ({
                path: r.chunk.path,
                startLine: r.chunk.startLine,
                endLine: r.chunk.endLine,
                score: r.score,
                contents: r.chunk.contents,
                repo: r.repo,
            })) });
            if (sessionId) {
                const summary = results.slice(0, 5).map(r => `- [${r.repo}] ${r.chunk.path}:${r.chunk.startLine}-${r.chunk.endLine}`).join("\n");
                this._history?.appendMessage(sessionId, "assistant", `Found ${results.length} result${results.length === 1 ? "" : "s"} across repos${summary ? "\n" + summary : ""}`);
            }
        } catch (err: any) {
            post({ type: "error", text: err?.message ?? String(err) });
        } finally {
            this._busy = false;
            post({ type: "done" });
            this._sendHistoryList();
        }
    }

    private async _handleUndo(ids: string[]): Promise<void> {
        const post = (m: any) => this._view?.webview.postMessage(m);
        for (const id of ids) {
            try {
                await this._review.undo(id);
                post({ type: "edit_status", id, status: "undone" });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Undo failed: ${err?.message ?? String(err)}`);
            }
        }
    }

    private async _handleRedo(id: string): Promise<void> {
        try {
            await this._review.redo(id);
            this._view?.webview.postMessage({ type: "edit_status", id, status: "applied" });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Redo failed: ${err?.message ?? String(err)}`);
        }
    }

    private _restoreActiveSession(): void {
        if (!this._history || !this._sessionId) return;
        const s = this._history.get(this._sessionId);
        if (!s || !s.messages.length) return;
        this._view?.webview.postMessage({
            type: "history_load",
            session: { id: s.id, title: s.title, provider: s.provider, model: s.model, messages: s.messages },
        });
    }

    private async _openFile(relPath: string, line: number): Promise<void> {
        const ctx = await ContextService.getInstance().getContext();
        const uri = vscode.Uri.file(path.resolve(ctx.getWorkspaceRoot(), relPath));
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const ed = await vscode.window.showTextDocument(doc, { preview: false });
            if (line > 0) {
                const pos = new vscode.Position(Math.max(0, line - 1), 0);
                ed.selection = new vscode.Selection(pos, pos);
                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Could not open ${relPath}: ${err.message}`);
        }
    }

    private async _processQuery(query: string): Promise<void> {
        if (this._busy) this._abort?.abort();
        this._busy = true;
        this._abort = new AbortController();
        const sessionId = this._ensureSession();
        if (sessionId) this._history?.appendMessage(sessionId, "user", query);
        this._pendingAssistant = [];
        const turnEdits: string[] = [];
        const post = (msg: any) => this._view?.webview.postMessage(msg);
        const flush = () => {
            const text = this._pendingAssistant.join("");
            this._pendingAssistant = [];
            if (sessionId && text.trim()) this._history?.appendMessage(sessionId, "assistant", text);
            if (turnEdits.length) post({ type: "edit_summary", ids: [...turnEdits] });
            this._sendHistoryList();
        };
        try {
            post({ type: "task_plan", plan: buildTaskPlan(query) });
            await this._agent.run(query, {
                onText: (delta) => { this._pendingAssistant.push(delta); post({ type: "chunk", text: delta }); },
                onToolCall: (info) => {
                    const labels = TOOL_LABELS[info.name];
                    const base = labels ? (info.status === "running" ? labels.running : labels.done) : info.name;
                    const label = info.status === "error" ? `${base} failed` : base;
                    post({ type: "tool_update", id: info.id, name: info.name, status: info.status, label, summary: info.summary, args: info.args });
                },
                onEdit: (edit) => {
                    this._review.record(edit);
                    turnEdits.push(edit.id);
                    post({ type: "edit", edit: { id: edit.id, path: edit.path, kind: edit.kind, diff: edit.diff, replacedOccurrences: edit.replacedOccurrences } });
                },
                onRetry: (info) => post({ type: "retry", attempt: info.attempt, delayMs: info.delayMs, reason: info.reason }),
                onCompaction: (info) => post({ type: "compaction", dropped: info.dropped }),
                onStep: (info) => post({ type: "agent_step", step: info.step, status: info.status }),
                onSources: (files) => post({ type: "sources", files }),
                onModelSelected: (tier) => post({ type: "model_routed", tier }),
                onDone: () => { post({ type: "done" }); this._busy = false; flush(); },
                onError: (err) => { post({ type: "error", text: err.message }); this._busy = false; flush(); },
            }, this._abort.signal);
        } catch (err: any) {
            post({ type: "error", text: err?.message ?? String(err) });
            this._busy = false;
            flush();
        }
    }

    private _getHtml(): string {
        const nonce = getNonce();
        const distDir = vscode.Uri.joinPath(this._extensionUri, "dist");
        let js = "", css = "";
        try { js = fs.readFileSync(vscode.Uri.joinPath(distDir, "webview.js").fsPath, "utf8"); } catch {}
        try { css = fs.readFileSync(vscode.Uri.joinPath(distDir, "webview.css").fsPath, "utf8"); } catch {}
        if (!js) {
            return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground)">Open Context: webview assets are missing. Run <code>npm run build</code> in <code>extension/</code>.</body></html>`;
        }
        const cspSource = this._view?.webview.cspSource ?? "";
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
<style>${css}</style>
</head>
<body>
${chatBody}
<script nonce="${nonce}">${js}</script>
</body>
</html>`;
    }
}

function buildTaskPlan(query: string): string[] {
    const q = query.toLowerCase();
    const plan = ["Ground the request with codebase retrieval", "Inspect the most relevant files and symbols"];
    if (/fix|error|bug|fail|broken|issue|ts[0-9]{4}/.test(q)) plan.push("Identify the failing path and apply a minimal fix");
    if (/add|implement|change|update|refactor|option|feature|ui/.test(q)) plan.push("Make focused code changes and keep existing patterns");
    if (/test|lint|build|verify|make sure|works/.test(q) || /fix|add|implement|change|update/.test(q)) plan.push("Run the smallest relevant validation command");
    plan.push("Summarize changes, validation, and any follow-up risks");
    return [...new Set(plan)].slice(0, 6);
}

function defaultModelFor(provider: string): string {
    if (provider === "anthropic") return "claude-opus-4-7";
    if (provider === "openai") return "gpt-5.4";
    if (provider === "google") return "gemini-3.1-pro-preview";
    if (provider === "custom") return "";
    return provider;
}
