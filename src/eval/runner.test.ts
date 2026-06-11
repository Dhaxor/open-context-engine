import { describe, it, expect } from "vitest";
import { runEval, parseEvalCases, compareReports, EvalCase, EvalReport } from "./runner";
import { SearchResult } from "../core/types";

function result(path: string, score = 1): SearchResult {
  return { chunk: { id: path + ":1", path, startLine: 1, endLine: 5, contents: "x" }, score };
}

const CASES: EvalCase[] = [
  { id: "one", query: "first query", expectedPaths: ["src/a.ts"] },
  { id: "two", query: "second query", expectedPaths: ["src/b.ts"] },
];

describe("runEval", () => {
  it("scores hits and misses with per-case latency and streaming callback", async () => {
    const search = async (query: string) =>
      query === "first query"
        ? [result("src/a.ts"), result("src/x.ts")]
        : [result("src/y.ts")];
    const seen: string[] = [];
    const report = await runEval(search, CASES, { k: 5, onCase: (r) => seen.push(r.id) });
    expect(seen).toEqual(["one", "two"]);
    expect(report.caseCount).toBe(2);
    expect(report.results[0].metrics.hit).toBe(true);
    expect(report.results[1].metrics.hit).toBe(false);
    expect(report.aggregate.hitRate).toBeCloseTo(0.5, 10);
    expect(report.results.every(r => r.elapsedMs >= 0)).toBe(true);
  });

  it("dedupes chunk paths before ranking files", async () => {
    // 3 chunks of the same file ahead of the gold file: gold must rank 2nd, not 4th.
    const search = async () => [result("src/big.ts"), result("src/big.ts"), result("src/big.ts"), result("src/a.ts")];
    const report = await runEval(search, [CASES[0]], { k: 2 });
    expect(report.results[0].metrics.hit).toBe(true);
    expect(report.results[0].metrics.firstHitRank).toBe(2);
  });

  it("scores packed-context recall when packedSearch is provided", async () => {
    const search = async () => [result("src/x.ts")]; // rank miss
    // ...but the packed pipeline (with expansion) pulls the gold file in.
    const packedSearch = async () => "summary\n## src/a.ts\nLines 1-3 (score 0.4):\n    1 │ x";
    const report = await runEval(search, [CASES[0]], { k: 5, packedSearch });
    expect(report.results[0].metrics.hit).toBe(false);
    expect(report.results[0].metrics.contextRecall).toBe(1);
    expect(report.aggregate.contextRecall).toBe(1);
    expect(report.aggregate.contextHitRate).toBe(1);
  });

  it("captures search errors per-case without aborting the run", async () => {
    const search = async (query: string) => {
      if (query === "first query") throw new Error("provider down");
      return [result("src/b.ts")];
    };
    const report = await runEval(search, CASES, { k: 5 });
    expect(report.results[0].error).toBe("provider down");
    expect(report.results[0].metrics.hit).toBe(false);
    expect(report.results[1].metrics.hit).toBe(true);
    // Mean latency excludes errored cases.
    expect(report.meanLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("parseEvalCases", () => {
  it("accepts a bare array and a { cases } wrapper", () => {
    const arr = [{ id: "a", query: "q", expectedPaths: ["p.ts"] }];
    expect(parseEvalCases(arr)).toHaveLength(1);
    expect(parseEvalCases({ cases: arr })).toHaveLength(1);
  });
  it("normalises backslashes in expected paths", () => {
    const [c] = parseEvalCases([{ id: "a", query: "q", expectedPaths: ["src\\win\\path.ts"] }]);
    expect(c.expectedPaths).toEqual(["src/win/path.ts"]);
  });
  it("accepts legacy 'expected' key", () => {
    const [c] = parseEvalCases([{ id: "a", query: "q", expected: ["p.ts"] }]);
    expect(c.expectedPaths).toEqual(["p.ts"]);
  });
  it("rejects duplicates, missing fields, and empty path arrays", () => {
    expect(() => parseEvalCases([{ id: "a", query: "q", expectedPaths: ["p"] }, { id: "a", query: "q2", expectedPaths: ["p"] }])).toThrow(/duplicate/);
    expect(() => parseEvalCases([{ query: "q", expectedPaths: ["p"] }])).toThrow(/id/);
    expect(() => parseEvalCases([{ id: "a", expectedPaths: ["p"] }])).toThrow(/query/);
    expect(() => parseEvalCases([{ id: "a", query: "q", expectedPaths: [] }])).toThrow(/expectedPaths/);
    expect(() => parseEvalCases({ nope: true })).toThrow(/array/);
  });
});

describe("compareReports", () => {
  async function reportFor(ranks: Record<string, string[]>): Promise<EvalReport> {
    const cases: EvalCase[] = Object.keys(ranks).map(id => ({ id, query: id, expectedPaths: ["gold.ts"] }));
    return runEval(async (q) => (ranks[q] ?? []).map(p => result(p)), cases, { k: 5 });
  }

  it("classifies improvements and regressions on nDCG", async () => {
    const baseline = await reportFor({ a: ["x.ts", "gold.ts"], b: ["gold.ts"] });   // a: rank2, b: rank1
    const current = await reportFor({ a: ["gold.ts"], b: ["x.ts", "gold.ts"] });    // a: rank1 (better), b: rank2 (worse)
    const cmp = compareReports(baseline, current);
    expect(cmp.improved).toBe(1);
    expect(cmp.regressed).toBe(1);
    expect(cmp.unchanged).toBe(0);
    expect(cmp.perCase.find(d => d.id === "a")!.direction).toBe("improved");
    expect(cmp.perCase.find(d => d.id === "b")!.direction).toBe("regressed");
    // Net aggregate delta is ~0 since the two cases swapped.
    expect(Math.abs(cmp.aggregate.ndcgAtK)).toBeLessThan(1e-9);
  });

  it("compares only the shared cases and reports the disjoint ids", async () => {
    const baseline = await reportFor({ a: ["gold.ts"], removed: ["gold.ts"] });
    const current = await reportFor({ a: ["gold.ts"], added: ["gold.ts"] });
    const cmp = compareReports(baseline, current);
    expect(cmp.perCase.map(d => d.id)).toEqual(["a"]);
    expect(cmp.onlyInBaseline).toEqual(["removed"]);
    expect(cmp.onlyInCurrent).toEqual(["added"]);
    expect(cmp.unchanged).toBe(1);
  });
});
