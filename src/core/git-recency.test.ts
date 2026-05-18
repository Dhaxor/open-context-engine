import { describe, it, expect } from "vitest";
import { applyRecencyBoost, RecencyScores } from "./git-recency";

describe("applyRecencyBoost", () => {
  const makeResult = (path: string, score: number) => ({
    chunk: { id: path, path, startLine: 1, endLine: 10, contents: "test" },
    score,
  });

  it("boosts results from recently-modified files", () => {
    const results = [
      makeResult("old-file.ts", 1.0),
      makeResult("recent-file.ts", 0.9),
    ];
    const recency: RecencyScores = {
      scores: new Map([["recent-file.ts", 0.95], ["old-file.ts", 0.1]]),
      computedAt: Date.now(),
    };
    const boosted = applyRecencyBoost(results, recency, 0.5);
    expect(boosted[0].chunk.path).toBe("recent-file.ts");
  });

  it("returns original order when no recency data", () => {
    const results = [
      makeResult("a.ts", 1.0),
      makeResult("b.ts", 0.5),
    ];
    const recency: RecencyScores = { scores: new Map(), computedAt: Date.now() };
    const boosted = applyRecencyBoost(results, recency, 0.5);
    expect(boosted[0].chunk.path).toBe("a.ts");
  });

  it("respects weight parameter", () => {
    const results = [makeResult("file.ts", 1.0)];
    const recency: RecencyScores = {
      scores: new Map([["file.ts", 1.0]]),
      computedAt: Date.now(),
    };
    const boosted03 = applyRecencyBoost(results, recency, 0.3);
    const boosted09 = applyRecencyBoost(results, recency, 0.9);
    expect(boosted09[0].score).toBeGreaterThan(boosted03[0].score);
  });

  it("does not penalize files not in recency data", () => {
    const results = [makeResult("unknown.ts", 1.0)];
    const recency: RecencyScores = {
      scores: new Map([["other.ts", 1.0]]),
      computedAt: Date.now(),
    };
    const boosted = applyRecencyBoost(results, recency, 0.5);
    expect(boosted[0].score).toBe(1.0);
  });
});
