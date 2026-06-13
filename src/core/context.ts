import * as fs from "fs";
import * as path from "path";
import { OpenContextConfig, EmbeddingConfig, SearchConfig, File, Chunk, IndexingResult, SearchResult, FreshnessReport, DEFAULT_EMBEDDING_CONFIG, DEFAULT_SEARCH_CONFIG, EMBEDDING_MODELS } from "./types";
import { EmbeddingProvider, createEmbeddingProvider, isAuthError } from "./embedder";
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
import { extractEdges } from "./graph-extractor";
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
    ctx.embedder = config.embedder ?? createEmbeddingProvider(ctx.embeddingConfig);
    ctx.reranker = createReranker(config.reranker);
    const maxChunkChars = ctx.getMaxChunkChars();
    const fallback = new CodeChunker(config.chunkSize, config.chunkOverlap, maxChunkChars);
    ctx.chunker = new AstChunker({ maxChunkChars, fallback });
    ctx.fileFilter = new FileFilter(config.maxFileSize);
    const storePath = config.storePath || defaultStorePath(config.workspaceRoot);
    ctx.store = new SqliteStore(storePath, ctx.embedder.getDimension(), {
      ...(config.resolveVecPath ? { resolveVecPath: config.resolveVecPath } : {}),
    });
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
      const { failed, failedReason } = await this.embedAndStoreFiles(files, onProgress);
      this.queryCache.invalidate();
      this.refreshRecencyScores();
      await this.recordGitState();
      const failedSet = new Set(failed);
      return {
        newlyIndexed: files.map(f => f.path).filter(p => !failedSet.has(p)),
        alreadyIndexed: [], removed: [], duration: Date.now() - start,
        ...(failed.length ? { failed, failedReason } : {}),
      };
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
      // Stale sweep over the union of hashed files AND chunk-table paths: a
      // file whose embedding failed has chunks but no hash row — if it's
      // deleted before a successful retry, the hash-only sweep would never
      // clean its partial chunks out of the index.
      for (const p of new Set([...known.keys(), ...this.store.getIndexedPaths()])) {
        if (!seen.has(p)) { removed.push(p); this.store.removeByPath(p); }
      }
      for (const f of toIndex) this.store.removeByPath(f.path);
      const { failed, failedReason } = await this.embedAndStoreFiles(toIndex, onProgress);
      if (toIndex.length || removed.length) {
        this.queryCache.invalidate();
        this.refreshRecencyScores();
      }
      await this.recordGitState();
      const failedSet = new Set(failed);
      return {
        newlyIndexed: toIndex.map(f => f.path).filter(p => !failedSet.has(p)),
        alreadyIndexed, removed, duration: Date.now() - start,
        ...(failed.length ? { failed, failedReason } : {}),
      };
    });
  }

  async addFiles(files: File[]): Promise<IndexingResult> {
    return this.withLock(async () => {
      const start = Date.now();
      for (const f of files) this.store.removeByPath(f.path);
      const { failed, failedReason } = await this.embedAndStoreFiles(files);
      const failedSet = new Set(failed);
      return {
        newlyIndexed: files.map(f => f.path).filter(p => !failedSet.has(p)),
        alreadyIndexed: [], removed: [], duration: Date.now() - start,
        ...(failed.length ? { failed, failedReason } : {}),
      };
    });
  }

  async removeFromIndex(paths: string[]): Promise<void> {
    return this.withLock(async () => {
      for (const p of paths) this.store.removeByPath(p);
    });
  }

  /**
   * Chunk, embed, and store files in bounded windows.
   *
   * Resilient by design: an embedding failure poisons only its own window —
   * those files are reported in `failed`, their hashes are NOT recorded (so
   * the next incremental index retries exactly them), and the run continues.
   * Two deliberate exceptions:
   *  - Auth errors (401/403) abort immediately: every batch would fail the
   *    same way, and the user needs a clear "fix your API key" signal, not a
   *    10-minute crawl through hundreds of doomed batches.
   *  - After MAX_CONSECUTIVE_WINDOW_FAILURES in a row the provider is treated
   *    as down: remaining files are marked failed without further calls.
   *
   * A failed window may leave some of its chunks already stored (the window
   * embeds in sub-batches). They stay searchable — partial context beats
   * none — and the retry's removeByPath clears them before re-embedding.
   */
  private async embedAndStoreFiles(files: File[], onProgress?: ProgressCb): Promise<{ failed: string[]; failedReason?: string }> {
    // Process files in bounded batches so we never hold the whole repo's chunks
    // and embedding vectors in memory at once — only one FILE_BATCH window.
    const FILE_BATCH = 48;
    const MAX_CONSECUTIVE_WINDOW_FAILURES = 3;
    let filesDone = 0;
    const failed: string[] = [];
    let failedReason: string | undefined;
    let consecutiveFailures = 0;
    onProgress?.("indexing", 0, files.length);
    for (let fb = 0; fb < files.length; fb += FILE_BATCH) {
      const fileBatch = files.slice(fb, fb + FILE_BATCH);
      const chunks: Chunk[] = [];
      for (const file of fileBatch) {
        // Parse once per file; chunker + graph extractor share the tree, then
        // we dispose IN THIS ITERATION so we never hold FILE_BATCH live trees.
        // Trees live in WASM linear memory at 2-10x source size.
        const parsed = await this.chunker.parseFile(file);
        try {
          const fileChunks = await this.chunker.chunkFile(file, { parsed });
          for (const c of fileChunks) chunks.push(c);
          const language = parsed?.language ?? AstChunker.languageFor(file.path);
          if (language) {
            try {
              const { edges } = extractEdges(file, language, parsed?.tree ?? null);
              if (edges.length) {
                this.store.removeGraphEdgesByPath(file.path);
                this.store.addGraphEdges(edges);
              }
            } catch {}
          }
        } finally {
          parsed?.dispose();
        }
      }
      // Keyword-only mode (sqlite-vec unavailable): no embedding round-trips
      // at all — write chunk + FTS rows directly. Store writes propagate:
      // they're local DB trouble, not retryable provider blips, so the
      // failed[]/circuit-breaker machinery below doesn't apply.
      if (!this.store.isVectorAvailable()) {
        this.store.addBatch(chunks);
        for (const file of fileBatch) this.store.upsertFile(file.path, computeBlobName(file.path, file.contents));
        filesDone += fileBatch.length;
        onProgress?.("indexing", filesDone, files.length);
        continue;
      }
      // The try covers ONLY the embed call. Store writes (upsertFile below,
      // addBatch inside) indicate local DB trouble, not a skippable provider
      // blip — letting them propagate keeps "failed = will be retried" honest.
      let embedErr: any = null;
      try {
        await this.embedAndStoreChunks(chunks);
      } catch (err) {
        embedErr = err;
      }
      if (embedErr) {
        if (isAuthError(embedErr)) {
          throw new Error(`Embedding provider rejected the API key (${embedErr?.message ?? embedErr}). Fix the key and re-run the index.`);
        }
        failed.push(...fileBatch.map(f => f.path));
        failedReason = failedReason ?? (embedErr?.message ?? String(embedErr));
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_WINDOW_FAILURES) {
          // Provider looks down — don't hammer it for the rest of the repo.
          for (const f of files.slice(fb + FILE_BATCH)) failed.push(f.path);
          failedReason = `Embedding provider unavailable (${consecutiveFailures} consecutive batch failures). Last error: ${failedReason}`;
          // Close out the progress stream so UIs don't freeze mid-count;
          // the result accounts for every file either way.
          onProgress?.("indexing", files.length, files.length);
          break;
        }
      } else {
        // Record hashes for every file in the batch (including files with no chunks).
        for (const file of fileBatch) this.store.upsertFile(file.path, computeBlobName(file.path, file.contents));
        // Only a window that actually contacted the provider proves it's
        // healthy — a zero-chunk window must not reset the circuit breaker.
        if (chunks.length) consecutiveFailures = 0;
      }
      filesDone += fileBatch.length;
      onProgress?.("indexing", filesDone, files.length);
    }
    return { failed, failedReason };
  }

  private async embedAndStoreChunks(chunks: Chunk[]): Promise<void> {
    if (!chunks.length) return;
    const batchSize = Math.max(8, this.embeddingConfig.batchSize ?? 32);
    const expectedDim = this.embedder.getDimension();
    for (let offset = 0; offset < chunks.length; offset += batchSize * CONCURRENT_EMBED_BATCHES) {
      const groups: Chunk[][] = [];
      for (let k = 0; k < CONCURRENT_EMBED_BATCHES; k++) {
        const s = offset + k * batchSize;
        if (s >= chunks.length) break;
        groups.push(chunks.slice(s, Math.min(s + batchSize, chunks.length)));
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
      }
    }
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

  /** Chunks whose extracted symbol name matches exactly — definition lookup. */
  findSymbolDefinitions(symbol: string, limit = 5): Chunk[] {
    return this.store.getChunksBySymbol(symbol, limit);
  }

  /** Chunks whose contents mention the identifier (FTS-accelerated, exact
   *  word-boundary match) — reference lookup. */
  findSymbolReferences(symbol: string, pathFilter?: string, limit = 8): Chunk[] {
    return this.store.getChunksReferencingIdentifier(symbol, pathFilter, limit);
  }

  getWorkspaceRoot(): string { return this.workspaceRoot; }

  getIndexedFiles(): { path: string; chunkCount: number; lastModified: number }[] {
    const state = this.store.getState(this.workspaceRoot, this.embeddingConfig.provider, this.embedder.getModel());
    const counts = this.store.getChunkCountsByPath();
    return state.files.map(f => ({ path: f.path, chunkCount: counts.get(f.path) ?? 0, lastModified: f.lastModified }));
  }

  getStatus(): { indexedFiles: number; totalChunks: number; provider: string; model: string; lastSynced: string; searchMode: "hybrid" | "keyword-only"; degradedReason?: string } {
    const vectorAvailable = this.store.isVectorAvailable();
    return {
      indexedFiles: this.store.getFileCount(),
      totalChunks: this.store.getChunkCount(),
      provider: this.embeddingConfig.provider,
      model: this.embedder.getModel(),
      lastSynced: new Date().toISOString(),
      searchMode: vectorAvailable ? "hybrid" : "keyword-only",
      ...(vectorAvailable ? {} : { degradedReason: this.store.getVectorDiagnosis()?.title }),
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
