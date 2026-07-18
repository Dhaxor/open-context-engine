import { describe, it, expect } from "vitest";
import { HybridRetriever } from "./retriever";
import { StreamingRetriever, StreamingResult } from "./streaming-retriever";
import { QueryCache } from "./query-cache";
import { EmbeddingProvider } from "./embedder";
import { Chunk, SearchResult } from "./types";

/** Duck-typed store: BM25 answers instantly, vector answers after the
 *  (deliberately slow) embed — exactly the shape real queries have. */
function fakeStore(bm25: SearchResult[], vector: SearchResult[]) {
  return {
    isVectorAvailable: () => true,
    bm25Search: () => bm25,
    vectorSearch: () => vector,
    getIndexedPaths: () => [],
    getChunksBySymbol: () => [],
    getChunksByParentSymbol: () => [],
    getChunksNear: () => [],
    getChunksByPath: () => [],
  } as any;
}

function result(id: string, score = 1): SearchResult {
  const chunk: Chunk = { id, path: `src/${id}.ts`, startLine: 1, endLine: 3, contents: `// ${id}` };
  return { chunk, score };
}

function slowEmbedder(delayMs: number): EmbeddingProvider {
  return {
    embed: async (texts) => {
      await new Promise(r => setTimeout(r, delayMs));
      return texts.map(() => [1, 0, 0, 0]);
    },
    getDimension: () => 4,
    getModel: () => "mock",
  };
}

function makeStreaming(embedDelayMs: number) {
  const store = fakeStore([result("kw1"), result("kw2")], [result("vec1")]);
  const retriever = new HybridRetriever(store, slowEmbedder(embedDelayMs), { topK: 10, maxOutputLength: 10_000, minScore: 0 }, undefined, new QueryCache(4));
  return new StreamingRetriever(retriever);
}

describe("StreamingRetriever (incremental)", () => {
  it("yields bm25 BEFORE the embed completes, then vector/fused/final in order", async () => {
    const EMBED_DELAY = 120;
    const streaming = makeStreaming(EMBED_DELAY);
    const events: StreamingResult[] = [];
    for await (const ev of streaming.retrieveWithStages("query text", { expandSymbols: false })) {
      events.push(ev);
    }
    expect(events.map(e => e.stage)).toEqual(["bm25", "vector", "fused", "final"]);

    // The whole point: bm25 must arrive while the embedding is still in flight.
    const bm25 = events.find(e => e.stage === "bm25")!;
    expect(bm25.elapsed).toBeLessThan(EMBED_DELAY);
    expect(bm25.results.map(r => r.chunk.id)).toEqual(["kw1", "kw2"]);

    const vector = events.find(e => e.stage === "vector")!;
    expect(vector.elapsed).toBeGreaterThanOrEqual(EMBED_DELAY - 15); // waited on the embed

    const final = events[events.length - 1];
    expect(final.isFinal).toBe(true);
    expect(final.results.length).toBeGreaterThan(0);
  });

  it("supports slow consumers without dropping stages", async () => {
    const streaming = makeStreaming(30);
    const stages: string[] = [];
    for await (const ev of streaming.retrieveWithStages("q", { expandSymbols: false })) {
      stages.push(ev.stage);
      await new Promise(r => setTimeout(r, 25)); // consumer slower than producer
    }
    expect(stages).toEqual(["bm25", "vector", "fused", "final"]);
  });

  it("propagates pipeline errors to the iterator", async () => {
    const store = fakeStore([], []);
    store.bm25Search = () => { throw new Error("fts exploded"); };
    const retriever = new HybridRetriever(store, slowEmbedder(5), { topK: 10, maxOutputLength: 10_000, minScore: 0 }, undefined, new QueryCache(4));
    const streaming = new StreamingRetriever(retriever);
    await expect(async () => {
      for await (const _ of streaming.retrieveWithStages("q")) { /* drain */ }
    }).rejects.toThrow(/fts exploded/);
  });

  it("retrieve() single-shot form still works", async () => {
    const streaming = makeStreaming(5);
    const events: StreamingResult[] = [];
    for await (const ev of streaming.retrieve("q", { expandSymbols: false })) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0].isFinal).toBe(true);
  });
});
