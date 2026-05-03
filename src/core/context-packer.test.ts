import { describe, expect, it } from "vitest";
import { packSearchResults } from "./context-packer";
import { SearchResult } from "./types";

function result(path: string, startLine: number, contents: string, score = 1): SearchResult {
  const lines = contents.split("\n").length;
  return {
    chunk: { id: `${path}:${startLine}`, path, startLine, endLine: startLine + lines - 1, contents, symbolName: "Thing" },
    score,
  };
}

describe("packSearchResults", () => {
  it("groups chunks by file and emits numbered context", () => {
    const packed = packSearchResults([
      result("src/a.ts", 10, "const a = 1;", 1),
      result("src/b.ts", 1, "const b = 2;", 0.9),
    ], { maxTotalChars: 4000 });

    expect(packed.output).toContain("Relevant context (packed)");
    expect(packed.output).toContain("## src/a.ts");
    expect(packed.output).toContain("   10 │ const a = 1;");
    expect(packed.includedFiles).toBe(2);
  });

  it("merges nearby ranges from the same file", () => {
    const packed = packSearchResults([
      result("src/a.ts", 1, "one", 1),
      result("src/a.ts", 3, "three", 0.9),
    ], { mergeLineGap: 3 });

    expect(packed.includedChunks).toBe(2);
    expect(packed.decisions.some(d => d.action === "merged")).toBe(true);
    expect(packed.output).toContain("Lines 1-3");
  });

  it("drops low-ranked chunks when per-file budget is exceeded", () => {
    const packed = packSearchResults([
      result("src/a.ts", 1, "one", 3),
      result("src/a.ts", 20, "two", 2),
      result("src/a.ts", 40, "three", 1),
    ], { maxChunksPerFile: 2 });

    expect(packed.decisions).toContainEqual(expect.objectContaining({ action: "dropped", reason: "per-file chunk budget" }));
  });
});
