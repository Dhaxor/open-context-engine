import { describe, it, expect } from "vitest";
import { RetrievalDebugItem, RetrievalDebugReport } from "../core/retriever";
import { SearchResult } from "../core/types";
import { StageTimer, toRetrievalTrace } from "./retrieval";

function item(over: Partial<RetrievalDebugItem> & { path: string; lines: string }): RetrievalDebugItem {
  return { rank: 1, score: 0.5, preview: "code…", ...over };
}

function result(path: string, startLine: number, endLine: number, contents = "x".repeat(400)): SearchResult {
  return {
    chunk: { id: `${path}:${startLine}`, path, startLine, endLine, contents, language: "ts" },
    score: 0.5,
  };
}

function report(over: Partial<RetrievalDebugReport> = {}): RetrievalDebugReport {
  const base: RetrievalDebugReport = {
    query: "why does search degrade",
    signals: ["search", "degrade"],
    vectorHits: [],
    bm25Hits: [],
    fused: [],
    ranked: [],
    expanded: [],
    final: [],
    finalResults: [],
  };
  return { ...base, ...over };
}

describe("toRetrievalTrace", () => {
  it("marks a chunk found by both arms as hybrid", () => {
    const hit = item({ path: "src/a.ts", lines: "1-10", vectorScore: 0.2, bm25Score: 4.1 });
    const trace = toRetrievalTrace({
      id: "r1",
      durationMs: 251,
      searchMode: "hybrid",
      report: report({
        vectorHits: [hit],
        bm25Hits: [hit],
        final: [hit],
        finalResults: [result("src/a.ts", 1, 10)],
      }),
    });
    expect(trace.chunks).toHaveLength(1);
    expect(trace.chunks[0].via).toBe("hybrid");
    expect(trace.chunks[0].score).toBe(0.5);
    expect(trace.durationMs).toBe(251);
  });

  it("distinguishes vector-only, bm25-only, and reranked chunks", () => {
    const v = item({ path: "src/v.ts", lines: "1-5" });
    const b = item({ path: "src/b.ts", lines: "1-5" });
    const r = item({ path: "src/r.ts", lines: "1-5", rerankScore: 0.9 });
    const trace = toRetrievalTrace({
      id: "r2",
      durationMs: 10,
      searchMode: "hybrid",
      report: report({
        vectorHits: [v],
        bm25Hits: [b],
        final: [v, b, r],
        finalResults: [result("src/v.ts", 1, 5), result("src/b.ts", 1, 5), result("src/r.ts", 1, 5)],
      }),
    });
    expect(trace.chunks.map(c => c.via)).toEqual(["vector", "bm25", "rerank"]);
  });

  it("reads outgoing graph-expander reasons into edges", () => {
    const trace = toRetrievalTrace({
      id: "r3",
      durationMs: 5,
      searchMode: "hybrid",
      report: report({
        final: [item({ path: "src/store.ts", lines: "1-9", reason: "imports src/sqlite-store.ts:SqliteStore" })],
        finalResults: [result("src/store.ts", 1, 9)],
      }),
    });
    expect(trace.chunks[0].via).toBe("graph");
    expect(trace.chunks[0].edges).toEqual([{ kind: "imports", label: "src/sqlite-store.ts:SqliteStore" }]);
  });

  it("reverses the sense of incoming graph edges", () => {
    const trace = toRetrievalTrace({
      id: "r4",
      durationMs: 5,
      searchMode: "hybrid",
      report: report({
        final: [item({ path: "src/search.ts", lines: "1-9", reason: "src/search.ts:hybridSearch calls this" })],
        finalResults: [result("src/search.ts", 1, 9)],
      }),
    });
    // The retrieved chunk is what search.ts calls, so from the chunk's side the
    // edge is "called-by" — collapsing this to "calls" would invert the meaning.
    expect(trace.chunks[0].edges).toEqual([{ kind: "called-by", label: "src/search.ts:hybridSearch" }]);
  });

  it("parses the fallback expander's labelled reasons", () => {
    const cases: [string, string, string][] = [
      ["local import: src/x.ts", "graph", "imports"],
      ["usage/caller: renderChart", "graph", "called-by"],
      ["definition: SqliteStore", "expansion", "defines"],
      ["same symbol: retrieve", "expansion", "defines"],
    ];
    for (const [reason, via, kind] of cases) {
      const trace = toRetrievalTrace({
        id: "r5",
        durationMs: 1,
        searchMode: "hybrid",
        report: report({
          final: [item({ path: "src/z.ts", lines: "1-2", reason })],
          finalResults: [result("src/z.ts", 1, 2)],
        }),
      });
      expect(trace.chunks[0].via, reason).toBe(via);
      expect(trace.chunks[0].edges?.[0].kind, reason).toBe(kind);
    }
  });

  it("degrades an unrecognised reason to expansion instead of dropping the chunk", () => {
    const trace = toRetrievalTrace({
      id: "r6",
      durationMs: 1,
      searchMode: "hybrid",
      report: report({
        final: [item({ path: "src/q.ts", lines: "1-2", reason: "some future heuristic" })],
        finalResults: [result("src/q.ts", 1, 2)],
      }),
    });
    expect(trace.chunks).toHaveLength(1);
    expect(trace.chunks[0].via).toBe("expansion");
    expect(trace.chunks[0].edges).toBeUndefined();
  });

  it("carries keyword-only mode through so the UI can say ranking is degraded", () => {
    const trace = toRetrievalTrace({
      id: "r7", durationMs: 3, searchMode: "keyword-only", report: report(),
    });
    expect(trace.searchMode).toBe("keyword-only");
    expect(trace.chunks).toEqual([]);
  });

  it("reports packing losses so 'why isn't X here' is answerable", () => {
    const trace = toRetrievalTrace({
      id: "r8",
      durationMs: 3,
      searchMode: "hybrid",
      report: report({
        expanded: [item({ path: "src/e.ts", lines: "1-2" })],
        packing: { includedFiles: 2, includedChunks: 4, droppedChunks: 7, totalChars: 18_400, decisions: [], preview: "" },
      }),
    });
    expect(trace.droppedChunks).toBe(7);
    expect(trace.totalChars).toBe(18_400);
    expect(trace.graphAdded).toBe(1);
  });

  it("estimates per-chunk token cost from the real contents", () => {
    const trace = toRetrievalTrace({
      id: "r9",
      durationMs: 1,
      searchMode: "hybrid",
      report: report({
        final: [item({ path: "src/a.ts", lines: "1-10" })],
        finalResults: [result("src/a.ts", 1, 10, "y".repeat(1000))],
      }),
    });
    expect(trace.chunks[0].tokens).toBe(250);
  });

  it("caps the rows sent to the UI", () => {
    const many = Array.from({ length: 30 }, (_, i) => item({ path: `src/${i}.ts`, lines: "1-2", rank: i + 1 }));
    const trace = toRetrievalTrace({
      id: "r10",
      durationMs: 1,
      searchMode: "hybrid",
      maxChunks: 5,
      report: report({ final: many, finalResults: many.map((_, i) => result(`src/${i}.ts`, 1, 2)) }),
    });
    expect(trace.chunks).toHaveLength(5);
    expect(trace.chunks[4].rank).toBe(5);
  });
});

describe("StageTimer", () => {
  it("records each stage with a count", () => {
    const timer = new StageTimer();
    timer.onStage("bm25", { length: 40 });
    timer.onStage("vector", { length: 40 });
    timer.onStage("fused", { length: 60 });
    const stages = timer.snapshot();
    expect(stages.map(s => s.stage)).toEqual(["bm25", "vector", "fused"]);
    expect(stages.map(s => s.count)).toEqual([40, 40, 60]);
    expect(stages.every(s => s.ms >= 0)).toBe(true);
  });

  it("snapshots are copies, so later stages do not mutate an emitted trace", () => {
    const timer = new StageTimer();
    timer.onStage("bm25", { length: 1 });
    const first = timer.snapshot();
    timer.onStage("vector", { length: 2 });
    expect(first).toHaveLength(1);
  });
});
