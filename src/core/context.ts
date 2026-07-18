import * as fs from "fs";
import * as path from "path";
import { OpenContextConfig, EmbeddingConfig, SearchConfig, File, Chunk, IndexingResult, SearchResult, FreshnessReport, DEFAULT_EMBEDDING_CONFIG, DEFAULT_SEARCH_CONFIG, EMBEDDING_MODELS } from "./types";
import { EmbeddingProvider, createEmbeddingProvider, isAuthError } from "./embedder";
import { SqliteStore } from "./sqlite-store";
import { CodeChunker } from "./chunker";
import { AstChunker } from "./ast-chunker";
import { FileFilter } from "./file-filter";
import { computeBlobName, isBinaryBuffer, isKeyishPath, resolveWorkspacePath } from "./utils";
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
import { loadPolicy, checkEmbeddingPolicy, EffectivePolicy } from "./policy";
import { createLogger, errText } from "./log";

const log = createLogger("context");
import { ChunkWorkerPool, defaultPoolSize } from "./chunk-pool";
import { ARTIFACT_MANIFEST_KEY, IndexArtifactManifest, packArtifact } from "./index-artifact";
import { EmbedCache, contentHash } from "./embed-cache";
import * as os from "os";

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
  private policy: EffectivePolicy | null = null;
  private chunkPool: ChunkWorkerPool | null = null;
  private embedCache: EmbedCache | null = null;
  private parallelism: number | false | undefined;
  private chunkCfg!: { maxChunkChars: number; chunkSize?: number; chunkOverlap?: number };
  private _indexingMutex: Promise<void> = Promise.resolve();

  private constructor() {}

  static async create(config: OpenContextConfig): Promise<OpenContext> {
    const ctx = new OpenContext();
    ctx.workspaceRoot = config.workspaceRoot;
    // Policy: load from the standard files unless injected or disabled. The
    // embedding check runs BEFORE the provider is constructed so a policy
    // violation fails fast with a clear message instead of after a long index.
    ctx.policy = config.policy === false ? null : config.policy ?? loadPolicy(config.workspaceRoot);
    ctx.embeddingConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config.embedding };
    ctx.searchConfig = { ...DEFAULT_SEARCH_CONFIG, ...config.search };
    if (ctx.policy && !config.embedder) {
      const violation = checkEmbeddingPolicy(ctx.policy, ctx.embeddingConfig.provider);
      if (violation) throw new Error(violation);
    }
    ctx.embedder = config.embedder ?? createEmbeddingProvider(ctx.embeddingConfig);
    ctx.reranker = createReranker(config.reranker);
    const maxChunkChars = ctx.getMaxChunkChars();
    const fallback = new CodeChunker(config.chunkSize, config.chunkOverlap, maxChunkChars);
    ctx.chunker = new AstChunker({ maxChunkChars, fallback });
    ctx.parallelism = config.parallelism;
    ctx.chunkCfg = { maxChunkChars, chunkSize: config.chunkSize, chunkOverlap: config.chunkOverlap };
    ctx.embedCache = config.embedCache ? new EmbedCache(typeof config.embedCache === "string" ? config.embedCache : undefined) : null;
    ctx.fileFilter = new FileFilter(config.maxFileSize, ctx.policy?.ignore);
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
    try { this.store.setIndexedGit(await getGitState(this.workspaceRoot)); }
    catch (err) { log.debug("failed to record git state", { error: errText(err) }); }
  }

  getGuidelines(): Guidelines | null {
    return this.guidelines;
  }

  /** The effective policy loaded for this workspace (null when disabled via config). */
  getPolicy(): EffectivePolicy | null {
    return this.policy;
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
    // Workers only pay off past a few hundred files: each worker loads its
    // own WASM grammars, which dominates small runs (measured 0.88x on a
    // 186-file repo, so auto mode keeps those inline). An explicit numeric
    // `parallelism` always uses the pool.
    const AUTO_POOL_MIN_FILES = 500;
    const usePool = this.parallelism !== false
      && (typeof this.parallelism === "number" ? this.parallelism > 0
          : files.length >= AUTO_POOL_MIN_FILES && os.cpus().length >= 4);
    const pool = usePool ? this.ensureChunkPool() : null;
    onProgress?.("indexing", 0, files.length);
    for (let fb = 0; fb < files.length; fb += FILE_BATCH) {
      const fileBatch = files.slice(fb, fb + FILE_BATCH);
      const chunks: Chunk[] = [];
      for (const pf of await this.chunkFileBatch(fileBatch, pool)) {
        for (const c of pf.chunks) chunks.push(c);
        if (pf.edges.length) {
          this.store.removeGraphEdgesByPath(pf.path);
          this.store.addGraphEdges(pf.edges);
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

  /** Lazily spawn the worker pool (first big run pays the startup, later
   *  runs reuse it). Returns null when workers are unavailable or fail. */
  private ensureChunkPool(): ChunkWorkerPool | null {
    if (this.chunkPool) return this.chunkPool;
    if (!ChunkWorkerPool.isAvailable()) return null;
    try {
      this.chunkPool = new ChunkWorkerPool({
        ...this.chunkCfg,
        size: typeof this.parallelism === "number" ? this.parallelism : defaultPoolSize(),
      });
    } catch {
      this.chunkPool = null; // worker spawn failure must never block indexing
    }
    return this.chunkPool;
  }

  /** CPU-bound half of indexing (parse + chunk + graph extraction) for one
   *  window of files. Fans out across the worker pool when one exists; a pool
   *  failure quietly retries inline — results are identical either way. */
  private async chunkFileBatch(fileBatch: File[], pool: ChunkWorkerPool | null): Promise<{ path: string; chunks: Chunk[]; edges: import("./code-graph").GraphEdge[] }[]> {
    if (pool) {
      try {
        return await pool.run(fileBatch);
      } catch {
        // Fall through to inline — e.g. a worker died mid-batch.
      }
    }
    const out: { path: string; chunks: Chunk[]; edges: import("./code-graph").GraphEdge[] }[] = [];
    for (const file of fileBatch) {
      // Parse once per file; chunker + graph extractor share the tree, then
      // we dispose IN THIS ITERATION so we never hold FILE_BATCH live trees.
      // Trees live in WASM linear memory at 2-10x source size.
      const parsed = await this.chunker.parseFile(file);
      try {
        const fileChunks = await this.chunker.chunkFile(file, { parsed });
        const language = parsed?.language ?? AstChunker.languageFor(file.path);
        let edges: import("./code-graph").GraphEdge[] = [];
        if (language) {
          try { edges = extractEdges(file, language, parsed?.tree ?? null).edges; }
          catch (err) { log.debug("graph extraction failed", { path: file.path, error: errText(err) }); }
        }
        out.push({ path: file.path, chunks: fileChunks, edges });
      } finally {
        parsed?.dispose();
      }
    }
    return out;
  }

  private async embedAndStoreChunks(chunks: Chunk[]): Promise<void> {
    if (!chunks.length) return;
    const batchSize = Math.max(8, this.embeddingConfig.batchSize ?? 32);
    const expectedDim = this.embedder.getDimension();
    const model = this.embedder.getModel();
    // Cache pass: identical content embedded before (any repo, any branch on
    // this machine — or shipped inside a team index) never hits the provider
    // again. Failures inside the cache silently degrade to a full embed.
    let toEmbed = chunks;
    if (this.embedCache) {
      const hashes = chunks.map(c => contentHash(c.contents));
      const cached = await this.embedCache.get(model, expectedDim, hashes);
      if (cached.size) {
        const hits: Chunk[] = [];
        toEmbed = [];
        for (let i = 0; i < chunks.length; i++) {
          const v = cached.get(hashes[i]);
          if (v) { chunks[i].vector = v; hits.push(chunks[i]); }
          else toEmbed.push(chunks[i]);
        }
        if (hits.length) this.store.addBatch(hits);
      }
    }
    for (let offset = 0; offset < toEmbed.length; offset += batchSize * CONCURRENT_EMBED_BATCHES) {
      const groups: Chunk[][] = [];
      for (let k = 0; k < CONCURRENT_EMBED_BATCHES; k++) {
        const s = offset + k * batchSize;
        if (s >= toEmbed.length) break;
        groups.push(toEmbed.slice(s, Math.min(s + batchSize, toEmbed.length)));
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
        void this.embedCache?.put(model, expectedDim, g.map((c, i) => ({ hash: contentHash(c.contents), vector: vs[i] })));
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
      // Containment: agent-reachable — must not read outside the workspace.
      let fullPath: string;
      try {
        fullPath = resolveWorkspacePath(this.workspaceRoot, filePath);
      } catch {
        return `Cannot read '${filePath}': path is outside the workspace.`;
      }
      if (isKeyishPath(filePath.replace(/\\/g, "/"))) {
        return `Cannot read '${filePath}': credential-like files are blocked.`;
      }
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

  /**
   * Export the current index as a shareable artifact (gzipped snapshot of the
   * store with a manifest). Teammates install it with `oce pull-index` and
   * reconcile their local diff with a normal incremental index — the file-hash
   * table travels inside the artifact, so only changed files re-embed.
   */
  async exportIndex(destFile: string): Promise<IndexArtifactManifest> {
    return this.withLock(async () => {
      let git: IndexArtifactManifest["git"];
      try {
        const g = await getGitState(this.workspaceRoot);
        if (g.available) git = { branch: g.branch, commit: g.commit };
      } catch {}
      const manifest: IndexArtifactManifest = {
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        embeddingProvider: this.embeddingConfig.provider,
        embeddingModel: this.embeddingConfig.model,
        dimension: this.embedder.getDimension(),
        chunkCount: this.getChunkCount(),
        fileCount: this.store.getIndexedPaths().length,
        ...(git ? { git } : {}),
      };
      this.store.setMetaValue(ARTIFACT_MANIFEST_KEY, JSON.stringify(manifest));
      const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-export-"));
      try {
        const snapshot = path.join(tmp, "context.db");
        await this.store.backupTo(snapshot);
        await packArtifact(snapshot, destFile);
      } finally {
        await fs.promises.rm(tmp, { recursive: true, force: true });
      }
      return manifest;
    });
  }

  close(): void {
    try { this.chunker?.dispose(); } catch {}
    // Workers are unref'd so this never blocks exit; terminate is async
    // cleanup we intentionally do not await in a sync close.
    try { void this.chunkPool?.destroy(); } catch {}
    this.chunkPool = null;
    try { this.embedCache?.close(); } catch {}
    this.embedCache = null;
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
