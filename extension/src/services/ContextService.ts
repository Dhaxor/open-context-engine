import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { OpenContext } from "../../../src/core/context";
import { FileFilter, FilterStats } from "../../../src/core/file-filter";
import { FileWatcher } from "../../../src/core/file-watcher";
import { classifyNativeBindingError, diagnosisOneLiner } from "../../../src/core/native-binding-error";
import { OpenContextConfig, EmbeddingConfig, IndexingResult, EMBEDDING_MODELS, SearchResult, FreshnessReport } from "../../../src/core/types";
import { RetrievalDebugReport, RetrieveOptions } from "../../../src/core/retriever";
import { getLicense, verifyLicenseToken, saveLicenseToken, clearLicense, isEntitled } from "../../../src/core/license";
import { resolveEmbeddingModel } from "../shared/model-settings";

export interface LicenseStatusView { valid: boolean; plan: string; reason: string; inGrace: boolean; daysLeft?: number; org?: string; seats?: number; exp?: number; }

/** The store an index run was writing to was closed under it (a settings
 *  change or key save reopened it). Callers reschedule rather than report. */
export class IndexRunInterruptedError extends Error {
    constructor() {
        super("Indexing was interrupted: the index was reopened with new settings.");
        this.name = "IndexRunInterruptedError";
    }
}

const INDEX_WORKSPACE_ROOT_KEY = "openContext.indexWorkspaceRoot";
const LLM_SELECTION_KEY = "openContext.llmSelection";

export interface ContextStatus {
    indexedFiles: number;
    totalChunks: number;
    embeddingProvider: string;
    embeddingModel: string;
    lastSynced: string;
    workspaceRoot: string;
    /** "keyword-only" when search runs on BM25 alone: no embedding key yet, or sqlite-vec couldn't load. */
    searchMode: "hybrid" | "keyword-only";
    degradedReason?: string;
    /** Why it is keyword-only: "keyword_only" means no embedding key (a choice
     *  the user can undo); anything else is a platform failure. */
    degradedKind?: string;
}

export interface IndexHealthReport {
    generatedAt: string;
    workspaceRoot: string;
    selectedWorkspaceRoot?: string;
    vscodeWorkspaceRoot?: string;
    contextReady: boolean;
    initializationError?: string;
    lastIndexError?: string;
    embedding: { provider: string; model: string; apiKeyRequired: boolean; apiKeyPresent: boolean; dimension: number; batchSize: number };
    index: { storeDir: string; dbPath: string; storeExists: boolean; dbExists: boolean; dbSizeBytes?: number; indexedFiles?: number; totalChunks?: number; potentiallyStale?: boolean };
    fileScan?: FilterStats;
    freshness?: FreshnessReport;
    activeFile?: { path?: string; indexed: boolean; reason?: string };
    notes: string[];
}

export class ContextService implements vscode.Disposable {
    private static _instance: ContextService;
    private _context: OpenContext | null = null;
    private _multiContexts = new Map<string, OpenContext>();
    private _watcher: FileWatcher | null = null;
    private _extContext: vscode.ExtensionContext | null = null;
    private _onReindex = new vscode.EventEmitter<IndexingResult>();
    private _lastIndexError: string | undefined;
    readonly onReindex = this._onReindex.event;
    /** Fires after the embedding key is saved or cleared, from any path: the
     *  command, the settings panel, or the chat's key form. `rebuild`: the
     *  reopened store should be (re)indexed (see needsRebuild). */
    private _onEmbeddingKeyChanged = new vscode.EventEmitter<{ hasKey: boolean; rebuild: boolean }>();
    readonly onEmbeddingKeyChanged = this._onEmbeddingKeyChanged.event;
    /** Bumped whenever the open contexts are closed. Anything that captured an
     *  OpenContext (the chat agent's tools) compares it to know it is stale. */
    private _generation = 0;

    private constructor() {}

    public static getInstance(): ContextService {
        if (!ContextService._instance) ContextService._instance = new ContextService();
        return ContextService._instance;
    }

    public bindExtensionContext(ctx: vscode.ExtensionContext): void {
        this._extContext = ctx;
    }

    public getIndexWorkspaceRoot(): string {
        return this.resolveWorkspaceRoot();
    }

    public async setIndexWorkspaceRoot(dirPath: string): Promise<void> {
        const resolved = this.resolveFsPath(dirPath);
        if (!resolved || !this.pathExists(resolved)) throw new Error(`Workspace path does not exist: ${dirPath}`);
        await this._extContext?.globalState.update(INDEX_WORKSPACE_ROOT_KEY, resolved);
        await this.dispose();
    }

    public async clearIndexWorkspaceRoot(): Promise<void> {
        await this._extContext?.globalState.update(INDEX_WORKSPACE_ROOT_KEY, undefined);
        await this.dispose();
        // Another root: its index history is not this one's.
        this._indexIntent = false;
        this._indexIncomplete = false;
        this._lastIndexedFiles = undefined;
    }

    public async getContext(): Promise<OpenContext> {
        if (this._context) return this._context;
        // One open at a time: callers racing here (the watcher starting while an
        // index command runs) would each create a store, and all but the last
        // would stay open, untracked, until the window closes.
        if (!this._opening) {
            const generation = this._generation;
            const opening = (async () => {
                const ctx = await OpenContext.create(await this.getWorkspaceConfig());
                if (generation !== this._generation) {
                    // Disposed while opening: built from stale settings.
                    ctx.close();
                    return null;
                }
                this._context = ctx;
                return ctx;
            })();
            this._opening = opening;
            // Cleared on success and failure alike, so a failed open is retried.
            // Registered before any caller awaits, so it runs first.
            opening.finally(() => { if (this._opening === opening) this._opening = null; }).catch((err) => {
                // A refused keyword fallback means an index exists on disk (built
                // with a key that isn't set now): the workspace wants one, and it
                // may be behind by whatever changed meanwhile.
                if (err?.name === "KeywordFallbackRefusedError") { this._indexIntent = true; this._indexIncomplete = true; }
            });
        }
        const ctx = await this._opening;
        return ctx ?? this.getContext(); // disposed mid-open: open a current one
    }

    private _opening: Promise<OpenContext | null> | null = null;

    // Whether this workspace should have an index, and whether it is complete.
    // Row counts alone can't tell: an index refused on open, a first index
    // still running, or a rebuild that failed all show zero rows.
    /** An index existed, was built, attempted, or found (refused) this session. */
    private _indexIntent = false;
    /** The last full run failed or was cut off, or the store was refused. */
    private _indexIncomplete = false;
    /** Files the store held after the last completed run, or when it was last
     *  closed holding some (a workspace with none stays 0). */
    private _lastIndexedFiles: number | undefined;

    /**
     * Whether a reopened store should be (re)built: only when this workspace
     * is meant to have an index — never for one that is indexed by hand and
     * never was — and it is missing or incomplete.
     */
    public needsRebuild(indexedFiles: number): boolean {
        if (!this._indexIntent) return false;
        return this._indexIncomplete || (indexedFiles === 0 && this._lastIndexedFiles !== 0);
    }

    /** Generation of the store the latest full index run started on. */
    private _runGeneration = -1;

    /** Whether a full index run has started on the store open now: an
     *  interrupted run needn't schedule another. */
    public indexRunSinceReopen(): boolean {
        return this._runGeneration === this._generation;
    }

    /** Runs a full index against the open store (opening it first; `onOpened`
     *  then runs) and records whether it completed against that store. */
    private async trackIndexRun<T extends IndexingResult>(run: (ctx: OpenContext) => Promise<T>, onOpened?: () => void): Promise<T> {
        this._indexIntent = true;
        this._indexIncomplete = true;
        const ctx = await this.getContext();
        this._runGeneration = this._generation;
        onOpened?.();
        let result: T;
        try {
            result = await run(ctx);
        } catch (err) {
            // Closed under the run: what it threw is the reopen, not a failure.
            if (this._context !== ctx && !(err instanceof vscode.CancellationError)) throw new IndexRunInterruptedError();
            throw err;
        }
        // A reopen mid-run doesn't always make the run throw: writes to the
        // closed store can fail like embed failures and the run returns. Its
        // result describes a store that is gone, so it didn't complete.
        if (this._context !== ctx) throw new IndexRunInterruptedError();
        this._indexIncomplete = false;
        this._lastIndexedFiles = ctx.getStatus().indexedFiles;
        // Partial failures aren't thrown — record them so the health panel shows why.
        this._lastIndexError = result.failed?.length ? result.failedReason : undefined;
        return result;
    }

    public async indexWorkspace(onProgress?: (stage: string, current: number, total: number) => void, token?: vscode.CancellationToken): Promise<IndexingResult> {
        try {
            return await this.trackIndexRun((ctx) =>
                ctx.incrementalIndex((stage, current, total) => {
                    if (token?.isCancellationRequested) throw new vscode.CancellationError();
                    onProgress?.(stage, current, total);
                }),
            );
        } catch (err: any) {
            this.recordIndexError(err);
            throw err;
        }
    }

    /** An interrupted run is rescheduled, not failed: it mustn't overwrite what
     *  the run on the reopened store (possibly already done) recorded. */
    private recordIndexError(err: any): void {
        if (err instanceof IndexRunInterruptedError) return;
        this._lastIndexError = err?.message ?? String(err);
    }

    /** `onReopened` runs once the new root's store is open — the op's own
     *  reopen, which callers must not mistake for an interruption. */
    public async indexDirectory(dirPath: string, onProgress?: (stage: string, current: number, total: number) => void, token?: vscode.CancellationToken, onReopened?: () => void): Promise<IndexingResult> {
        try {
            await this.setIndexWorkspaceRoot(dirPath);
            // A new root starts with no index history of its own.
            this._indexIntent = false;
            this._indexIncomplete = false;
            this._lastIndexedFiles = undefined;
            return await this.trackIndexRun((ctx) =>
                ctx.indexWorkspace((stage, current, total) => {
                    if (token?.isCancellationRequested) throw new vscode.CancellationError();
                    onProgress?.(stage, current, total);
                }),
            onReopened);
        } catch (err: any) {
            this.recordIndexError(err);
            throw err;
        }
    }

    public async startWatching(): Promise<void> {
        if (this._watcher) return;
        // Concurrent callers for the same context share one start rather than
        // creating two watchers; a start begun before a dispose is not reused.
        if (!this._startingWatch || this._startingWatchGeneration !== this._generation) {
            this._startingWatchGeneration = this._generation;
            const starting: Promise<void> = this.createWatcher().finally(() => {
                if (this._startingWatch === starting) this._startingWatch = null;
            });
            this._startingWatch = starting;
        }
        return this._startingWatch;
    }

    private _startingWatch: Promise<void> | null = null;
    private _startingWatchGeneration = -1;

    private async createWatcher(): Promise<void> {
        const generation = this._generation;
        const ctx = await this.getContext();
        const config = await this.getWorkspaceConfig();
        // Disposed while starting: that context is closed, and whoever disposed
        // restarts watching on the new one.
        if (generation !== this._generation) return;
        const watcher = new FileWatcher(ctx, config);
        this._watcher = watcher;
        await watcher.start({
            onReindex: (result) => {
                // Keep the health panel honest in watch mode: a degraded
                // provider mid-session shows as warn; a clean reindex clears it.
                this._lastIndexError = result.failed?.length ? result.failedReason : undefined;
                this._onReindex.fire(result);
            },
            onError: (err) => console.error("[FileWatcher]", err),
        });
        // Stopped or replaced while it was starting (a stop that lands before
        // chokidar exists is a no-op): don't leave it running.
        if (this._watcher !== watcher) await watcher.stop().catch(() => {});
    }

    public async stopWatching(): Promise<void> {
        await this._watcher?.stop();
        this._watcher = null;
    }

    public async getStatus(): Promise<ContextStatus> {
        const ctx = await this.getContext();
        const inner = ctx.getStatus();
        return {
            indexedFiles: inner.indexedFiles,
            totalChunks: inner.totalChunks,
            embeddingProvider: inner.provider,
            embeddingModel: inner.model,
            lastSynced: inner.lastSynced,
            workspaceRoot: ctx.getWorkspaceRoot(),
            searchMode: inner.searchMode,
            ...(inner.degradedReason ? { degradedReason: inner.degradedReason } : {}),
            ...(inner.degradedKind ? { degradedKind: inner.degradedKind } : {}),
        };
    }

    public async search(query: string): Promise<string> {
        const ctx = await this.getContext();
        return ctx.search(query, undefined, this.getIdeRetrieveOptions(ctx.getWorkspaceRoot()));
    }

    public async searchRaw(query: string, topK?: number): Promise<SearchResult[]> {
        const ctx = await this.getContext();
        return ctx.searchRaw(query, topK, this.getIdeRetrieveOptions(ctx.getWorkspaceRoot()));
    }

    public async searchDebug(query: string, topK?: number): Promise<RetrievalDebugReport> {
        const ctx = await this.getContext();
        return ctx.searchDebug(query, topK, this.getIdeRetrieveOptions(ctx.getWorkspaceRoot()));
    }

    public async getIdeRetrieveOptionsForCurrentContext(): Promise<RetrieveOptions> {
        const ctx = await this.getContext();
        return this.getIdeRetrieveOptions(ctx.getWorkspaceRoot());
    }

    /** Team feature: search across multiple repo roots, merging results tagged by repo. */
    public async multiRepoSearch(query: string, repoPaths: string[], topK = 20): Promise<(SearchResult & { repo: string })[]> {
        if (!isEntitled(getLicense(), "multi-repo")) {
            throw new Error("Multi-repo search requires a Team license. Activate one from the Account panel.");
        }
        const mainRoot = this.resolveWorkspaceRoot();
        const seen = new Set<string>();
        const out: (SearchResult & { repo: string })[] = [];
        for (const raw of repoPaths) {
            const root = this.resolveFsPath(raw) || raw;
            if (!root || seen.has(root) || !this.pathExists(root)) continue;
            seen.add(root);
            let ctx: OpenContext;
            if (root === mainRoot) {
                ctx = await this.getContext();
            } else {
                ctx = this._multiContexts.get(root) ?? await OpenContext.create(await this.getConfigForPath(root));
                if (!this._multiContexts.has(root)) { this._multiContexts.set(root, ctx); await ctx.incrementalIndex(); }
            }
            const name = path.basename(root);
            const res = await ctx.searchRaw(query, topK, this.getIdeRetrieveOptions(ctx.getWorkspaceRoot()));
            for (const r of res) out.push({ ...r, repo: name });
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, topK);
    }

    public async setLLMSelection(provider: string, model: string): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        // Remember which provider this model was picked for, so switching only
        // llm.provider later (e.g. in settings.json) doesn't send it there.
        await this._extContext?.globalState.update(LLM_SELECTION_KEY, { provider, model });
        await cfg.update("llm.provider", provider, vscode.ConfigurationTarget.Global);
        await cfg.update("llm.model", model, vscode.ConfigurationTarget.Global);
    }

    /** The provider/model pair last saved from the model & keys form, if any. */
    public getLLMSelection(): { provider: string; model: string } | undefined {
        return this._extContext?.globalState.get<{ provider: string; model: string }>(LLM_SELECTION_KEY);
    }

    public async getLLMBaseUrl(): Promise<string> {
        return vscode.workspace.getConfiguration("openContext").get<string>("llm.baseUrl", "");
    }

    public async setLLMBaseUrl(url: string): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        await cfg.update("llm.baseUrl", url, vscode.ConfigurationTarget.Global);
    }

    public async hasEmbeddingApiKey(): Promise<boolean> {
        return (await this.getEmbeddingApiKey()) != null;
    }

    public async getEmbeddingApiKey(): Promise<string | undefined> {
        if (!this._extContext) return undefined;
        const secret = await this._extContext.secrets.get("openContext.embedding.apiKey");
        if (secret) return secret;
        const legacy = vscode.workspace.getConfiguration("openContext").get<string>("embedding.apiKey", "");
        return legacy || undefined;
    }

    public async getLLMApiKey(provider?: string): Promise<string | undefined> {
        if (!this._extContext) return undefined;
        if (provider) {
            const perProvider = await this._extContext.secrets.get(`openContext.llm.apiKey.${provider}`);
            if (perProvider) return perProvider;
        }
        const shared = await this._extContext.secrets.get("openContext.llm.apiKey");
        if (shared) return shared;
        const legacy = vscode.workspace.getConfiguration("openContext").get<string>("llm.apiKey", "");
        return legacy || undefined;
    }

    /** Returns whether the index will be rebuilt for the new key. */
    public async setEmbeddingApiKey(value: string): Promise<boolean> {
        if (!this._extContext) return false;
        if (value) await this._extContext.secrets.store("openContext.embedding.apiKey", value);
        else await this._extContext.secrets.delete("openContext.embedding.apiKey");
        // The key decides between keyword-only and semantic search, so an open
        // context is stale either way — from the command or the settings panel.
        // Watch whenever autoIndex is on, not only if a watcher was running: a
        // store refused at startup (no key) never got one.
        const autoIndex = vscode.workspace.getConfiguration("openContext").get<boolean>("autoIndex", true);
        const watching = autoIndex || this._watcher !== null || this._startingWatch !== null;
        await this.dispose();
        if (watching) await this.startWatching().catch(() => {});
        // The store reopens empty in the new mode (or behind, if it was refused);
        // the watcher only picks up files as they change.
        let rebuild = false;
        if (value) {
            try { rebuild = this.needsRebuild((await this.getStatus()).indexedFiles); } catch { /* the index run will report it */ }
        }
        this._onEmbeddingKeyChanged.fire({ hasKey: Boolean(value), rebuild });
        return rebuild;
    }

    /** Files in the open store's index, or undefined when no store is open.
     *  Never opens one: opening with changed settings can itself rebuild it. */
    public peekIndexedFiles(): number | undefined {
        return this._context?.getStatus().indexedFiles;
    }

    public getContextGeneration(): number {
        return this._generation;
    }

    public async setLLMApiKey(value: string, provider?: string): Promise<void> {
        if (!this._extContext) return;
        const key = provider ? `openContext.llm.apiKey.${provider}` : "openContext.llm.apiKey";
        if (value) await this._extContext.secrets.store(key, value);
        else await this._extContext.secrets.delete(key);
    }

    public async hasLLMApiKey(provider: string): Promise<boolean> {
        return (await this.getLLMApiKey(provider)) != null;
    }

    public async getWebSearchApiKey(): Promise<string | undefined> {
        if (!this._extContext) return undefined;
        const secret = await this._extContext.secrets.get("openContext.webSearch.apiKey");
        if (secret) return secret;
        return process.env.TAVILY_API_KEY || undefined;
    }

    public async setWebSearchApiKey(value: string): Promise<void> {
        if (!this._extContext) return;
        if (value) await this._extContext.secrets.store("openContext.webSearch.apiKey", value);
        else await this._extContext.secrets.delete("openContext.webSearch.apiKey");
    }

    public async hasWebSearchApiKey(): Promise<boolean> {
        return (await this.getWebSearchApiKey()) != null;
    }

    // --- Licensing (offline; backed by core/license) ---
    public getLicenseStatus(): LicenseStatusView {
        const s = getLicense();
        return { valid: s.valid, plan: s.plan, reason: s.reason, inGrace: s.inGrace, daysLeft: s.daysLeft, org: s.payload?.org, seats: s.payload?.seats, exp: s.payload?.exp };
    }

    public activateLicense(key: string): { ok: boolean; status: LicenseStatusView; error?: string } {
        const v = verifyLicenseToken(key);
        if (!v.valid) {
            const error = v.reason === "expired" ? "This license has expired."
                : v.reason === "bad-signature" ? "Invalid signature — check the key is complete."
                : "Malformed license key.";
            return { ok: false, status: this.getLicenseStatus(), error };
        }
        saveLicenseToken(key);
        return { ok: true, status: this.getLicenseStatus() };
    }

    public deactivateLicense(): void {
        clearLicense();
    }

    public async getIndexHealthReport(): Promise<IndexHealthReport> {
        const workspaceRoot = this.resolveWorkspaceRoot();
        const config = workspaceRoot ? await this.getConfigForPath(workspaceRoot) : null;
        const selectedWorkspaceRoot = this._extContext?.globalState.get<string>(INDEX_WORKSPACE_ROOT_KEY);
        const vscodeWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const provider = config?.embedding.provider ?? "voyage";
        const storeDir = config?.storePath || (workspaceRoot ? path.join(workspaceRoot, ".open-context") : "");
        const dbPath = storeDir ? path.join(storeDir, "context.db") : "";
        const notes: string[] = [];
        const embeddingKeyPresent = provider === "ollama" || provider === "local" || Boolean(await this.getEmbeddingApiKey());
        let contextReady = false, initializationError: string | undefined, indexedFiles: number | undefined, totalChunks: number | undefined, freshness: FreshnessReport | undefined, activeFile: IndexHealthReport["activeFile"];
        try {
            if (workspaceRoot) {
                const ctx = await this.getContext();
                const status = await this.getStatus();
                contextReady = true; indexedFiles = status.indexedFiles; totalChunks = status.totalChunks;
                if (status.searchMode === "keyword-only") {
                    notes.push(status.degradedKind === "keyword_only"
                        ? "Keyword-only (BM25) search: no embedding API key is set. Set one for semantic search (Open Context: Set Embedding API Key)."
                        : `sqlite-vec unavailable on this platform — keyword-only (BM25) search; semantic ranking disabled. ${status.degradedReason ?? ""}`.trim());
                }
                freshness = await ctx.checkFreshness();
                activeFile = await this.getActiveFileHealth(ctx.getWorkspaceRoot(), await ctx.listFiles());
            }
        } catch (err: any) { initializationError = err?.message ?? String(err); }
        let fileScan: FilterStats | undefined;
        try { if (workspaceRoot && config) fileScan = await new FileFilter(config.maxFileSize).collectStats(workspaceRoot); }
        catch (err: any) { notes.push(`File scan failed: ${err?.message ?? String(err)}`); }
        const dbStat = statMaybe(dbPath);
        if (!workspaceRoot) notes.push("No index workspace is selected and no VS Code workspace folder is open.");
        if (!embeddingKeyPresent) notes.push(`Missing ${provider} embedding API key.`);
        if (selectedWorkspaceRoot && vscodeWorkspaceRoot && selectedWorkspaceRoot !== vscodeWorkspaceRoot) notes.push("Index workspace differs from the first VS Code workspace folder.");
        if (initializationError) {
            const diag = classifyNativeBindingError(initializationError);
            if (diag.recognized) notes.push(diagnosisOneLiner(diag));
        }
        if (this._lastIndexError) notes.push("The last indexing attempt failed; see Last index error.");
        const potentiallyStale = freshness?.stale ?? (fileScan && indexedFiles !== undefined ? fileScan.includedFiles !== indexedFiles : undefined);
        if (potentiallyStale) notes.push("Indexed file count differs from current includable file count; index may be stale.");
        if (activeFile && !activeFile.indexed) notes.push(activeFile.reason ?? "Active editor file is not indexed.");
        return {
            generatedAt: new Date().toISOString(), workspaceRoot, selectedWorkspaceRoot, vscodeWorkspaceRoot, contextReady, initializationError, lastIndexError: this._lastIndexError,
            embedding: { provider, model: config?.embedding.model ?? "", apiKeyRequired: provider !== "ollama" && provider !== "local", apiKeyPresent: embeddingKeyPresent, dimension: config?.embedding.dimension ?? 0, batchSize: config?.embedding.batchSize ?? 0 },
            index: { storeDir, dbPath, storeExists: this.pathExists(storeDir), dbExists: this.pathExists(dbPath), dbSizeBytes: dbStat?.size, indexedFiles, totalChunks, potentiallyStale },
            fileScan, freshness, activeFile, notes,
        };
    }

    public async dispose(): Promise<void> {
        // First, so anything mid-open or mid-start sees it and backs off.
        this._generation++;
        // The store about to close held an index: if the reopen drops it, it
        // is to be rebuilt (needsRebuild). The count covers what the watcher
        // added since the last full run (a folder empty at startup and filled
        // later is not an empty workspace).
        const indexed = this.peekIndexedFiles() ?? 0;
        if (indexed > 0) { this._indexIntent = true; this._lastIndexedFiles = indexed; }
        await this.stopWatching();
        this._context?.close();
        this._context = null;
        for (const c of this._multiContexts.values()) { try { c.close(); } catch {} }
        this._multiContexts.clear();
    }

    public async getWorkspaceConfig(): Promise<OpenContextConfig> {
        const workspaceRoot = this.resolveWorkspaceRoot();
        if (!workspaceRoot) throw new Error("No workspace folder found. Please open a folder first.");
        return this.getConfigForPath(workspaceRoot);
    }

    private async getConfigForPath(workspaceRoot: string): Promise<OpenContextConfig> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        const provider = cfg.get<"openai" | "voyage" | "ollama" | "local">("embedding.provider", "voyage");
        // Not cfg.get: package.json's default ("voyage-code-3") would follow the
        // user into any other provider they pick.
        const modelKey = resolveEmbeddingModel(cfg, provider);
        const modelInfo = EMBEDDING_MODELS[modelKey];
        // Registry keys may map to fully-qualified model ids (local ONNX models do).
        const model = modelInfo?.model ?? modelKey;
        const dimension = modelInfo?.dimension ?? (provider === "openai" ? 1536 : provider === "voyage" ? 1024 : 768);
        const batchSize = modelInfo?.batchSize ?? (provider === "voyage" ? 32 : 100);
        const apiKey = await this.getEmbeddingApiKey();
        // A hosted provider with no key would fail every index and search. Start
        // on keyword search (BM25) instead, as the CLI does; "fallback" never
        // wipes an index that was built with vectors.
        const envKey = provider === "voyage" ? process.env.VOYAGE_API_KEY : provider === "openai" ? process.env.OPENAI_API_KEY : undefined;
        const missingKey = (provider === "voyage" || provider === "openai") && !apiKey && !envKey;

        return {
            workspaceRoot,
            ...(missingKey ? { keywordOnly: "fallback" as const } : {}),
            embedding: {
                provider,
                model,
                apiKey,
                dimension,
                batchSize,
            } as EmbeddingConfig,
            embedCache: cfg.get<boolean>("embedding.cache.enabled", true),
            search: {
                topK: cfg.get<number>("search.topK", 20),
                minScore: cfg.get<number>("search.minScore", 0.15),
            },
            chunkSize: cfg.get<number>("chunkSize", 80),
            chunkOverlap: cfg.get<number>("chunkOverlap", 15),
        };
    }

    private resolveWorkspaceRoot(): string {
        const selected = this._extContext?.globalState.get<string>(INDEX_WORKSPACE_ROOT_KEY);
        const selectedPath = this.resolveFsPath(selected ?? "");
        if (selectedPath && this.pathExists(selectedPath)) return selectedPath;

        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) return "";
        const fsPath = this.resolveFsPath(wsFolder.uri.fsPath);
        if (fsPath && this.pathExists(fsPath)) return fsPath;
        try {
            const uriPath = decodeURIComponent(wsFolder.uri.path);
            const resolvedUriPath = this.resolveFsPath(uriPath);
            if (resolvedUriPath && this.pathExists(resolvedUriPath)) return resolvedUriPath;
        } catch {}
        return fsPath ?? "";
    }

    private resolveFsPath(p: string): string | null {
        if (!p) return null;
        const converted = this.uncToLinux(p);
        return converted || p;
    }

    private getIdeRetrieveOptions(workspaceRoot: string): RetrieveOptions {
        const toRel = (fsPath: string | undefined): string | undefined => {
            if (!fsPath) return undefined;
            const rel = path.relative(workspaceRoot, this.resolveFsPath(fsPath) ?? fsPath).replace(/\\/g, "/");
            if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
            return rel;
        };
        const active = vscode.window.activeTextEditor;
        const activePath = toRel(active?.document.uri.fsPath);
        const openPaths = vscode.window.visibleTextEditors
            .map(e => toRel(e.document.uri.fsPath))
            .filter((p): p is string => Boolean(p));
        const selectedText = active && !active.selection.isEmpty ? active.document.getText(active.selection) : "";
        return {
            activePath,
            openPaths: [...new Set(openPaths)],
            contextText: selectedText.slice(0, 4000),
        };
    }

    private async getActiveFileHealth(workspaceRoot: string, indexedPaths: string[]): Promise<IndexHealthReport["activeFile"]> {
        const active = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!active) return { indexed: false, reason: "No active editor file." };
        const rel = path.relative(workspaceRoot, this.resolveFsPath(active) ?? active).replace(/\\/g, "/");
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { path: rel, indexed: false, reason: "Active editor file is outside the indexed workspace." };
        return { path: rel, indexed: indexedPaths.includes(rel), reason: indexedPaths.includes(rel) ? undefined : "Active editor file is not indexed." };
    }

    private pathExists(p: string): boolean {
        try { fs.accessSync(p); return true; } catch { return false; }
    }

    private uncToLinux(p: string): string | null {
        if (!p.startsWith("\\\\wsl") && !p.startsWith("//wsl")) return null;
        const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
        const skipCount = parts[0] === "wsl$" ? 2 : parts[0] === "wsl" ? 2 : 0;
        return "/" + parts.slice(skipCount).join("/");
    }
}

function statMaybe(p: string): fs.Stats | undefined {
    try { return p ? fs.statSync(p) : undefined; } catch { return undefined; }
}
