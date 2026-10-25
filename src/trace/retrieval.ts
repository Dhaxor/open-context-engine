/**
 * Adapter: RetrievalDebugReport → RetrievalTrace.
 *
 * The retriever already computes everything the evidence rail needs — per-stage
 * candidate lists, vector/BM25/rerank scores, expansion reasons, packing
 * decisions (core/retriever.ts). It was only ever consumed by `oce search
 * --debug`. This turns that report into the wire shape the harness renders, and
 * derives the two things the report leaves implicit: WHY each chunk is present
 * (`via`) and which graph edge pulled it in (`edges`).
 */

import { RetrievalDebugItem, RetrievalDebugReport } from "../core/retriever";
import { estimateTokens } from "../agent/utils";
import { GraphEdgeRef, RetrievalStage, RetrievalTrace, RetrievalVia, RetrievedChunk } from "./protocol";

/** Collects `onStage` callbacks into timings, so the UI can show the pipeline
 *  landing stage by stage instead of one opaque wait. */
export class StageTimer {
  private started = Date.now();
  private stages: RetrievalStage[] = [];

  /** Pass as `onStage` to RetrieveOptions. */
  readonly onStage = (stage: RetrievalStage["stage"], results: { length: number }): void => {
    this.stages.push({ stage, ms: Date.now() - this.started, count: results.length });
  };

  get elapsedMs(): number { return Date.now() - this.started; }
  snapshot(): RetrievalStage[] { return this.stages.map(s => ({ ...s })); }
  reset(): void { this.started = Date.now(); this.stages = []; }
}

export interface ToRetrievalTraceOptions {
  id: string;
  report: RetrievalDebugReport;
  durationMs: number;
  searchMode: "hybrid" | "keyword-only";
  toolCallId?: string;
  stages?: RetrievalStage[];
  /** Cap the rows sent to the UI. The rail shows the ranking, not the corpus. */
  maxChunks?: number;
}

const DEFAULT_MAX_CHUNKS = 24;

export function toRetrievalTrace(opts: ToRetrievalTraceOptions): RetrievalTrace {
  const { report } = opts;
  const inVector = keySet(report.vectorHits);
  const inBm25 = keySet(report.bm25Hits);
  const limit = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;

  // `final` and `finalResults` are index-aligned (both derive from
  // expanded.results), so the debug item supplies `reason` while the raw
  // SearchResult supplies chunk id, language, and contents for the token count.
  const chunks: RetrievedChunk[] = report.final.slice(0, limit).map((item, i) => {
    const raw = report.finalResults[i];
    const { via, edges } = classify(item, inVector, inBm25);
    return {
      rank: item.rank,
      chunkId: raw?.chunk.id,
      path: item.path,
      startLine: raw?.chunk.startLine ?? parseLines(item.lines)[0],
      endLine: raw?.chunk.endLine ?? parseLines(item.lines)[1],
      symbolName: item.symbolName,
      parentSymbol: item.parentSymbol,
      language: raw?.chunk.language,
      score: item.score,
      vectorScore: item.vectorScore,
      bm25Score: item.bm25Score,
      rerankScore: item.rerankScore,
      via,
      ...(edges.length ? { edges } : {}),
      preview: item.preview,
      tokens: raw ? estimateTokens(raw.chunk.contents) : estimateTokens(item.preview),
    };
  });

  return {
    id: opts.id,
    query: report.query,
    ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    chunks,
    stages: opts.stages ?? [],
    durationMs: opts.durationMs,
    searchMode: opts.searchMode,
    signals: report.signals,
    graphAdded: report.expanded.length,
    droppedChunks: report.packing?.droppedChunks ?? 0,
    totalChars: report.packing?.totalChars ?? 0,
  };
}

/** Chunks are identified across stages by path + line range — the debug items
 *  do not carry chunk ids. */
function keySet(items: RetrievalDebugItem[]): Set<string> {
  return new Set(items.map(i => `${i.path}:${i.lines}`));
}

function parseLines(lines: string): [number, number] {
  const [a, b] = lines.split("-");
  return [Number(a) || 0, Number(b) || Number(a) || 0];
}

/**
 * Why is this chunk here? An expansion `reason` wins because it is the most
 * specific answer available; otherwise membership in the candidate lists tells
 * us whether both retrieval arms agreed (the strongest signal) or only one did.
 */
function classify(
  item: RetrievalDebugItem,
  inVector: Set<string>,
  inBm25: Set<string>,
): { via: RetrievalVia; edges: GraphEdgeRef[] } {
  if (item.reason) return parseReason(item.reason);
  const key = `${item.path}:${item.lines}`;
  const v = inVector.has(key);
  const b = inBm25.has(key);
  if (v && b) return { via: "hybrid", edges: [] };
  if (v) return { via: "vector", edges: [] };
  if (b) return { via: "bm25", edges: [] };
  // Present in neither candidate list means the reranker surfaced it.
  return { via: "rerank", edges: [] };
}

/** Outgoing graph edges, as GraphExpander phrases them: `<verb> <path>[:<symbol>]`. */
const OUTGOING: [prefix: string, kind: GraphEdgeRef["kind"]][] = [
  ["imports ", "imports"],
  ["calls ", "calls"],
  ["called by ", "called-by"],
  ["implements ", "implements"],
  ["extends ", "extends"],
  ["exports ", "exports"],
  ["type of ", "type-of"],
];

/** Incoming edges read `<source> <verb> this` — same verbs, reversed sense. */
const INCOMING: [verb: string, kind: GraphEdgeRef["kind"]][] = [
  ["imports", "imported-by"],
  ["calls", "called-by"],
  ["called by", "calls"],
  ["implements", "implements"],
  ["extends", "extends"],
  ["exports", "exports"],
  ["type of", "type-of"],
];

/** Symbol/proximity expansion reasons, used when no AST graph is available. */
const LABELLED: Record<string, { via: RetrievalVia; kind?: GraphEdgeRef["kind"] }> = {
  "local import": { via: "graph", kind: "imports" },
  "usage/caller": { via: "graph", kind: "called-by" },
  "definition": { via: "expansion", kind: "defines" },
  "same symbol": { via: "expansion", kind: "defines" },
  "same parent": { via: "expansion", kind: "defines" },
  "nearby chunk": { via: "expansion" },
};

/**
 * Two producers write `reason`, in two grammars: GraphExpander emits
 * `imports src/a.ts:Foo` / `src/a.ts:Foo calls this`, while the fallback
 * expander emits `label: value`. Both are parsed here so the rail can show a
 * real edge instead of an opaque string — and an unrecognised reason degrades
 * to a plain expansion rather than being dropped.
 */
function parseReason(reason: string): { via: RetrievalVia; edges: GraphEdgeRef[] } {
  const text = reason.trim();

  if (text.endsWith(" this")) {
    const head = text.slice(0, -" this".length);
    for (const [verb, kind] of INCOMING) {
      if (head.endsWith(` ${verb}`)) {
        return { via: "graph", edges: [{ kind, label: head.slice(0, -(verb.length + 1)).trim() }] };
      }
    }
    return { via: "graph", edges: [] };
  }

  for (const [prefix, kind] of OUTGOING) {
    if (text.startsWith(prefix)) {
      return { via: "graph", edges: [{ kind, label: text.slice(prefix.length).trim() }] };
    }
  }

  const idx = text.indexOf(":");
  const label = (idx === -1 ? text : text.slice(0, idx)).trim();
  const value = idx === -1 ? "" : text.slice(idx + 1).trim();
  const known = LABELLED[label];
  if (!known) return { via: "expansion", edges: [] };
  return {
    via: known.via,
    edges: known.kind && value ? [{ kind: known.kind, label: value }] : [],
  };
}
