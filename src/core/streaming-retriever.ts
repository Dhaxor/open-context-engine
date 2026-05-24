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
    // Run the pipeline once; retrieveDebug carries both the intermediate stages
    // and the full final results, so we don't re-run (and re-rerank) the query.
    const debug = await this.retriever.retrieveDebug(query, opts);
    const preview = (d: { path: string; score: number; preview: string }) =>
      ({ chunk: { id: d.path, path: d.path, startLine: 0, endLine: 0, contents: d.preview }, score: d.score });

    yield { stage: "vector", results: debug.vectorHits.map(preview), isFinal: false, elapsed: Date.now() - start };
    yield { stage: "bm25", results: debug.bm25Hits.map(preview), isFinal: false, elapsed: Date.now() - start };
    yield { stage: "fused", results: debug.fused.map(preview), isFinal: false, elapsed: Date.now() - start };
    yield { stage: "final", results: debug.finalResults, isFinal: true, elapsed: Date.now() - start };
  }
}
