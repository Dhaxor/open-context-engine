/**
 * Eval runner: feed labeled queries through a search function, score the
 * ranked results against gold file paths, and aggregate.
 *
 * Deliberately decoupled from OpenContext — the runner only needs
 * `(query) => ranked results`, so tests can drive it with a fake search and
 * the CLI wires it to ctx.searchRaw. The search function should return MORE
 * results than `k` (chunks collapse into fewer unique files); the CLI
 * default requests 3x.
 */
import { SearchResult } from "../core/types";
import { CaseMetrics, AggregateMetrics, computeCaseMetrics, aggregate, dedupeRanked, packedContextRecall } from "./metrics";

export interface EvalCase {
  /** Stable identifier, used for baseline comparison. */
  id: string;
  /** The natural-language query a user/agent would issue. */
  query: string;
  /** Gold file paths (workspace-relative, forward slashes). A case passes
   *  when these appear in the top-k unique files. */
  expectedPaths: string[];
  /** Free-form note about what the case probes. Not used by the runner. */
  notes?: string;
}

export interface EvalCaseResult {
  id: string;
  query: string;
  expectedPaths: string[];
  /** Top-k unique file paths the engine returned, in rank order. */
  retrievedFiles: string[];
  metrics: CaseMetrics;
  /** Milliseconds spent in the search call. */
  elapsedMs: number;
  /** Set when the search call threw; metrics are all-zero in that case. */
  error?: string;
}

export interface EvalReport {
  generatedAt: string;
  k: number;
  caseCount: number;
  aggregate: AggregateMetrics;
  results: EvalCaseResult[];
  /** Mean per-query latency across non-erroring cases. */
  meanLatencyMs: number;
  /** Engine mode during the run. Keyword-only numbers are not comparable to
   *  hybrid baselines. Optional so pre-field reports still parse. */
  searchMode?: "hybrid" | "keyword-only";
}

export type SearchFn = (query: string) => Promise<SearchResult[]>;

export interface RunEvalOptions {
  k?: number;
  /**
   * When provided, each case ALSO runs the full search-and-pack pipeline (the
   * string actually handed to the LLM) and scores gold-file presence in it as
   * contextRecall. This is the only metric that can see contributions landing
   * below the top-k ranking — e.g. graph/symbol expansion.
   */
  packedSearch?: (query: string) => Promise<string>;
  /** Invoked after each case completes — lets the CLI stream progress. */
  onCase?: (result: EvalCaseResult, index: number, total: number) => void;
}

export async function runEval(search: SearchFn, cases: EvalCase[], opts: RunEvalOptions = {}): Promise<EvalReport> {
  const k = opts.k ?? 10;
  const results: EvalCaseResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const started = Date.now();
    let result: EvalCaseResult;
    try {
      const raw = await search(c.query);
      const rankedFiles = dedupeRanked(raw.map(r => r.chunk.path));
      const metrics = computeCaseMetrics(rankedFiles, c.expectedPaths, k);
      if (opts.packedSearch) {
        const packed = await opts.packedSearch(c.query);
        metrics.contextRecall = packedContextRecall(packed, c.expectedPaths);
      }
      result = {
        id: c.id,
        query: c.query,
        expectedPaths: c.expectedPaths,
        retrievedFiles: rankedFiles.slice(0, k),
        metrics,
        elapsedMs: Date.now() - started,
      };
    } catch (err: any) {
      result = {
        id: c.id,
        query: c.query,
        expectedPaths: c.expectedPaths,
        retrievedFiles: [],
        metrics: computeCaseMetrics([], c.expectedPaths, k),
        elapsedMs: Date.now() - started,
        error: err?.message ?? String(err),
      };
    }
    results.push(result);
    opts.onCase?.(result, i, cases.length);
  }
  const ok = results.filter(r => !r.error);
  return {
    generatedAt: new Date().toISOString(),
    k,
    caseCount: cases.length,
    aggregate: aggregate(results.map(r => r.metrics)),
    results,
    meanLatencyMs: ok.length ? ok.reduce((s, r) => s + r.elapsedMs, 0) / ok.length : 0,
  };
}

/** Validate a parsed JSON document into EvalCase[], with helpful errors. */
export function parseEvalCases(doc: unknown): EvalCase[] {
  if (!Array.isArray(doc)) {
    // Allow { cases: [...] } wrapper for future metadata.
    const wrapped = (doc as any)?.cases;
    if (!Array.isArray(wrapped)) throw new Error("Eval file must be a JSON array of cases, or { cases: [...] }");
    doc = wrapped;
  }
  const seen = new Set<string>();
  return (doc as any[]).map((raw, i) => {
    if (typeof raw?.id !== "string" || !raw.id) throw new Error(`Case ${i}: missing string "id"`);
    if (seen.has(raw.id)) throw new Error(`Case ${i}: duplicate id "${raw.id}"`);
    seen.add(raw.id);
    if (typeof raw?.query !== "string" || !raw.query.trim()) throw new Error(`Case "${raw.id}": missing string "query"`);
    const expected = raw.expectedPaths ?? raw.expected;
    if (!Array.isArray(expected) || !expected.length || !expected.every((p: unknown) => typeof p === "string" && p)) {
      throw new Error(`Case "${raw.id}": "expectedPaths" must be a non-empty string array`);
    }
    return {
      id: raw.id,
      query: raw.query,
      expectedPaths: expected.map((p: string) => p.replace(/\\/g, "/")),
      notes: typeof raw.notes === "string" ? raw.notes : undefined,
    };
  });
}

export interface CaseDelta {
  id: string;
  recall: number;
  reciprocalRank: number;
  ndcg: number;
  /** "improved" | "regressed" | "unchanged" judged on nDCG first, then RR. */
  direction: "improved" | "regressed" | "unchanged";
}

export interface EvalComparison {
  aggregate: {
    recallAtK: number;
    mrr: number;
    ndcgAtK: number;
    hitRate: number;
    /** Present only when BOTH reports evaluated packed context. */
    contextRecall?: number;
    contextHitRate?: number;
  };
  perCase: CaseDelta[];
  improved: number;
  regressed: number;
  unchanged: number;
  /** Case ids present in only one of the two reports — compared on the intersection. */
  onlyInBaseline: string[];
  onlyInCurrent: string[];
}

const EPS = 1e-9;

/** Diff two reports case-by-case (intersection of ids) plus aggregate deltas. */
export function compareReports(baseline: EvalReport, current: EvalReport): EvalComparison {
  const baseById = new Map(baseline.results.map(r => [r.id, r]));
  const curById = new Map(current.results.map(r => [r.id, r]));
  const shared = [...curById.keys()].filter(id => baseById.has(id));
  const perCase: CaseDelta[] = shared.map(id => {
    const b = baseById.get(id)!.metrics;
    const c = curById.get(id)!.metrics;
    const dNdcg = c.ndcg - b.ndcg;
    const dRr = c.reciprocalRank - b.reciprocalRank;
    const direction = Math.abs(dNdcg) > EPS ? (dNdcg > 0 ? "improved" : "regressed")
      : Math.abs(dRr) > EPS ? (dRr > 0 ? "improved" : "regressed")
      : "unchanged";
    return { id, recall: c.recall - b.recall, reciprocalRank: dRr, ndcg: dNdcg, direction };
  });
  // Aggregate deltas computed over the SHARED cases only, so adding new cases
  // to the eval set doesn't masquerade as a quality change.
  const aggOf = (rs: EvalCaseResult[]) => aggregate(rs.map(r => r.metrics));
  const baseShared = aggOf(shared.map(id => baseById.get(id)!));
  const curShared = aggOf(shared.map(id => curById.get(id)!));
  return {
    aggregate: {
      recallAtK: curShared.recallAtK - baseShared.recallAtK,
      mrr: curShared.mrr - baseShared.mrr,
      ndcgAtK: curShared.ndcgAtK - baseShared.ndcgAtK,
      hitRate: curShared.hitRate - baseShared.hitRate,
      ...(curShared.contextRecall !== undefined && baseShared.contextRecall !== undefined
        ? {
            contextRecall: curShared.contextRecall - baseShared.contextRecall,
            contextHitRate: (curShared.contextHitRate ?? 0) - (baseShared.contextHitRate ?? 0),
          }
        : {}),
    },
    perCase,
    improved: perCase.filter(d => d.direction === "improved").length,
    regressed: perCase.filter(d => d.direction === "regressed").length,
    unchanged: perCase.filter(d => d.direction === "unchanged").length,
    onlyInBaseline: [...baseById.keys()].filter(id => !curById.has(id)),
    onlyInCurrent: [...curById.keys()].filter(id => !baseById.has(id)),
  };
}
