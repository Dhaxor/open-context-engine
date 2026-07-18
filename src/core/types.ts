export interface File { path: string; contents: string; }

export type SymbolKind = "function" | "method" | "class" | "interface" | "type" | "enum" | "struct" | "module" | "namespace" | "variable" | "field" | "chunk";

export interface Chunk {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  contents: string;
  vector?: number[];
  symbolName?: string;
  symbolKind?: SymbolKind;
  parentSymbol?: string;
  language?: string;
}

export interface ChunkMetadata {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
  symbolName?: string;
  symbolKind?: SymbolKind;
  parentSymbol?: string;
  language?: string;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
  vectorScore?: number;
  bm25Score?: number;
  rerankScore?: number;
}

export interface IndexingResult {
  newlyIndexed: string[];
  alreadyIndexed: string[];
  removed: string[];
  duration: number;
  /** Files whose embedding failed this run. Their hashes are NOT recorded, so
   *  the next incremental index retries exactly these. Absent/empty = clean run. */
  failed?: string[];
  /** First failure message, for surfacing to the user. */
  failedReason?: string;
}
export interface OpenContextState { version: 1; files: FileIndexEntry[]; storePath: string; workspaceRoot: string; lastSynced: string; embeddingProvider: string; embeddingModel: string; embeddingDimension: number; }
export interface FileIndexEntry { path: string; hash: string; chunkIds: string[]; lastModified: number; }
export interface GitState { available: boolean; branch?: string; commit?: string; gitDir?: string; }
export interface IndexMetadata { lastIndexedAt?: number; git?: GitState; }
export interface FreshnessReport {
  state: "fresh" | "stale";
  stale: boolean;
  checkedAt: number;
  lastIndexedAt?: number;
  added: string[];
  changed: string[];
  removed: string[];
  hiddenPathCount: number;
  reasons: string[];
  git: { indexed?: GitState; current: GitState; changed: boolean };
}
export interface EmbeddingConfig { provider: "openai" | "voyage" | "ollama" | "local"; model: string; apiKey?: string; baseUrl?: string; dimension: number; batchSize: number; }
export interface RerankerConfig { provider: "voyage" | "cohere" | "local" | "none"; model?: string; apiKey?: string; baseUrl?: string; }
export interface SearchConfig {
  topK: number;
  maxOutputLength: number;
  minScore: number;
  candidateK?: number;
  bm25Weight?: number;
  vectorWeight?: number;
  rerank?: boolean;
  expandSymbols?: boolean;
  recencyWeight?: number;
  queryCacheSize?: number;
}
export interface OpenContextConfig {
  workspaceRoot: string;
  embedding: EmbeddingConfig;
  /** Bring-your-own embedding provider. When set, `embedding` is only used for
   *  bookkeeping (provider/model names in status); all embed calls go here.
   *  Type-only import — no runtime cycle with embedder.ts. */
  embedder?: import("./embedder").EmbeddingProvider;
  reranker?: RerankerConfig;
  search?: Partial<SearchConfig>;
  storePath?: string;
  maxFileSize?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  /** Advanced/test seam: override how the sqlite-vec extension path is
   *  resolved. Pointing at a nonexistent path forces keyword-only mode. */
  resolveVecPath?: () => string;
  /** Policy controls. Default (undefined): load from the standard policy files
   *  (user + workspace + org lock — see core/policy.ts). Pass an
   *  EffectivePolicy to inject one, or `false` to skip policy loading entirely.
   *  Type-only import — no runtime cycle with policy.ts. */
  policy?: import("./policy").EffectivePolicy | false;
  /** Worker threads for parse/chunk during indexing. `false` disables;
   *  a number pins the worker count; undefined = auto (workers when the
   *  compiled worker script exists and the machine has ≥4 cores). */
  parallelism?: number | false;
  /** Persistent embedding cache keyed by (model, dim, content-hash).
   *  `true` = ~/.open-context/embed-cache.db (OCE_EMBED_CACHE overrides), a
   *  string relocates it. Default: OFF for library embedders (deterministic
   *  provider traffic); the CLI and extension turn it on. */
  embedCache?: boolean | string;
}
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = { provider: "voyage", model: "voyage-code-3", dimension: 1024, batchSize: 32 };
export const DEFAULT_SEARCH_CONFIG: SearchConfig = { topK: 15, maxOutputLength: 80000, minScore: 0.0, candidateK: 60, bm25Weight: 1.0, vectorWeight: 1.0, rerank: true, expandSymbols: true };
export const DEFAULT_CHUNK_CONFIG = { chunkSize: 80, chunkOverlap: 15 };
export const MAX_FILE_SIZE = 1_048_576;
export const MAX_CHUNK_CHARS = 80000;
export const EMBEDDING_MODELS: Record<string, { provider: string; model: string; dimension: number; maxTokens: number; batchSize: number }> = {
  "voyage-code-3": { provider: "voyage", model: "voyage-code-3", dimension: 1024, maxTokens: 32000, batchSize: 32 },
  "text-embedding-3-large": { provider: "openai", model: "text-embedding-3-large", dimension: 3072, maxTokens: 8192, batchSize: 100 },
  "text-embedding-3-small": { provider: "openai", model: "text-embedding-3-small", dimension: 1536, maxTokens: 8192, batchSize: 100 },
  "nomic-embed-text": { provider: "ollama", model: "nomic-embed-text", dimension: 768, maxTokens: 8192, batchSize: 1 },
  // In-process ONNX models (zero API key, zero server — see LocalEmbeddingProvider).
  "all-MiniLM-L6-v2": { provider: "local", model: "Xenova/all-MiniLM-L6-v2", dimension: 384, maxTokens: 512, batchSize: 16 },
  "jina-embeddings-v2-base-code": { provider: "local", model: "Xenova/jina-embeddings-v2-base-code", dimension: 768, maxTokens: 8192, batchSize: 8 },
};
/** Default model per provider when the CLI/extension is given only a provider name. */
export const DEFAULT_MODEL_FOR_PROVIDER: Record<EmbeddingConfig["provider"], string> = {
  voyage: "voyage-code-3",
  openai: "text-embedding-3-small",
  ollama: "nomic-embed-text",
  local: "jina-embeddings-v2-base-code",
};
