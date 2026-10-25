import { describe, it, expect } from "vitest";
import type { ContextSnapshot } from "./protocol";
import {
  basename, budgetSegments, diffLineKind, diffStat, duration, edgeLabel,
  parseDiff, retrievalSummary, riskColor, score, scoreColor, stageBars, tokens,
} from "./format";
import { SCORE_RAMP } from "./tokens";

describe("tokens()", () => {
  it("abbreviates consistently so columns line up", () => {
    expect(tokens(0)).toBe("0");
    expect(tokens(999)).toBe("999");
    expect(tokens(1200)).toBe("1.2k");
    expect(tokens(9940)).toBe("9.9k");
    expect(tokens(12_000)).toBe("12k");
    expect(tokens(200_000)).toBe("200k");
    expect(tokens(1_500_000)).toBe("1.5m");
  });

  it("never straddles a boundary in two formats", () => {
    // 9,950 must not read "10.0k" while 10,000 reads "10k" — same magnitude,
    // two widths, in a column that is meant to be scannable.
    expect(tokens(9950)).toBe("10k");
    expect(tokens(10_000)).toBe("10k");
    expect(tokens(999_990)).toBe("1.0m");
  });

  it("never renders a float artifact", () => {
    expect(tokens(0.1 + 0.2)).toBe("0");
    expect(tokens(7 * 1.1)).toBe("8");
  });

  it("handles nonsense without rendering NaN", () => {
    expect(tokens(NaN)).toBe("0");
    expect(tokens(-5)).toBe("0");
  });
});

describe("score()", () => {
  it("always shows two decimals so the column never reflows", () => {
    expect(score(0.9)).toBe("0.90");
    expect(score(1)).toBe("1.00");
    expect(score(0.12345)).toBe("0.12");
  });

  it("degrades to a dash rather than NaN", () => {
    expect(score(NaN)).toBe("—");
  });
});

describe("duration()", () => {
  it("switches units at a second", () => {
    expect(duration(251)).toBe("251ms");
    expect(duration(1500)).toBe("1.5s");
    expect(duration(undefined)).toBe("");
  });
});

describe("scoreColor()", () => {
  it("maps the strongest score to the brightest step", () => {
    expect(scoreColor(1)).toBe(SCORE_RAMP[0]);
    expect(scoreColor(0.95)).toBe(SCORE_RAMP[0]);
  });

  it("maps the weakest to the dimmest", () => {
    expect(scoreColor(0)).toBe(SCORE_RAMP[SCORE_RAMP.length - 1]);
  });

  it("stays on the ramp for out-of-range and broken input", () => {
    expect(SCORE_RAMP).toContain(scoreColor(1.5));
    expect(SCORE_RAMP).toContain(scoreColor(-1));
    expect(SCORE_RAMP).toContain(scoreColor(NaN));
  });

  it("is monotonic — a lower score is never brighter", () => {
    const indexes = [1, 0.8, 0.6, 0.4, 0.2, 0].map(s => SCORE_RAMP.indexOf(scoreColor(s) as any));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});

describe("diff rendering", () => {
  it("treats +++ and --- as headers, not as content", () => {
    // Colouring these green and red is the classic tell of a hand-rolled view.
    expect(diffLineKind("+++ b/src/a.ts")).toBe("meta");
    expect(diffLineKind("--- a/src/a.ts")).toBe("meta");
    expect(diffLineKind("@@ -1,3 +1,4 @@")).toBe("hunk");
    expect(diffLineKind("+added")).toBe("add");
    expect(diffLineKind("-removed")).toBe("rem");
    expect(diffLineKind(" context")).toBe("ctx");
  });

  it("counts only real additions and removals", () => {
    const diff = ["--- a/x", "+++ b/x", "@@ -1 +1,2 @@", " ctx", "-old", "+new", "+extra"].join("\n");
    expect(diffStat(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("truncates a huge diff with a visible marker", () => {
    const lines = parseDiff(Array.from({ length: 500 }, (_, i) => `+line ${i}`).join("\n"), 10);
    expect(lines).toHaveLength(11);
    expect(lines[10].text).toContain("490 more lines");
  });
});

describe("retrieval summary", () => {
  it("reads as evidence, not as a spinner", () => {
    const chunks = [
      { rank: 1, path: "a.ts", startLine: 1, endLine: 2, score: 0.94, via: "hybrid" as const, preview: "", tokens: 10 },
      { rank: 2, path: "b.ts", startLine: 1, endLine: 2, score: 0.71, via: "vector" as const, preview: "", tokens: 10 },
    ];
    expect(retrievalSummary(chunks, 2, 251)).toBe("retrieved 2 · top 0.94 · graph +2 · 251ms");
  });

  it("omits the graph clause when nothing was expanded", () => {
    expect(retrievalSummary([], 0, 12)).toBe("retrieved 0 · 12ms");
  });

  it("scales sparkline bars to the busiest stage", () => {
    const bars = stageBars([
      { stage: "bm25", ms: 3, count: 40 },
      { stage: "vector", ms: 40, count: 20 },
      { stage: "fused", ms: 45, count: 60 },
    ]);
    expect(bars).toHaveLength(3);
    expect(Math.max(...bars)).toBe(11);
    expect(bars.every(b => b >= 2)).toBe(true);
  });

  it("returns nothing for no stages", () => {
    expect(stageBars([])).toEqual([]);
  });
});

describe("edgeLabel()", () => {
  it("keeps direction, because it changes the meaning", () => {
    expect(edgeLabel({ kind: "called-by", label: "src/core/search.ts" })).toBe("← called by search.ts");
    expect(edgeLabel({ kind: "calls", label: "src/core/search.ts" })).toBe("← calls search.ts");
  });

  it("collapses a count", () => {
    expect(edgeLabel({ kind: "imports", label: "a.ts", count: 3 })).toBe("← imports a.ts +2");
  });
});

describe("budgetSegments()", () => {
  const snapshot: ContextSnapshot = {
    windowTokens: 200_000,
    usedTokens: 100,
    buckets: { retrieval: 50, files: 30, history: 20, system: 0, tools: 0 },
    entries: [],
  };

  it("orders by size and drops empty buckets", () => {
    const segments = budgetSegments(snapshot);
    expect(segments.map(s => s.bucket)).toEqual(["retrieval", "files", "history"]);
    expect(segments[0].percent).toBe(50);
  });

  it("percentages describe the composition and sum to 100", () => {
    const total = budgetSegments(snapshot).reduce((sum, s) => sum + s.percent, 0);
    expect(Math.round(total)).toBe(100);
  });

  it("returns nothing for an empty or missing window", () => {
    expect(budgetSegments(null)).toEqual([]);
    expect(budgetSegments({ ...snapshot, usedTokens: 0 })).toEqual([]);
  });
});

describe("riskColor()", () => {
  it("uses three meanings, not a gradient", () => {
    expect(riskColor(0.1)).toBe("var(--ok)");
    expect(riskColor(0.4)).toBe("var(--warn)");
    expect(riskColor(0.8)).toBe("var(--del)");
  });
});

describe("basename()", () => {
  it("shortens a path for tight columns", () => {
    expect(basename("src/core/retriever.ts")).toBe("retriever.ts");
    expect(basename("retriever.ts")).toBe("retriever.ts");
  });
});
