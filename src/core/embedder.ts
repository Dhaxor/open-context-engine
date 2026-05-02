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
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
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

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case "openai": return new OpenAIEmbeddingProvider(config);
    case "voyage": return new VoyageEmbeddingProvider(config);
    case "ollama": return new OllamaEmbeddingProvider(config);
    default: throw new Error(`Unknown embedding provider: ${(config as any).provider}`);
  }
}