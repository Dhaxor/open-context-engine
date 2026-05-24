import * as fs from "fs";
import * as path from "path";
import { OpenContextConfig, EmbeddingConfig, SearchConfig, File, Chunk, IndexingResult, SearchResult, FreshnessReport, DEFAULT_EMBEDDING_CONFIG, DEFAULT_SEARCH_CONFIG, EMBEDDING_MODELS } from "./types";
import { EmbeddingProvider, createEmbeddingProvider } from "./embedder";
import { SqliteStore } from "./sqlite-store";
import { CodeChunker } from "./chunker";
import { AstChunker } from "./ast-chunker";
import { FileFilter } from "./file-filter";
import { computeBlobName, isBinaryBuffer } from "./utils";
import { formatSearchOutput } from "./search";
import { HybridRetriever, RetrievalDebugReport, RetrieveOptions } from "./retriever";
import { Reranker, createReranker } from "./reranker";
import { compareFreshness, getGitState } from "./freshness";
import { getFileRecencyScores } from "./git-recency";
import { QueryCache } from "./query-cache";
import { loadGuidelines, Guidelines, getRelevantGuidelines } from "./guidelines";
import { CodeGraph } from "./code-graph";
import { extractEdgesFromSource } from "./graph-extractor";
import { GraphExpander } from "./graph-expander";

const CONCURRENT_EMBED_BATCHES = 2;

export class OpenContext {
  private embeddingConfig!: EmbeddingConfig;
  private searchConfig!: SearchConfig;
  private embedder!: EmbeddingProvider;
  private reranker?: Reranker;
  private store!: SqliteStore;
  private chunker!: AstChunker;
  private fileFilter!: FileFilter;
  private retriever!: HybridRetriever;
  private queryCache!: QueryCache;
  private guidelines: Guidelines | null = null;
  private codeGraph!: CodeGraph;
  private graphExpander!: GraphExpander;
  private workspaceRoot: string = "";
  private _indexingMutex: Promise<void> = Promise.resolve();

  private constructor() {}

  static async create(config: OpenContextConfig): Promise<OpenContext> {
    const ctx = new OpenContext();
    ctx.workspaceRoot = config.workspaceRoot;
    ctx.embeddingConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config.embedding };
    ctx.searchConfig = { ...DEFAULT_SEARCH_CONFIG, ...config.search };
    ctx.embedder = createEmbeddingProvider(ctx.embeddingConfig);
    ctx.reranker = createReranker(config.reranker);
    const maxChunkChars = ctx.getMaxChunkChars();
    const fallback = new CodeChunker(config.chunkSize, config.chunkOverlap, maxChunkChars);
    ctx.chunker = new AstChunker({ maxChunkChars, fallback });
    ctx.fileFilter = new FileFilter(config.maxFileSize);
    const storePath = config.storePath || defaultStorePath(config.workspaceRoot);
    ctx.store = new SqliteStore(storePath, ctx.embedder.getDimension());
    await ctx.store.initialize();
    ctx.queryCache = new QueryCache(ctx.searchConfig.queryCacheSize ?? 128);
    ctx.retriever = new HybridRetriever(ctx.store, ctx.embedder, ctx.searchConfig, ctx.reranker, ctx.queryCache);
    ctx.codeGraph = new CodeGraph(ctx.store);
    ctx.graphExpander = new GraphExpander(ctx.codeGraph, ctx.store);
    ctx.retriever.setGraphExpander(ctx.graphExpander);
    ctx.guidelines = loadGuidelines(config.workspaceRoot);
    ctx.refreshRecencyScores();
    return ctx;
  }

  private refreshRecencyScores(): void {
    const scores = getFileRecencyScores(this.workspaceRoot);
    this.retriever.setRecencyScores(scores);
  }

  private async recordGitState(): Promise<void> {
    try { this.store.setIndexedGit(await getGitState(this.workspaceRoot)); } catch {}
  }

  getGuidelines(): Guidelines | null {
    return this.guidelines;
  }

  getGuidelinesText(context?: { paths?: string[]; query?: string }): string {
    return getRelevantGuidelines(this.guidelines, context);
  }

  private async acquireLock(): Promise<() => void> {
    let release: () => void = () => {};
    const prev = this._indexingMutex;
    let resolve: () => void;
    const next = new Promise<void>(r => { resolve = r; });
    this._indexingMutex = next;
    await prev;
    release = () => { resolve(); };
    return release;
  }

  private async withLock<T>(op: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock();
    try {
      return await op();
    } finally {
      release();
    }
  }

  async indexWorkspace(onProgress?: ProgressCb): Promise<IndexingResult> {
    return this.withLock(async () => {
      const start = Date.now();
      const files = await this.fileFilter.collectFiles(this.workspaceRoot, (n) => onProgress?.("collecting", n, 0));
      for (const p of this.store.getIndexedPaths()) this.store.removeByPath(p);
      await this.embedAndStoreFiles(files, onProgress);
      this.queryCache.invalidate();
      this.refreshRecencyScores();
      await this.recordGitState();
      return { newlyIndexed: files.map(f => f.path), alreadyIndexed: [], removed: [], duration: Date.now() - start };
    });
  }

  async incrementalIndex(onProgress?: ProgressCb): Promise<IndexingResult> {
    return this.withLock(async () => {
      const start = Date.now();
      const files = await this.fileFilter.collectFiles(this.workspaceRoot, (n) => onProgress?.("collecting", n, 0));
      const known = this.store.getFileHashes();
      const toIndex: File[] = [];
      const removed: string[] = [];
      const alreadyIndexed: string[] = [];
      const seen = new Set<string>();
      for (const file of files) {
        seen.add(file.path);
        const hash = computeBlobName(file.path, file.contents);
        const prev = known.get(file.path);
        if (prev === hash) alreadyIndexed.push(file.path);
        else toIndex.push(file);
      }
      for (const [p] of known) {
        if (!seen.has(p)) { removed.push(p); this.store.removeByPath(p); }
      }
      for (const f of toIndex) this.store.removeByPath(f.path);
      await this.embedAndStoreFiles(toIndex, onProgress);
      if (toIndex.length || removed.length) {
        this.queryCache.invalidate();
        this.refreshRecencyScores();
      }
      await this.recordGitState();
      return { newlyIndexed: toIndex.map(f => f.path), alreadyIndexed, removed, duration: Date.now() - start };
    });
  }

  async addFiles(files: File[]): Promise<IndexingResult> {
    return this.withLock(async () => {
      const start = Date.now();
      for (const f of files) this.store.removeByPath(f.path);
      await this.embedAndStoreFiles(files);
      return { newlyIndexed: files.map(f => f.path), alreadyIndexed: [], removed: [], duration: Date.now() - start };
    });
  }

  async removeFromIndex(paths: string[]): Promise<void> {
    return this.withLock(async () => {
      for (const p of paths) this.store.removeByPath(p);
    });
  }

  private async embedAndStoreFiles(files: File[], onProgress?: ProgressCb): Promise<void> {
    onProgress?.("chunking", 0, files.length);
    const fileChunks: { file: File; chunks: Chunk[] }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      fileChunks.push({ file, chunks: await this.chunker.chunkFile(file) });
      const language = AstChunker.languageFor(file.path);
      if (language) {
        try {
          const { edges } = extractEdgesFromSource(file.path, file.contents, language);
          if (edges.length) {
            this.store.removeGraphEdgesByPath(file.path);
            this.store.addGraphEdges(edges);
          }
        } catch {}
      }
      onProgress?.("chunking", i + 1, files.length);
    }
    const allChunks = fileChunks.flatMap(fc => fc.chunks);
    if (!allChunks.length) {
      for (const { file } of fileChunks) this.store.upsertFile(file.path, computeBlobName(file.path, file.contents));
      return;
    }
    onProgress?.("embedding", 0, allChunks.length);
    const batchSize = Math.max(8, this.embeddingConfig.batchSize ?? 32);
    const expectedDim = this.embedder.getDimension();
    let done = 0;
    for (let offset = 0; offset < allChunks.length; offset += batchSize * CONCURRENT_EMBED_BATCHES) {
      const groups: Chunk[][] = [];
      for (let k = 0; k < CONCURRENT_EMBED_BATCHES; k++) {
        const s = offset + k * batchSize;
        if (s >= allChunks.length) break;
        groups.push(allChunks.slice(s, Math.min(s + batchSize, allChunks.length)));
      }
      const results = await Promise.all(groups.map(g => this.embedder.embed(g.map(c => c.contents), "document")));
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi], vs = results[gi];
        if (vs.length !== g.length) throw new Error(`Embedding count mismatch`);
        for (let i = 0; i < g.length; i++) {
          if (vs[i].length !== expectedDim) throw new Error(`Embedding dim mismatch: ${vs[i].length} != ${expectedDim}`);
          g[i].vector = vs[i];
        }
        this.store.addBatch(g);
        done += g.length;
        onProgress?.("embedding", done, allChunks.length);
      }
    }
    for (const { file } of fileChunks) this.store.upsertFile(file.path, computeBlobName(file.path, file.contents));
  }

  async search(query: string, maxOutputLength?: number, retrieveOptions?: RetrieveOptions): Promise<string> {
    const results = await this.retriever.retrieve(query, retrieveOptions);
    return formatSearchOutput(results, {
      ...this.searchConfig,
      ...(maxOutputLength != null ? { maxOutputLength } : {}),
    });
  }

  async searchRaw(query: string, topK?: number, retrieveOptions?: RetrieveOptions): Promise<SearchResult[]> {
    return this.retriever.retrieve(query, { ...retrieveOptions, topK });
  }

  async searchDebug(query: string, topK?: number, retrieveOptions?: RetrieveOptions): Promise<RetrievalDebugReport> {
    return this.retriever.retrieveDebug(query, { ...retrieveOptions, topK });
  }

  async listFiles(directory?: string, pattern?: string): Promise<string[]> {
    let paths = this.store.getIndexedPaths();
    if (directory) paths = paths.filter(p => p.startsWith(directory));
    if (pattern) {
      const { minimatch } = await import("minimatch");
      paths = paths.filter(p => minimatch(p, pattern));
    }
    return paths.sort();
  }

  async readFile(filePath: string, startLine?: number, endLine?: number): Promise<string | null> {
    try {
      const fullPath = path.join(this.workspaceRoot, filePath);
      const buf = await fs.promises.readFile(fullPath);
      if (isBinaryBuffer(buf)) return `Cannot read '${filePath}': binary file (this model does not support image or binary input).`;
      const full = buf.toString("utf8");
      if (startLine != null || endLine != null) {
        const lines = full.split("\n");
        const s = (startLine ?? 1) - 1;
        const e = endLine ?? lines.length;
        return lines.slice(s, e).join("\n");
      }
      return full;
    } catch { return null; }
  }

  getChunkCount(): number { return this.store.getChunkCount(); }

  getWorkspaceRoot(): string { return this.workspaceRoot; }

  getIndexedFiles(): { path: string; chunkCount: number; lastModified: number }[] {
    const state = this.store.getState(this.workspaceRoot, this.embeddingConfig.provider, this.embedder.getModel());
    return state.files.map(f => ({ path: f.path, chunkCount: 0, lastModified: f.lastModified }));
  }

  getStatus(): { indexedFiles: number; totalChunks: number; provider: string; model: string; lastSynced: string } {
    return {
      indexedFiles: this.store.getFileCount(),
      totalChunks: this.store.getChunkCount(),
      provider: this.embeddingConfig.provider,
      model: this.embedder.getModel(),
      lastSynced: new Date().toISOString(),
    };
  }

  async checkFreshness(): Promise<FreshnessReport> {
    const files = await this.fileFilter.collectFiles(this.workspaceRoot);
    return compareFreshness(
      files,
      this.store.getFileHashes(),
      { lastIndexedAt: this.store.getLastIndexedAt(), git: this.store.getIndexedGit() },
      await getGitState(this.workspaceRoot),
    );
  }

  close(): void {
    try { this.chunker?.dispose(); } catch {}
    this.store?.close();
  }

  private getMaxChunkChars(): number {
    const modelInfo = EMBEDDING_MODELS[this.embeddingConfig.model];
    const maxTokens = modelInfo?.maxTokens ?? 8192;
    return Math.floor(maxTokens * 2.5);
  }
}

export type ProgressCb = (status: string, current: number, total: number) => void;

export function defaultStorePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".open-context");
}
