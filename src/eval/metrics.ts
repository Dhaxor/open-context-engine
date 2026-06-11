/**
 * Pure retrieval-quality metrics, file-granular.
 *
 * The engine returns ranked chunks; for evaluation we collapse them to a
 * ranked list of unique file paths (first occurrence keeps the rank) and
 * compare against a gold set of expected paths. File granularity is the
 * honest level for a context engine: "did the right file make it into the
 * context window" is what decides whether the LLM can answer, and gold
 * line-ranges churn too fast to maintain.
 *
 * All @k metrics apply k to the deduped FILE ranking, not the chunk list.
 */

export interface CaseMetrics {
  /** |retrieved∩gold| / |gold|, within the top-k files. */
  recall: number;
  /** 1 / rank of the first gold file (1-based), 0 when none retrieved. */
  reciprocalRank: number;
  /** Binary-relevance nDCG@k. 0 when no gold file retrieved. */
  ndcg: number;
  /** True when at least one gold file appears in the top-k. */
  hit: boolean;
  /** 1-based rank of the first gold file, or null when none retrieved. */
  firstHitRank: number | null;
}

/** Collapse a ranked chunk-path list into ranked unique file paths. */
export function dedupeRanked(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function computeCaseMetrics(rankedFiles: string[], goldPaths: string[], k: number): CaseMetrics {
  const gold = new Set(goldPaths);
  if (!gold.size || k <= 0) {
    return { recall: 0, reciprocalRank: 0, ndcg: 0, hit: false, firstHitRank: null };
  }
  const top = rankedFiles.slice(0, k);

  let hits = 0;
  let firstHitRank: number | null = null;
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    if (!gold.has(top[i])) continue;
    hits++;
    const rank = i + 1;
    if (firstHitRank === null) firstHitRank = rank;
    dcg += 1 / Math.log2(rank + 1);
  }

  // Ideal DCG: all gold files stacked at the top, capped at k positions.
  let idcg = 0;
  const idealHits = Math.min(gold.size, k);
  for (let rank = 1; rank <= idealHits; rank++) idcg += 1 / Math.log2(rank + 1);

  return {
    recall: hits / gold.size,
    reciprocalRank: firstHitRank === null ? 0 : 1 / firstHitRank,
    ndcg: idcg > 0 ? dcg / idcg : 0,
    hit: firstHitRank !== null,
    firstHitRank,
  };
}

export interface AggregateMetrics {
  cases: number;
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
  hitRate: number;
}

export function aggregate(all: CaseMetrics[]): AggregateMetrics {
  const n = all.length;
  if (!n) return { cases: 0, recallAtK: 0, mrr: 0, ndcgAtK: 0, hitRate: 0 };
  const sum = (f: (m: CaseMetrics) => number) => all.reduce((s, m) => s + f(m), 0);
  return {
    cases: n,
    recallAtK: sum(m => m.recall) / n,
    mrr: sum(m => m.reciprocalRank) / n,
    ndcgAtK: sum(m => m.ndcg) / n,
    hitRate: sum(m => (m.hit ? 1 : 0)) / n,
  };
}
