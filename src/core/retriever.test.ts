import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "./retriever";
import { Chunk, SearchResult } from "./types";

function chunk(id: string): Chunk {
  return { id, path: `src/${id}.ts`, startLine: 1, endLine: 10, contents: `// ${id}` };
}

function result(id: string, score = 0): SearchResult {
  return { chunk: chunk(id), score };
}

describe("reciprocalRankFusion", () => {
  it("returns an empty array when all lists are empty", () => {
    expect(reciprocalRankFusion([{ results: [], weight: 1 }], 10)).toEqual([]);
  });

  it("preserves a single list in rank order (best first)", () => {
    const list = [result("a"), result("b"), result("c")];
    const fused = reciprocalRankFusion([{ results: list, weight: 1 }], 10);
    expect(fused.map(r => r.chunk.id)).toEqual(["a", "b", "c"]);
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
    expect(fused[1].score).toBeGreaterThan(fused[2].score);
  });

  it("boosts chunks that appear in multiple lists", () => {
    const vec = [result("a"), result("b"), result("c")];
    const bm25 = [result("c"), result("a"), result("d")];
    const fused = reciprocalRankFusion([
      { results: vec, weight: 1 },
      { results: bm25, weight: 1 },
    ], 10);
    const topTwo = fused.slice(0, 2).map(r => r.chunk.id).sort();
    expect(topTwo).toEqual(["a", "c"]);
  });

  it("respects per-list weights", () => {
    const vec = [result("a"), result("b")];
    const bm25 = [result("b"), result("a")];
    const vectorDominated = reciprocalRankFusion([
      { results: vec, weight: 10 },
      { results: bm25, weight: 1 },
    ], 10);
    expect(vectorDominated[0].chunk.id).toBe("a");

    const bm25Dominated = reciprocalRankFusion([
      { results: vec, weight: 1 },
      { results: bm25, weight: 10 },
    ], 10);
    expect(bm25Dominated[0].chunk.id).toBe("b");
  });

  it("honours topK truncation", () => {
    const lots = Array.from({ length: 20 }, (_, i) => result(`x${i}`));
    const fused = reciprocalRankFusion([{ results: lots, weight: 1 }], 5);
    expect(fused).toHaveLength(5);
  });

  it("merges score-side metadata when fusing duplicates", () => {
    const vec: SearchResult = { chunk: chunk("a"), score: 0, vectorScore: 0.9 };
    const bm25: SearchResult = { chunk: chunk("a"), score: 0, bm25Score: -2.5 };
    const fused = reciprocalRankFusion([
      { results: [vec], weight: 1 },
      { results: [bm25], weight: 1 },
    ], 10);
    expect(fused[0].vectorScore).toBe(0.9);
    expect(fused[0].bm25Score).toBe(-2.5);
  });
});
