import * as fs from "fs";
import * as vscode from "vscode";
import { OpenContext } from "../../../src/core/context";
import { FileWatcher } from "../../../src/core/file-watcher";
import { OpenContextConfig, EmbeddingConfig, IndexingResult, EMBEDDING_MODELS, SearchResult } from "../../../src/core/types";

export interface ContextStatus {
    indexedFiles: number;
    totalChunks: number;
    embeddingProvider: string;
    embeddingModel: string;
    lastSynced: string;
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
    readonly onReindex = this._onReindex.event;

    private constructor() {}

    public static getInstance(): ContextService {
        if (!ContextService._instance) ContextService._instance = new ContextService();
        return ContextService._instance;
    }

    public bindExtensionContext(ctx: vscode.ExtensionContext): void {
        this._extContext = ctx;
    }

    public async getContext(): Promise<OpenContext> {
        if (!this._context) {
            const config = await this.getWorkspaceConfig();
            this._context = await OpenContext.create(config);
        }
        return this._context;
    }

    public async indexWorkspace(onProgress?: (stage: string, current: number, total: number) => void, token?: vscode.CancellationToken): Promise<void> {
        const ctx = await this.getContext();
        await ctx.incrementalIndex((stage, current, total) => {
            if (token?.isCancellationRequested) throw new vscode.CancellationError();
            onProgress?.(stage, current, total);
        });
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
        };
    }

    public async search(query: string): Promise<string> {
        const ctx = await this.getContext();
        return ctx.search(query);
    }

    public async searchRaw(query: string, topK?: number): Promise<SearchResult[]> {
        const ctx = await this.getContext();
        return ctx.searchRaw(query, topK);
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

    public async dispose(): Promise<void> {
        await this.stopWatching();
        this._context = null;
        this._onReindex.dispose();
    }

    public async getWorkspaceConfig(): Promise<OpenContextConfig> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        const workspaceRoot = this.resolveWorkspaceRoot();
        if (!workspaceRoot) throw new Error("No workspace folder found. Please open a folder first.");

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
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) return "";
        const fsPath = wsFolder.uri.fsPath;
        if (this.pathExists(fsPath)) return fsPath;
        const converted = this.uncToLinux(fsPath);
        if (converted && this.pathExists(converted)) return converted;
        try {
            const uriPath = decodeURIComponent(wsFolder.uri.path);
            if (uriPath && this.pathExists(uriPath)) return uriPath;
        } catch {}
        return fsPath;
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
