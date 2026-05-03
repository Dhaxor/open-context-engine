import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { OpenContext } from "../../../src/core/context";
import { FileFilter, FilterStats } from "../../../src/core/file-filter";
import { FileWatcher } from "../../../src/core/file-watcher";
import { OpenContextConfig, EmbeddingConfig, IndexingResult, EMBEDDING_MODELS, SearchResult, FreshnessReport } from "../../../src/core/types";
import { RetrievalDebugReport, RetrieveOptions } from "../../../src/core/retriever";

const INDEX_WORKSPACE_ROOT_KEY = "openContext.indexWorkspaceRoot";

export interface ContextStatus {
    indexedFiles: number;
    totalChunks: number;
    embeddingProvider: string;
    embeddingModel: string;
    lastSynced: string;
    workspaceRoot: string;
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

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
    openai: "text-embedding-3-small",
    voyage: "voyage-code-3",
    ollama: "nomic-embed-text",
};

export class ContextService implements vscode.Disposable {
    private static _instance: ContextService;
    private _context: OpenContext | null = null;
    private _watcher: FileWatcher | null = null;
    private _extContext: vscode.ExtensionContext | null = null;
    private _onReindex = new vscode.EventEmitter<IndexingResult>();
    private _lastIndexError: string | undefined;
    readonly onReindex = this._onReindex.event;

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
    }

    public async getContext(): Promise<OpenContext> {
        if (!this._context) {
            const config = await this.getWorkspaceConfig();
            this._context = await OpenContext.create(config);
        }
        return this._context;
    }

    public async indexWorkspace(onProgress?: (stage: string, current: number, total: number) => void, token?: vscode.CancellationToken): Promise<void> {
        try {
            const ctx = await this.getContext();
            await ctx.incrementalIndex((stage, current, total) => {
                if (token?.isCancellationRequested) throw new vscode.CancellationError();
                onProgress?.(stage, current, total);
            });
            this._lastIndexError = undefined;
        } catch (err: any) {
            this._lastIndexError = err?.message ?? String(err);
            throw err;
        }
    }

    public async indexDirectory(dirPath: string, onProgress?: (stage: string, current: number, total: number) => void, token?: vscode.CancellationToken): Promise<void> {
        try {
            await this.setIndexWorkspaceRoot(dirPath);
            const config = await this.getConfigForPath(this.resolveWorkspaceRoot());
            this._context = await OpenContext.create(config);
            await this._context.indexWorkspace((stage, current, total) => {
                if (token?.isCancellationRequested) throw new vscode.CancellationError();
                onProgress?.(stage, current, total);
            });
            this._lastIndexError = undefined;
        } catch (err: any) {
            this._lastIndexError = err?.message ?? String(err);
            throw err;
        }
    }

    public async startWatching(): Promise<void> {
        if (this._watcher) return;
        const ctx = await this.getContext();
        const config = await this.getWorkspaceConfig();
        this._watcher = new FileWatcher(ctx, config);
        await this._watcher.start({
            onReindex: (result) => this._onReindex.fire(result),
            onError: (err) => console.error("[FileWatcher]", err),
        });
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

    public async setLLMSelection(provider: string, model: string): Promise<void> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        await cfg.update("llm.provider", provider, vscode.ConfigurationTarget.Global);
        await cfg.update("llm.model", model, vscode.ConfigurationTarget.Global);
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

    public async setEmbeddingApiKey(value: string): Promise<void> {
        if (!this._extContext) return;
        if (value) await this._extContext.secrets.store("openContext.embedding.apiKey", value);
        else await this._extContext.secrets.delete("openContext.embedding.apiKey");
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

    public async getIndexHealthReport(): Promise<IndexHealthReport> {
        const workspaceRoot = this.resolveWorkspaceRoot();
        const config = workspaceRoot ? await this.getConfigForPath(workspaceRoot) : null;
        const selectedWorkspaceRoot = this._extContext?.globalState.get<string>(INDEX_WORKSPACE_ROOT_KEY);
        const vscodeWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const provider = config?.embedding.provider ?? "voyage";
        const storeDir = config?.storePath || (workspaceRoot ? path.join(workspaceRoot, ".open-context") : "");
        const dbPath = storeDir ? path.join(storeDir, "context.db") : "";
        const notes: string[] = [];
        const embeddingKeyPresent = provider === "ollama" || Boolean(await this.getEmbeddingApiKey());
        let contextReady = false, initializationError: string | undefined, indexedFiles: number | undefined, totalChunks: number | undefined, freshness: FreshnessReport | undefined, activeFile: IndexHealthReport["activeFile"];
        try {
            if (workspaceRoot) {
                const ctx = await this.getContext();
                const status = await this.getStatus();
                contextReady = true; indexedFiles = status.indexedFiles; totalChunks = status.totalChunks;
                freshness = await ctx.checkFreshness();
                activeFile = await this.getActiveFileHealth(ctx.getWorkspaceRoot(), await ctx.listFiles());
            }
        } catch (err: any) { initializationError = err?.message ?? String(err); }
        let fileScan: FilterStats | undefined;
        try { if (workspaceRoot && config) fileScan = await new FileFilter(config.maxFileSize).collectStats(workspaceRoot); }
        catch (err: any) { notes.push(`File scan failed: ${err?.message ?? String(err)}`); }
        const dbStat = statMaybe(dbPath);
        if (!workspaceRoot) notes.push("No index workspace is selected and no VS Code workspace folder is open.");
        if (provider !== "ollama" && !embeddingKeyPresent) notes.push(`Missing ${provider} embedding API key.`);
        if (selectedWorkspaceRoot && vscodeWorkspaceRoot && selectedWorkspaceRoot !== vscodeWorkspaceRoot) notes.push("Index workspace differs from the first VS Code workspace folder.");
        if (initializationError && /better-sqlite3|NODE_MODULE_VERSION|DLOPEN|self-register/i.test(initializationError)) notes.push("SQLite native dependency appears incompatible with the current Node runtime; rebuild/reinstall better-sqlite3.");
        if (this._lastIndexError) notes.push("The last indexing attempt failed; see Last index error.");
        const potentiallyStale = freshness?.stale ?? (fileScan && indexedFiles !== undefined ? fileScan.includedFiles !== indexedFiles : undefined);
        if (potentiallyStale) notes.push("Indexed file count differs from current includable file count; index may be stale.");
        if (activeFile && !activeFile.indexed) notes.push(activeFile.reason ?? "Active editor file is not indexed.");
        return {
            generatedAt: new Date().toISOString(), workspaceRoot, selectedWorkspaceRoot, vscodeWorkspaceRoot, contextReady, initializationError, lastIndexError: this._lastIndexError,
            embedding: { provider, model: config?.embedding.model ?? "", apiKeyRequired: provider !== "ollama", apiKeyPresent: embeddingKeyPresent, dimension: config?.embedding.dimension ?? 0, batchSize: config?.embedding.batchSize ?? 0 },
            index: { storeDir, dbPath, storeExists: this.pathExists(storeDir), dbExists: this.pathExists(dbPath), dbSizeBytes: dbStat?.size, indexedFiles, totalChunks, potentiallyStale },
            fileScan, freshness, activeFile, notes,
        };
    }

    public async dispose(): Promise<void> {
        await this.stopWatching();
        this._context?.close();
        this._context = null;
    }

    public async getWorkspaceConfig(): Promise<OpenContextConfig> {
        const workspaceRoot = this.resolveWorkspaceRoot();
        if (!workspaceRoot) throw new Error("No workspace folder found. Please open a folder first.");
        return this.getConfigForPath(workspaceRoot);
    }

    private async getConfigForPath(workspaceRoot: string): Promise<OpenContextConfig> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        const provider = cfg.get<"openai" | "voyage" | "ollama">("embedding.provider", "voyage");
        const model = cfg.get<string>("embedding.model", DEFAULT_MODEL_BY_PROVIDER[provider] ?? "voyage-code-3");
        const modelInfo = EMBEDDING_MODELS[model];
        const dimension = modelInfo?.dimension ?? (provider === "openai" ? 1536 : provider === "voyage" ? 1024 : 768);
        const batchSize = modelInfo?.batchSize ?? (provider === "voyage" ? 32 : 100);
        const apiKey = await this.getEmbeddingApiKey();

        return {
            workspaceRoot,
            embedding: {
                provider,
                model,
                apiKey,
                dimension,
                batchSize,
            } as EmbeddingConfig,
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
