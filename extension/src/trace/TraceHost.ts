import * as path from "path";
import * as vscode from "vscode";
import { OpenContext } from "../../../src/core/context";
import { AuditLogger, defaultAuditDir } from "../../../src/core/audit";
import { policyRequiresAudit } from "../../../src/core/policy";
import { getLicense, isEntitled } from "../../../src/core/license";
import { SessionStore } from "../../../src/agent/session-store";
import { SessionMemory } from "../../../src/agent/session-memory";
import { ModelRouter, defaultRoutingConfig } from "../../../src/agent/model-router";
import type { ApprovalMode } from "../../../src/agent/permissions";
import type { ContextAgent } from "../../../src/agent/agent";
import { assembleAgentStack } from "../../../src/trace/stack";
import { SessionRegistry, type BuiltSessionHandle } from "../../../src/trace/registry";
import { WorktreeManager } from "../../../src/trace/worktree";
import type { TraceSession } from "../../../src/trace/session";
import { ContextService } from "../services/ContextService";
import type { EditReviewService, EditScope } from "../services/EditReviewService";
import { VSCodeEditApplier } from "../services/VSCodeEditApplier";
import { readAgentSettings, saveApprovalMode, SetupError, type AgentSettings } from "./agent-settings";
import { migrateLegacyChats } from "./legacy-history";
import type { HistoryRow, HostState, SessionRow, SetupNeed } from "./protocol";

const ACTIVE_SESSION_KEY = "openContext.trace.activeSession";

/** What a built session was made from — compared before every turn. */
interface BuildStamp {
    fingerprint: string;
    apiKey: string;
    webSearchKey: string | null;
    /** ContextService reopens its store on some settings changes; tools built
     *  against the old one would query a closed database. Primary only. */
    generation: number | null;
    root: string;
}

interface Built {
    session: TraceSession;
    /** Held so a rebuild can carry the conversation over (exportSession). */
    agent: ContextAgent;
    stamp: BuildStamp;
    /** The saved-session store this conversation persists to. */
    store: SessionStore;
    workspace: string;
    /** The index the session searches; the primary's belongs to ContextService. */
    ctx: OpenContext;
    primary: boolean;
    branch?: string;
    memory?: SessionMemory;
}

/**
 * The agent, as the extension host runs it: one TraceSession per conversation,
 * built by the same `assembleAgentStack` the CLI uses, inside a SessionRegistry
 * so parallel sessions can each run in their own git worktree.
 *
 * Webviews never touch any of this directly — they subscribe through a
 * TraceBridge. Rebuilding a session (a model change, a new chat, a resumed
 * one) swaps it inside the registry and fires `onDidReset`, which each bridge
 * turns into "drop your view state and resubscribe".
 */
export class TraceHost implements vscode.Disposable {
    private registry: SessionRegistry | null = null;
    private starting: Promise<SessionRegistry> | null = null;
    private builds = new Map<string, Built>();
    private setupNeed: SetupNeed | null = null;
    private parallel = false;
    private disposables: vscode.Disposable[] = [];
    private refreshing: Promise<void> | null = null;

    private readonly sessionsEmitter = new vscode.EventEmitter<void>();
    private readonly resetEmitter = new vscode.EventEmitter<{ from: string; to: string }>();
    private readonly stateEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeSessions = this.sessionsEmitter.event;
    readonly onDidReset = this.resetEmitter.event;
    readonly onDidChangeState = this.stateEmitter.event;
    private readonly startEmitter = new vscode.EventEmitter<void>();
    /** The primary session came up — after a setup gate cleared, say. */
    readonly onDidStart = this.startEmitter.event;

    constructor(private readonly review: EditReviewService, private readonly extCtx?: vscode.ExtensionContext) {
        // API keys live in SecretStorage, which no configuration event covers:
        // saving the missing key has to clear the setup gate by itself.
        if (extCtx?.secrets?.onDidChange) {
            this.disposables.push(extCtx.secrets.onDidChange(() => { this.stateEmitter.fire(); void this.refresh(); }));
        }
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (!e.affectsConfiguration("openContext")) return;
                this.stateEmitter.fire();
                void this.refresh();
            }),
            vscode.window.onDidChangeActiveTextEditor(() => this.stateEmitter.fire()),
            vscode.window.onDidChangeTextEditorSelection(() => this.stateEmitter.fire()),
        );
    }

    // ─── access ──────────────────────────────────────────────────────────────

    /** The registry, starting the primary session on first use. Throws SetupError. */
    async ready(): Promise<SessionRegistry> {
        if (this.registry) return this.registry;
        if (!this.starting) {
            this.starting = this.start().then(
                registry => {
                    this.registry = registry;
                    this.setupNeed = null;
                    this.stateEmitter.fire();
                    this.startEmitter.fire();
                    return registry;
                },
                err => { this.starting = null; this.setupNeed = toSetupNeed(err); this.stateEmitter.fire(); throw err; },
            );
        }
        return this.starting;
    }

    /** A session by id, or the active one. Undefined until started. */
    session(id: string | null): TraceSession | undefined {
        if (!this.registry) return undefined;
        return id ? this.registry.get(id) : this.registry.active();
    }

    /** The session a prompt should run on, rebuilt first if its settings went stale. */
    async sessionForTurn(id: string | null): Promise<TraceSession> {
        const registry = await this.ready();
        const sessionId = id ?? registry.activeId_();
        if (!sessionId) throw new Error("No session.");
        await this.rebuildIfStale(sessionId);
        const session = this.session(this.currentId(sessionId));
        if (!session) throw new Error("That session is no longer open.");
        return session;
    }

    sessions(): { sessions: SessionRow[]; parallel: boolean } {
        return { sessions: (this.registry?.list() ?? []) as SessionRow[], parallel: this.parallel };
    }

    workspaceOf(id: string | null): string | undefined {
        const sessionId = id ?? this.registry?.activeId_() ?? null;
        return sessionId ? this.builds.get(sessionId)?.workspace : undefined;
    }

    async state(): Promise<HostState> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        const svc = ContextService.getInstance();
        const provider = cfg.get<string>("llm.provider", "openai");
        const active = this.registry?.activeId_();
        const meta = active ? this.registry?.get(active)?.meta() : undefined;
        const license = svc.getLicenseStatus() as { plan?: string; valid?: boolean };
        return {
            setup: this.setupNeed,
            provider: meta?.provider ?? provider,
            model: meta?.model ?? "",
            plan: license?.valid ? license.plan ?? "free" : "free",
            ...editorContext(svc.getIndexWorkspaceRoot()),
            parallel: this.parallel,
            shellEnabled: cfg.get<boolean>("agent.shell.enabled", false),
        };
    }

    /** Something only the host knows changed (license, index root): re-push state. */
    notifyStateChanged(): void {
        this.stateEmitter.fire();
    }

    /** Clear the primary session's remembered insights. Null when memory is off
     *  or nothing has been built yet (the caller then clears the file itself). */
    clearMemories(): number | null {
        const memory = this.primary()?.memory;
        return memory ? memory.clearAll() : null;
    }

    // ─── conversations ───────────────────────────────────────────────────────

    /** Saved conversations of the primary checkout, newest first. */
    history(): HistoryRow[] {
        const primary = this.primary();
        return primary ? primary.store.list() : [];
    }

    deleteHistory(id: string): boolean {
        const primary = this.primary();
        return primary ? primary.store.remove(id) : false;
    }

    /** A fresh conversation. In the primary checkout that is a new saved
     *  session; a parallel session keeps its worktree and starts over in it. */
    async newConversation(id: string | null): Promise<void> {
        const registry = await this.ready();
        const sessionId = id ?? registry.activeId_();
        const built = sessionId ? this.builds.get(sessionId) : undefined;
        if (!sessionId || !built) return;
        if (built.session.isRunning()) built.session.interrupt();
        if (!built.primary) { built.session.reset(); return; }
        this.review.clear();
        await this.rebuild(sessionId, { newId: built.store.newId() });
    }

    /** Continue a saved conversation in the primary checkout. */
    async resume(savedId: string): Promise<void> {
        await this.ready();
        const primary = this.primary();
        if (!primary) throw new Error("No primary session.");
        if (primary.session.isRunning()) throw new Error("Stop the running turn first.");
        const saved = primary.store.load(savedId);
        if (!saved) throw new Error("That conversation is no longer saved.");
        this.review.clear();
        await this.rebuild(this.primaryId()!, { newId: saved.id, restore: { session: saved.session, title: saved.title } });
    }

    async setMode(id: string | null, mode: ApprovalMode): Promise<void> {
        // Every open session follows, so the mode the composer shows is the
        // mode any session you switch to is in.
        for (const built of this.builds.values()) built.session.setMode(mode);
        void id;
        await saveApprovalMode(mode);
    }

    // ─── building ────────────────────────────────────────────────────────────

    private async start(): Promise<SessionRegistry> {
        const svc = ContextService.getInstance();
        let ctx: OpenContext;
        try {
            ctx = await svc.getContext();
        } catch (err: any) {
            const message = String(err?.message ?? err);
            if (/workspace folder/i.test(message)) throw new SetupError({ kind: "no-workspace", message: "Open a folder to start the agent." });
            throw err;
        }
        const settings = await readAgentSettings();
        const root = ctx.getWorkspaceRoot();

        // Parallel sessions need git worktrees for isolation: two agents editing
        // one checkout see each other's half-finished edits.
        const worktrees = new WorktreeManager({ repoRoot: root });
        this.parallel = await worktrees.isRepo();
        const mainBranch = this.parallel ? (await worktrees.list()).find(w => w.main)?.branch : undefined;

        const registry = new SessionRegistry({
            ...(this.parallel ? { worktrees } : {}),
            build: spec => this.buildSibling(spec, settings),
        });
        registry.onChange(() => this.sessionsEmitter.fire());

        // Pick up the conversation this window was last in.
        const store = SessionStore.forWorkspace(root);
        migrateLegacyChats(this.extCtx?.workspaceState, store);
        const lastId = this.extCtx?.workspaceState.get<string>(ACTIVE_SESSION_KEY);
        const saved = lastId ? store.load(lastId) : null;
        const id = saved?.id ?? store.newId();
        const built = this.buildStack({
            id, ctx, workspace: root, store, settings, primary: true, branch: mainBranch,
            ...(saved ? { restore: { session: saved.session, title: saved.title } } : {}),
        });
        this.builds.set(id, built);
        void this.extCtx?.workspaceState.update(ACTIVE_SESSION_KEY, id);
        // The primary's index belongs to ContextService; closing the session
        // must not close it.
        registry.adopt(id, { session: built.session, close: async () => {} }, {
            title: mainBranch ?? path.basename(root), workspace: root, branch: mainBranch,
        });
        return registry;
    }

    /** A parallel session: its own worktree, its own index of it. */
    private async buildSibling(
        spec: { id: string; workspace: string; branch?: string; title: string },
        initial: AgentSettings,
    ): Promise<BuiltSessionHandle> {
        const settings = await readAgentSettings().catch(() => initial);
        const svc = ContextService.getInstance();
        const ctx = await OpenContext.create(await svc.getConfigForPath(spec.workspace));
        try {
            // The shared embedding cache makes this mostly cache hits: a fresh
            // worktree is the same files the main index already embedded.
            await ctx.incrementalIndex();
            const built = this.buildStack({
                id: spec.id, ctx, workspace: spec.workspace, store: SessionStore.forWorkspace(spec.workspace),
                settings, primary: false, branch: spec.branch, title: spec.title,
            });
            this.builds.set(spec.id, built);
            return {
                session: built.session,
                close: async () => { this.builds.delete(spec.id); ctx.close(); },
            };
        } catch (err) {
            ctx.close();
            throw err;
        }
    }

    private buildStack(input: {
        id: string;
        ctx: OpenContext;
        workspace: string;
        store: SessionStore;
        settings: AgentSettings;
        primary: boolean;
        branch?: string;
        title?: string;
        restore?: { session: string; title: string };
    }): Built {
        const { ctx, settings, workspace } = input;
        const svc = ContextService.getInstance();
        // Audit: on when the user enabled it (and is entitled), or whenever the
        // workspace/org policy requires it — the policy is the authority.
        const auditRequired = policyRequiresAudit(ctx.getPolicy() ?? undefined);
        let auditOn = auditRequired;
        if (settings.audit && !auditRequired) {
            if (isEntitled(getLicense(), "audit-log")) auditOn = true;
            else warnOnce("openContext.agent.audit.enabled needs an Enterprise license — audit logging stays off. Run 'oce license' to check.");
        }
        let router: ModelRouter | undefined;
        if (settings.routing.enabled && (settings.provider === "openai" || settings.provider === "anthropic")) {
            router = new ModelRouter(defaultRoutingConfig(settings.provider, {
                apiKey: settings.apiKey,
                standardModel: settings.model,
                fastModel: settings.routing.fastModel || undefined,
                reasoningModel: settings.routing.reasoningModel || undefined,
                maxTokens: settings.limits.maxTokens,
            }));
        }
        const scope: EditScope | undefined = input.primary ? undefined : {
            root: workspace,
            reindex: async (p, contents) => {
                if (contents === null) await ctx.removeFromIndex([p]);
                else await ctx.addFiles([{ path: p, contents }]);
            },
        };
        const memory = settings.memory ? new SessionMemory({ storePath: path.join(workspace, ".open-context") }) : undefined;
        const stack = assembleAgentStack({
            ctx,
            workspaceRoot: workspace,
            provider: settings.provider,
            model: settings.model,
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            router,
            memory,
            memorySource: "vscode-agent",
            audit: auditOn ? new AuditLogger({ dir: defaultAuditDir(workspace) }) : undefined,
            applier: new VSCodeEditApplier(workspace),
            mode: this.currentMode() ?? settings.mode,
            includeEdits: settings.includeEdits,
            shell: settings.shell,
            webSearch: settings.webSearch ? { enabled: true, apiKey: settings.webSearchKey } : false,
            retrieveOptions: () => svc.getIdeRetrieveOptionsForCurrentContext(),
            plan: true,
            delegate: true,
            env: true,
            traced: true,
            agent: settings.limits,
            onEdit: edit => this.review.record(edit, scope),
            onPolicyBlock: (_cap, reason) => warnOnce(`Workspace policy: ${reason}.`),
            sessionStore: input.store,
            sessionId: input.id,
            ...(input.restore ? { restore: input.restore.session } : {}),
            meta: {
                ...(input.restore ? { title: input.restore.title } : input.title ? { title: input.title } : {}),
                ...(input.branch ? { branch: input.branch } : {}),
            },
        });
        return {
            session: stack.trace!,
            agent: stack.agent,
            stamp: {
                fingerprint: settings.fingerprint,
                apiKey: settings.apiKey,
                webSearchKey: settings.webSearchKey ?? null,
                generation: input.primary ? svc.getContextGeneration() : null,
                root: workspace,
            },
            store: input.store,
            workspace,
            ctx,
            primary: input.primary,
            branch: input.branch,
            memory,
        };
    }

    /**
     * Replace a session's stack, keeping its place in the registry. With no
     * `newId` the conversation carries over (a settings change); with one it
     * is a new or resumed conversation.
     */
    private async rebuild(id: string, opts: { newId?: string; restore?: { session: string; title: string } } = {}): Promise<void> {
        const registry = await this.ready();
        const old = this.builds.get(id);
        if (!old) return;
        const settings = await readAgentSettings();
        const svc = ContextService.getInstance();
        // The primary follows ContextService's store, which may have reopened.
        const ctx = old.primary ? await svc.getContext() : old.ctx;
        const workspace = old.primary ? ctx.getWorkspaceRoot() : old.workspace;
        const store = old.primary && workspace !== old.workspace ? SessionStore.forWorkspace(workspace) : old.store;
        const nextId = opts.newId ?? id;
        const carried = opts.newId === undefined
            ? { session: old.agent.exportSession(), title: old.session.meta().title || "" }
            : opts.restore;
        const built = this.buildStack({
            id: nextId, ctx, workspace, store, settings, primary: old.primary, branch: old.branch,
            ...(carried && carried.session ? { restore: carried } : {}),
        });
        const close = old.primary ? async () => {} : async () => { this.builds.delete(nextId); ctx.close(); };
        this.builds.delete(id);
        this.builds.set(nextId, built);
        registry.replace(id, { id: nextId, handle: { session: built.session, close } });
        if (old.primary) void this.extCtx?.workspaceState.update(ACTIVE_SESSION_KEY, nextId);
        this.resetEmitter.fire({ from: id, to: nextId });
        this.stateEmitter.fire();
    }

    private async rebuildIfStale(id: string): Promise<void> {
        const built = this.builds.get(id);
        if (!built || built.session.isRunning()) return;
        let settings: AgentSettings;
        try { settings = await readAgentSettings(); } catch { return; }
        const svc = ContextService.getInstance();
        const s = built.stamp;
        const stale = s.fingerprint !== settings.fingerprint
            || s.apiKey !== settings.apiKey
            || s.webSearchKey !== (settings.webSearchKey ?? null)
            || (built.primary && (s.generation !== svc.getContextGeneration() || s.root !== svc.getIndexWorkspaceRoot()));
        if (stale) await this.rebuild(id);
    }

    /** Settings changed: rebuild idle sessions now; a running one is rebuilt
     *  before its next turn (sessionForTurn checks). */
    private async refresh(): Promise<void> {
        if (this.refreshing) return this.refreshing;
        this.refreshing = (async () => {
            try {
                if (!this.registry) {
                    // A key just saved may clear the setup gate.
                    if (this.setupNeed) await this.ready().catch(() => {});
                    return;
                }
                for (const id of [...this.builds.keys()]) await this.rebuildIfStale(id).catch(() => {});
            } finally {
                this.refreshing = null;
            }
        })();
        return this.refreshing;
    }

    private currentId(id: string): string {
        // A rebuild may have handed the entry a new id; the active one is the
        // best answer for a caller still holding the old.
        return this.builds.has(id) ? id : this.registry?.activeId_() ?? id;
    }

    private primary(): Built | undefined {
        for (const built of this.builds.values()) if (built.primary) return built;
        return undefined;
    }

    private primaryId(): string | undefined {
        for (const [id, built] of this.builds) if (built.primary) return id;
        return undefined;
    }

    private currentMode(): ApprovalMode | undefined {
        for (const built of this.builds.values()) return built.session.meta().mode;
        return undefined;
    }

    async dispose(): Promise<void> {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        for (const built of this.builds.values()) if (built.session.isRunning()) built.session.interrupt();
        await this.registry?.closeAll().catch(() => {});
        this.sessionsEmitter.dispose();
        this.resetEmitter.dispose();
        this.stateEmitter.dispose();
        this.startEmitter.dispose();
    }
}

function toSetupNeed(err: unknown): SetupNeed {
    if (err instanceof SetupError) return err.need;
    return { kind: "error", message: String((err as any)?.message ?? err) };
}

function editorContext(root: string): { activeFile: string; hasSelection: boolean } {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return { activeFile: "", hasSelection: false };
    const fsPath = ed.document.uri.fsPath;
    const rel = root ? path.relative(root, fsPath).replace(/\\/g, "/") : "";
    const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    return { activeFile: inside ? rel : "", hasSelection: !ed.selection.isEmpty };
}

const warned = new Set<string>();
/** Each distinct policy/licensing warning once per window, not per turn. */
function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    void vscode.window.showWarningMessage(message);
}
