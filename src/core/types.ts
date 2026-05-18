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

export interface IndexingResult { newlyIndexed: string[]; alreadyIndexed: string[]; removed: string[]; duration: number; }
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
export interface EmbeddingConfig { provider: "openai" | "voyage" | "ollama"; model: string; apiKey?: string; baseUrl?: string; dimension: number; batchSize: number; }
export interface RerankerConfig { provider: "voyage" | "cohere" | "none"; model?: string; apiKey?: string; baseUrl?: string; }
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
  reranker?: RerankerConfig;
  search?: Partial<SearchConfig>;
  storePath?: string;
  maxFileSize?: number;
  chunkSize?: number;
  chunkOverlap?: number;
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
};
