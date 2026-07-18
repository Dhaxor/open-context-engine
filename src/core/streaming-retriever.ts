import { SearchResult } from "./types";
import { HybridRetriever, RetrieveOptions } from "./retriever";

/**
 * Genuinely incremental retrieval: each pipeline stage is yielded the moment
 * it exists, not replayed after the fact. On a typical query the timeline is
 *
 *   bm25      ~1-5ms    (synchronous SQLite FTS — before any network)
 *   vector    +embed round-trip
 *   fused     +~1ms
 *   reranked  +rerank round-trip (only when a reranker is configured)
 *   final     minScore floor + graph/symbol expansion applied
 *
 * Consumers can paint first results immediately and refine as stages land.
 */
export interface StreamingResult {
  stage: "vector" | "bm25" | "fused" | "reranked" | "expanded" | "final";
  results: SearchResult[];
  isFinal: boolean;
  elapsed: number;
}

export class StreamingRetriever {
  constructor(private retriever: HybridRetriever) {}

  /** Single-shot form: one final yield (kept for API compatibility). */
  async *retrieve(query: string, opts: RetrieveOptions = {}): AsyncGenerator<StreamingResult> {
    const start = Date.now();
    const results = await this.retriever.retrieve(query, opts);
    yield { stage: "final", results, isFinal: true, elapsed: Date.now() - start };
  }

  /** Incremental form: yields every stage as the pipeline produces it. */
  async *retrieveWithStages(query: string, opts: RetrieveOptions = {}): AsyncGenerator<StreamingResult> {
    const start = Date.now();
    const queue: StreamingResult[] = [];
    let notify: (() => void) | null = null;
    let error: unknown;
    const push = (stage: StreamingResult["stage"], results: SearchResult[], isFinal = false): void => {
      queue.push({ stage, results, isFinal, elapsed: Date.now() - start });
      notify?.();
    };

    // The pipeline runs ONCE; stage callbacks feed the queue while the
    // returned promise supplies the final (floored + expanded) results.
    void this.retriever
      .retrieve(query, { ...opts, onStage: (stage, results) => push(stage, results) })
      .then(results => push("final", results, true))
      .catch(err => { error = err; notify?.(); });

    while (true) {
      while (queue.length) {
        const item = queue.shift()!;
        yield item;
        if (item.isFinal) return;
      }
      if (error) throw error;
      await new Promise<void>(resolve => { notify = resolve; });
      notify = null;
    }
  }
}
