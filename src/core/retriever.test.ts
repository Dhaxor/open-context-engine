import { describe, it, expect } from "vitest";
import { applyEditorContextBoost, applySymbolAwareBoost, extractRelativeImportSpecifiers, reciprocalRankFusion, resolveRelativeImportPaths } from "./retriever";
import { Chunk, SearchResult } from "./types";

function chunk(id: string): Chunk {
  return { id, path: `src/${id}.ts`, startLine: 1, endLine: 10, contents: `// ${id}` };
}

function result(id: string, score = 0): SearchResult {
  return { chunk: chunk(id), score };
}

function symbolResult(id: string, symbolName?: string, path?: string, score = 1): SearchResult {
  return { chunk: { ...chunk(id), path: path ?? `src/${id}.ts`, symbolName }, score };
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

describe("applySymbolAwareBoost", () => {
  it("promotes exact symbol matches for identifier queries", () => {
    const boosted = applySymbolAwareBoost([
      symbolResult("generic", "UnrelatedHelper", "src/generic.ts", 1.1),
      symbolResult("target", "OpenContext", "src/core/context.ts", 1),
    ], "where is OpenContext created");

    expect(boosted[0].chunk.id).toBe("target");
    expect(boosted[0].score).toBeGreaterThan(boosted[1].score);
  });

  it("uses path matches as a weaker signal", () => {
    const boosted = applySymbolAwareBoost([
      symbolResult("a", "Thing", "src/agent/providers.ts", 1),
      symbolResult("b", "Thing", "src/core/context.ts", 1),
    ], "providers streaming");

    expect(boosted[0].chunk.id).toBe("a");
  });
});

describe("applyEditorContextBoost", () => {
  it("promotes results from the active editor path", () => {
    const boosted = applyEditorContextBoost([
      symbolResult("other", "Thing", "src/other.ts", 1.1),
      symbolResult("active", "Thing", "src/active.ts", 1),
    ], { activePath: "src/active.ts" });

    expect(boosted[0].chunk.id).toBe("active");
  });

  it("uses selected text identifiers as extra ranking context", () => {
    const boosted = applyEditorContextBoost([
      symbolResult("generic", "OtherThing", "src/other.ts", 1.05),
      symbolResult("selected", "SelectedSymbol", "src/selected.ts", 1),
    ], { contextText: "SelectedSymbol is highlighted in the editor" });

    expect(boosted[0].chunk.id).toBe("selected");
  });
});

describe("import-aware retrieval helpers", () => {
  it("extracts relative imports from common JS/TS forms", () => {
    const specs = extractRelativeImportSpecifiers(`
      import { A } from "./a";
      export { B } from '../b';
      const c = require("./c/index");
      import z from "react";
    `);

    expect(specs).toEqual(["./a", "../b", "./c/index"]);
  });

  it("resolves relative imports to indexed files", () => {
    const resolved = resolveRelativeImportPaths("src/core/retriever.ts", ["./sqlite-store", "../agent/types"], [
      "src/core/sqlite-store.ts",
      "src/agent/types.ts",
    ]);

    expect(resolved).toEqual(["src/core/sqlite-store.ts", "src/agent/types.ts"]);
  });
});
