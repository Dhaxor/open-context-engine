import { SearchResult } from "./types";
import { HybridRetriever, RetrieveOptions } from "./retriever";

export interface StreamingResult {
  stage: "vector" | "bm25" | "fused" | "reranked" | "expanded" | "final";
  results: SearchResult[];
  isFinal: boolean;
  elapsed: number;
}

export class StreamingRetriever {
  constructor(private retriever: HybridRetriever) {}

  async *retrieve(query: string, opts: RetrieveOptions = {}): AsyncGenerator<StreamingResult> {
    const start = Date.now();
    const results = await this.retriever.retrieve(query, opts);
    yield {
      stage: "final",
      results,
      isFinal: true,
      elapsed: Date.now() - start,
    };
  }

  async *retrieveWithStages(query: string, opts: RetrieveOptions = {}): AsyncGenerator<StreamingResult> {
    const start = Date.now();
    const debug = await this.retriever.retrieveDebug(query, opts);

    yield {
      stage: "vector",
      results: debug.vectorHits.map(d => ({ chunk: { id: d.path, path: d.path, startLine: 0, endLine: 0, contents: d.preview }, score: d.score })),
      isFinal: false,
      elapsed: Date.now() - start,
    };

    yield {
      stage: "bm25",
      results: debug.bm25Hits.map(d => ({ chunk: { id: d.path, path: d.path, startLine: 0, endLine: 0, contents: d.preview }, score: d.score })),
      isFinal: false,
      elapsed: Date.now() - start,
    };

    yield {
      stage: "fused",
      results: debug.fused.map(d => ({ chunk: { id: d.path, path: d.path, startLine: 0, endLine: 0, contents: d.preview }, score: d.score })),
      isFinal: false,
      elapsed: Date.now() - start,
    };

    const finalResults = await this.retriever.retrieve(query, opts);
    yield {
      stage: "final",
      results: finalResults,
      isFinal: true,
      elapsed: Date.now() - start,
    };
  }
}
