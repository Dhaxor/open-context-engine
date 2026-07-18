import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "./sqlite-store";
import { HybridRetriever } from "./retriever";
import { StreamingRetriever } from "./streaming-retriever";
import { EmbeddingProvider } from "./embedder";
import { Reranker } from "./reranker";
import { Chunk, SearchConfig, SearchResult } from "./types";

const DIM = 4;

function makeVec(seed: number): number[] {
  const v = new Array(DIM).fill(0).map((_, i) => Math.sin(seed + i * 0.37));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function chunk(id: string, contents: string): Chunk {
  return { id, path: `src/${id}.ts`, startLine: 1, endLine: 5, contents, vector: makeVec(id.charCodeAt(0)) };
}

const embedder: EmbeddingProvider = {
  embed: async (texts) => texts.map((_, i) => makeVec(100 + i)),
  getDimension: () => DIM,
  getModel: () => "fake",
};

const config: SearchConfig = {
  topK: 5, maxOutputLength: 80000, minScore: 0, candidateK: 20,
  bm25Weight: 1, vectorWeight: 1, rerank: true, expandSymbols: false,
};

let store: SqliteStore;
let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "retriever-int-"));
  store = new SqliteStore(dir, DIM);
  await store.initialize();
  store.addBatch([
    chunk("alpha", "function authenticate(token: string) { return verify(token); }"),
    chunk("beta", "function renderButton() { return html; }"),
    chunk("gamma", "class TokenVerifier { verify(token: string) {} }"),
  ]);
});

afterEach(async () => {
  try { store.close(); } catch {}
  try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
});

describe("HybridRetriever reranker resilience", () => {
  it("falls back to fused results when the reranker throws", async () => {
    const boom: Reranker = {
      rerank: async () => { throw new Error("rerank API down"); },
      getProvider: () => "boom", getModel: () => "boom",
    };
    const retriever = new HybridRetriever(store, embedder, config, boom);
    const results = await retriever.retrieve("authenticate token");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => !!r.chunk.id)).toBe(true);
  });

  it("falls back when the reranker returns nothing", async () => {
    const empty: Reranker = {
      rerank: async () => [],
      getProvider: () => "empty", getModel: () => "empty",
    };
    const retriever = new HybridRetriever(store, embedder, config, empty);
    const results = await retriever.retrieve("authenticate token");
    expect(results.length).toBeGreaterThan(0);
  });

  it("uses reranker ordering when it succeeds", async () => {
    const reorder: Reranker = {
      rerank: async (_q, chunks): Promise<SearchResult[]> => {
        const gamma = chunks.find(c => c.id === "gamma")!;
        return [{ chunk: gamma, score: 0.99, rerankScore: 0.99 }];
      },
      getProvider: () => "reorder", getModel: () => "reorder",
    };
    const retriever = new HybridRetriever(store, embedder, config, reorder);
    const results = await retriever.retrieve("anything");
    expect(results[0].chunk.id).toBe("gamma");
  });
});

describe("StreamingRetriever", () => {
  it("runs the pipeline once (reranker invoked a single time) and yields a final stage", async () => {
    let calls = 0;
    const counting: Reranker = {
      rerank: async (_q, chunks) => { calls++; return chunks.map((c, i) => ({ chunk: c, score: 1 / (i + 1), rerankScore: 1 / (i + 1) })); },
      getProvider: () => "counting", getModel: () => "counting",
    };
    const streaming = new StreamingRetriever(new HybridRetriever(store, embedder, config, counting));
    const stages: string[] = [];
    let final: SearchResult[] = [];
    for await (const s of streaming.retrieveWithStages("authenticate token")) {
      stages.push(s.stage);
      if (s.isFinal) final = s.results;
    }
    expect(calls).toBe(1);
    // Incremental order: bm25 (sync, first) → vector (after embed) → fused →
    // reranked (this pipeline has a reranker) → final.
    expect(stages).toEqual(["bm25", "vector", "fused", "reranked", "final"]);
    expect(final.length).toBeGreaterThan(0);
  });
});
