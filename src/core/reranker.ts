import { Chunk, RerankerConfig, SearchResult } from "./types";
import { parseRetryAfterMs } from "./embedder";

export interface Reranker {
  rerank(query: string, chunks: Chunk[], topK: number): Promise<SearchResult[]>;
  getProvider(): string;
  getModel(): string;
}

interface RerankRetryOptions { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; }
const DEFAULT_RETRY: RerankRetryOptions = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 10000 };
/** Reranking sits on the query hot path — time out fast and fall back to fused order. */
const HTTP_TIMEOUT_MS = 30_000;

function shouldRetry(status: number | undefined): boolean {
  return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

async function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function retry<T>(fn: () => Promise<T>, opts: RerankRetryOptions = DEFAULT_RETRY): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      if (status !== undefined && !shouldRetry(status)) break;
      if (attempt === opts.maxAttempts) break;
      const jitter = Math.random() * 0.3 + 0.85;
      let delay = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(2, attempt - 1)) * jitter;
      const retryAfter: number | undefined = err?.retryAfterMs;
      if (retryAfter !== undefined) delay = Math.max(delay, retryAfter);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class VoyageReranker implements Reranker {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: RerankerConfig) {
    this.apiKey = config.apiKey || process.env.VOYAGE_API_KEY || "";
    this.model = config.model || "rerank-2";
    this.baseUrl = (config.baseUrl || "https://api.voyageai.com/v1").replace(/\/$/, "");
  }

  getProvider(): string { return "voyage"; }
  getModel(): string { return this.model; }

  async rerank(query: string, chunks: Chunk[], topK: number): Promise<SearchResult[]> {
    if (!this.apiKey) throw new Error("VOYAGE_API_KEY is required for reranker");
    if (!chunks.length) return [];
    const documents = chunks.map(c => chunkToDocument(c));
    const MAX_CHUNK_CHARS = 6000;
    const truncated = documents.map(d => d.length > MAX_CHUNK_CHARS ? d.slice(0, MAX_CHUNK_CHARS) : d);
    const body = {
      model: this.model,
      query,
      documents: truncated,
      top_k: Math.min(topK, chunks.length),
      return_documents: false,
    };
    const json: any = await retry(async () => {
      const resp = await fetch(`${this.baseUrl}/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const text = await resp.text();
        const err: any = new Error(`Voyage rerank HTTP ${resp.status}: ${text.slice(0, 300)}`);
        err.status = resp.status;
        err.retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
        throw err;
      }
      return resp.json();
    });
    const ranked = (json.data ?? []).map((d: any) => ({
      chunk: chunks[d.index],
      score: d.relevance_score,
      rerankScore: d.relevance_score,
    }));
    return ranked;
  }
}

export class CohereReranker implements Reranker {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: RerankerConfig) {
    this.apiKey = config.apiKey || process.env.COHERE_API_KEY || "";
    this.model = config.model || "rerank-english-v3.0";
    this.baseUrl = (config.baseUrl || "https://api.cohere.com").replace(/\/$/, "");
  }

  getProvider(): string { return "cohere"; }
  getModel(): string { return this.model; }

  async rerank(query: string, chunks: Chunk[], topK: number): Promise<SearchResult[]> {
    if (!this.apiKey) throw new Error("COHERE_API_KEY is required for reranker");
    if (!chunks.length) return [];
    const documents = chunks.map(c => chunkToDocument(c).slice(0, 6000));
    const body = { model: this.model, query, documents, top_n: Math.min(topK, chunks.length) };
    const json: any = await retry(async () => {
      const resp = await fetch(`${this.baseUrl}/v2/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const text = await resp.text();
        const err: any = new Error(`Cohere rerank HTTP ${resp.status}: ${text.slice(0, 300)}`);
        err.status = resp.status;
        err.retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
        throw err;
      }
      return resp.json();
    });
    return (json.results ?? []).map((d: any) => ({
      chunk: chunks[d.index],
      score: d.relevance_score,
      rerankScore: d.relevance_score,
    }));
  }
}

/**
 * In-process cross-encoder reranker (ONNX via the optional
 * @huggingface/transformers dep) — reranking quality without any cloud key,
 * completing the fully-local retrieval story: local embeddings + BM25 +
 * local rerank. ms-marco-MiniLM-L-6-v2 is the standard small cross-encoder:
 * ~23M params, comfortably fast on CPU for the ≤64 candidates we rerank.
 */
export class LocalReranker implements Reranker {
  private model: string;
  private loaded: Promise<{ tokenizer: any; model: any }> | null = null;

  constructor(config: RerankerConfig) {
    this.model = config.model || "Xenova/ms-marco-MiniLM-L-6-v2";
  }

  getProvider(): string { return "local"; }
  getModel(): string { return this.model; }

  private load(): Promise<{ tokenizer: any; model: any }> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const { loadTransformersModule, localModelCacheDir } = await import("./embedder");
        const transformers = await loadTransformersModule("The local reranker");
        if (transformers.env) transformers.env.cacheDir = localModelCacheDir();
        const tokenizer = await transformers.AutoTokenizer.from_pretrained(this.model);
        const model = await transformers.AutoModelForSequenceClassification.from_pretrained(this.model, { dtype: "q8" });
        return { tokenizer, model };
      })();
      this.loaded.catch(() => { this.loaded = null; }); // retryable after install
    }
    return this.loaded;
  }

  async rerank(query: string, chunks: Chunk[], topK: number): Promise<SearchResult[]> {
    if (!chunks.length) return [];
    const { tokenizer, model } = await this.load();
    const docs = chunks.map(c => chunkToDocument(c).slice(0, 6000));
    const scores: number[] = [];
    const BATCH = 8;
    for (let i = 0; i < docs.length; i += BATCH) {
      const batch = docs.slice(i, i + BATCH);
      const inputs = tokenizer(new Array(batch.length).fill(query), {
        text_pair: batch,
        padding: true,
        truncation: true,
      });
      const output = await model(inputs);
      const logits: ArrayLike<number> = output.logits.data;
      for (let j = 0; j < batch.length; j++) {
        scores.push(1 / (1 + Math.exp(-Number(logits[j])))); // sigmoid → [0,1]
      }
    }
    return chunks
      .map((chunk, i) => ({ chunk, score: scores[i], rerankScore: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(topK, chunks.length));
  }
}

export function createReranker(config?: RerankerConfig): Reranker | undefined {
  if (!config || config.provider === "none") return undefined;
  if (config.provider === "voyage") return new VoyageReranker(config);
  if (config.provider === "cohere") return new CohereReranker(config);
  if (config.provider === "local") return new LocalReranker(config);
  return undefined;
}

function chunkToDocument(c: Chunk): string {
  const header = c.symbolName
    ? `// ${c.path}:${c.startLine}-${c.endLine} — ${c.symbolKind ?? "chunk"} ${c.symbolName}`
    : `// ${c.path}:${c.startLine}-${c.endLine}`;
  return `${header}\n${c.contents}`;
}
