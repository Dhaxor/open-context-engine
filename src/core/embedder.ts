import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import { EmbeddingConfig } from "./types";

export type EmbeddingInputType = "document" | "query";

export interface EmbeddingProvider {
  embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]>;
  getDimension(): number;
  getModel(): string;
}

interface RetryOptions { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; }
const DEFAULT_RETRY: RetryOptions = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 15000 };
const VOYAGE_MAX_BATCH_CHARS = 100_000;

function shouldRetryStatus(status: number | undefined): boolean {
  return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

async function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function retry<T>(label: string, fn: () => Promise<T>, opts: RetryOptions = DEFAULT_RETRY): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err: any) {
      lastErr = err;
      const status: number | undefined = err?.status ?? err?.response?.status;
      const retryable = status === undefined || shouldRetryStatus(status);
      if (!retryable || attempt === opts.maxAttempts) break;
      const jitter = Math.random() * 0.3 + 0.85;
      const delay = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(2, attempt - 1)) * jitter;
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label}: ${String(lastErr)}`);
}

export function chunkTextsByBatchBudget(texts: string[], maxItems: number, maxBatchChars: number): string[][] {
  const batches: string[][] = [];
  const itemLimit = Math.max(1, maxItems);
  const charLimit = Math.max(1, maxBatchChars);
  let current: string[] = [];
  let currentChars = 0;

  for (const text of texts) {
    const chars = text.length;
    if (current.length > 0 && (current.length >= itemLimit || currentChars + chars > charLimit)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += chars;
    if (current.length >= itemLimit) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private _client: OpenAI | null = null;
  private _apiKey: string;
  private _baseUrl: string | undefined;
  private model: string;
  private dimension: number;
  private batchSize: number;

  constructor(config: EmbeddingConfig) {
    this._apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
    this._baseUrl = config.baseUrl;
    this.model = config.model || "text-embedding-3-small";
    this.dimension = config.dimension || 1536;
    this.batchSize = config.batchSize || 100;
  }

  private getClient(): OpenAI {
    if (!this._client) {
      if (!this._apiKey) throw new Error("OPENAI_API_KEY is required. Set it via environment variable or config.");
      this._client = new OpenAI({ apiKey: this._apiKey, baseURL: this._baseUrl, maxRetries: 0 });
    }
    return this._client;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const client = this.getClient();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const resp = await retry("openai.embeddings", () => client.embeddings.create({ model: this.model, input: batch, dimensions: this.dimension }));
      const sorted = [...resp.data].sort((a, b) => a.index - b.index).map(d => d.embedding);
      out.push(...sorted);
    }
    return out;
  }

  getDimension(): number { return this.dimension; }
  getModel(): string { return this.model; }
}

class HTTPError extends Error {
  constructor(public status: number, public body: string, msg: string) { super(msg); }
}

/**
 * True when an embedding failure is an authentication/authorization problem
 * (bad or missing API key). These are config errors: every subsequent batch
 * would fail identically, so indexing should abort immediately with a clear
 * message instead of "resiliently" burning through hundreds of doomed batches.
 */
export function isAuthError(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  // A present numeric status is authoritative: a 500 whose body happens to
  // echo "HTTP 401" (gateway error pages do this) must NOT classify as auth.
  if (typeof status === "number") return status === 401 || status === 403;
  const msg = err instanceof Error ? err.message : String(err);
  // Matches the providers' real missing-key messages: "VOYAGE_API_KEY is
  // required...", "OPENAI_API_KEY is required..." (underscore), and any
  // future "API key is required" phrasing (space).
  return /HTTP 40[13]\b/.test(msg) || /API[_ ]?KEY is required/i.test(msg);
}

async function postJSON(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!resp.ok) {
    const text = await resp.text();
    throw new HTTPError(resp.status, text, `HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  return resp.json();
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string; private model: string; private dimension: number; private batchSize: number; private baseUrl: string;

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey || process.env.VOYAGE_API_KEY || "";
    this.model = config.model || "voyage-code-3";
    this.dimension = config.dimension || 1024;
    this.batchSize = config.batchSize || 32;
    this.baseUrl = (config.baseUrl || "https://api.voyageai.com/v1").replace(/\/$/, "");
  }

  async embed(texts: string[], inputType: EmbeddingInputType = "document"): Promise<number[][]> {
    if (!this.apiKey) throw new Error("VOYAGE_API_KEY is required. Set it via environment variable or config.");
    const out: number[][] = [];
    for (const batch of chunkTextsByBatchBudget(texts, this.batchSize, VOYAGE_MAX_BATCH_CHARS)) {
      const json: any = await retry("voyage.embeddings", () => postJSON(
        `${this.baseUrl}/embeddings`,
        { Authorization: `Bearer ${this.apiKey}` },
        { model: this.model, input: batch, input_type: inputType },
      ));
      const sorted = [...json.data].sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
      out.push(...sorted);
    }
    return out;
  }

  getDimension(): number { return this.dimension; }
  getModel(): string { return this.model; }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string; private model: string; private dimension: number; private batchSize: number;

  constructor(config: EmbeddingConfig) {
    this.baseUrl = (config.baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
    this.model = config.model || "nomic-embed-text";
    this.dimension = config.dimension || 768;
    this.batchSize = config.batchSize || 64;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const json: any = await retry("ollama.embed", () => postJSON(
        `${this.baseUrl}/api/embed`,
        {},
        { model: this.model, input: batch },
      ));
      if (!Array.isArray(json.embeddings)) throw new Error("Ollama: unexpected response shape (missing embeddings[])");
      out.push(...json.embeddings);
    }
    return out;
  }

  getDimension(): number { return this.dimension; }
  getModel(): string { return this.model; }
}

// --- Fully-local, in-process embeddings (zero API key, zero server) ---

/** Loader seam so tests can stub the optional dependency. */
let transformersLoader: () => Promise<any> = () => import("@huggingface/transformers" as string);
export function __setTransformersLoaderForTests(loader: (() => Promise<any>) | null): void {
  transformersLoader = loader ?? (() => import("@huggingface/transformers" as string));
}

/** Where downloaded ONNX models live. Override with OCE_MODEL_DIR. */
export function localModelCacheDir(): string {
  return process.env.OCE_MODEL_DIR || path.join(os.homedir(), ".open-context", "models");
}

/**
 * In-process embeddings via @huggingface/transformers (ONNX Runtime).
 * The model downloads once into localModelCacheDir() and runs offline after
 * that — "no code leaves your machine" with no Ollama install required.
 *
 * The dependency is an optional peer (~ tens of MB with onnxruntime), so it is
 * imported lazily and a missing install produces one actionable error instead
 * of a resolve crash at require time.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private pipePromise: Promise<any> | null = null;
  private model: string;
  private dimension: number;
  private batchSize: number;

  constructor(config: EmbeddingConfig) {
    this.model = config.model || "Xenova/all-MiniLM-L6-v2";
    this.dimension = config.dimension || 384;
    this.batchSize = config.batchSize || 16;
  }

  private getPipe(): Promise<any> {
    if (!this.pipePromise) {
      this.pipePromise = (async () => {
        let transformers: any;
        try {
          transformers = await transformersLoader();
        } catch {
          throw new Error(
            "Local embeddings need the optional dependency '@huggingface/transformers'. " +
            "Install it with: npm install @huggingface/transformers " +
            "(first run downloads the model to " + localModelCacheDir() + ", offline afterwards).",
          );
        }
        if (transformers.env) transformers.env.cacheDir = localModelCacheDir();
        // q8 quantization: ~4x smaller download, near-identical retrieval quality.
        return transformers.pipeline("feature-extraction", this.model, { dtype: "q8" });
      })();
      // A failed load must be retryable (e.g. user installs the package mid-session).
      this.pipePromise.catch(() => { this.pipePromise = null; });
    }
    return this.pipePromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipe();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await pipe(batch, { pooling: "mean", normalize: true });
      const vectors: number[][] = typeof res.tolist === "function" ? res.tolist() : res;
      out.push(...vectors);
    }
    return out;
  }

  getDimension(): number { return this.dimension; }
  getModel(): string { return this.model; }
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "openai": return new OpenAIEmbeddingProvider(config);
    case "voyage": return new VoyageEmbeddingProvider(config);
    case "ollama": return new OllamaEmbeddingProvider(config);
    case "local": return new LocalEmbeddingProvider(config);
    default: throw new Error(`Unknown embedding provider: ${(config as any).provider}`);
  }
}