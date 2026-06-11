import { describe, it, expect } from "vitest";
import { computeCaseMetrics, aggregate, dedupeRanked } from "./metrics";

describe("dedupeRanked", () => {
  it("keeps first occurrence order", () => {
    expect(dedupeRanked(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
  it("handles empty input", () => {
    expect(dedupeRanked([])).toEqual([]);
  });
});

describe("computeCaseMetrics", () => {
  it("perfect retrieval: gold at rank 1", () => {
    const m = computeCaseMetrics(["gold.ts", "x.ts"], ["gold.ts"], 10);
    expect(m.recall).toBe(1);
    expect(m.reciprocalRank).toBe(1);
    expect(m.ndcg).toBe(1);
    expect(m.hit).toBe(true);
    expect(m.firstHitRank).toBe(1);
  });

  it("gold at rank 3: RR = 1/3, nDCG = 1/log2(4)", () => {
    const m = computeCaseMetrics(["a.ts", "b.ts", "gold.ts"], ["gold.ts"], 10);
    expect(m.reciprocalRank).toBeCloseTo(1 / 3, 10);
    // DCG = 1/log2(3+1) = 0.5; IDCG = 1/log2(2) = 1 → nDCG = 0.5
    expect(m.ndcg).toBeCloseTo(0.5, 10);
    expect(m.firstHitRank).toBe(3);
  });

  it("two gold files, one found: recall 0.5", () => {
    const m = computeCaseMetrics(["g1.ts", "x.ts"], ["g1.ts", "g2.ts"], 10);
    expect(m.recall).toBe(0.5);
    expect(m.hit).toBe(true);
    // DCG = 1/log2(2) = 1; IDCG (2 gold) = 1/log2(2) + 1/log2(3) ≈ 1.6309
    expect(m.ndcg).toBeCloseTo(1 / (1 + 1 / Math.log2(3)), 10);
  });

  it("both gold found at ranks 1 and 2: nDCG = 1", () => {
    const m = computeCaseMetrics(["g1.ts", "g2.ts", "x.ts"], ["g1.ts", "g2.ts"], 10);
    expect(m.recall).toBe(1);
    expect(m.ndcg).toBeCloseTo(1, 10);
  });

  it("gold outside the k cutoff is a miss", () => {
    const m = computeCaseMetrics(["a", "b", "c", "gold"], ["gold"], 3);
    expect(m.hit).toBe(false);
    expect(m.recall).toBe(0);
    expect(m.reciprocalRank).toBe(0);
    expect(m.ndcg).toBe(0);
    expect(m.firstHitRank).toBeNull();
  });

  it("nothing retrieved", () => {
    const m = computeCaseMetrics([], ["gold"], 10);
    expect(m.hit).toBe(false);
    expect(m.recall).toBe(0);
  });

  it("IDCG caps at k when gold set is larger than k", () => {
    // 5 gold files, k=2 → ideal is only 2 hits; retrieving both at top = nDCG 1.
    const gold = ["g1", "g2", "g3", "g4", "g5"];
    const m = computeCaseMetrics(["g1", "g2"], gold, 2);
    expect(m.ndcg).toBeCloseTo(1, 10);
    expect(m.recall).toBeCloseTo(2 / 5, 10);
  });

  it("degenerate inputs produce zeros, not NaN", () => {
    const empty = computeCaseMetrics(["a"], [], 10);
    expect(empty).toEqual({ recall: 0, reciprocalRank: 0, ndcg: 0, hit: false, firstHitRank: null });
    const zeroK = computeCaseMetrics(["a"], ["a"], 0);
    expect(zeroK.hit).toBe(false);
    expect(Number.isNaN(zeroK.ndcg)).toBe(false);
  });
});

describe("aggregate", () => {
  it("averages across cases", () => {
    const a = computeCaseMetrics(["g"], ["g"], 10);          // perfect
    const b = computeCaseMetrics(["x", "y"], ["g"], 10);     // miss
    const agg = aggregate([a, b]);
    expect(agg.cases).toBe(2);
    expect(agg.recallAtK).toBeCloseTo(0.5, 10);
    expect(agg.mrr).toBeCloseTo(0.5, 10);
    expect(agg.hitRate).toBeCloseTo(0.5, 10);
  });
  it("empty input is all zeros", () => {
    expect(aggregate([])).toEqual({ cases: 0, recallAtK: 0, mrr: 0, ndcgAtK: 0, hitRate: 0 });
  });
});
