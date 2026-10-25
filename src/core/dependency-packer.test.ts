import { describe, it, expect } from "vitest";
import { packWithDependencies } from "./dependency-packer";
import { SearchResult, Chunk } from "./types";
import { CodeGraph } from "./code-graph";
import { SqliteStore } from "./sqlite-store";

/**
 * packWithDependencies is exported on the public API but had no callers and
 * no tests. These pin the contract: imported files ride along under a carved
 * budget, already-included paths are not duplicated, the cap holds, and a
 * graph with no imports degrades to plain packing.
 */

function chunk(path: string, contents: string, id = `${path}:1`): Chunk {
  return { id, path, startLine: 1, endLine: contents.split("\n").length, contents };
}

function result(path: string, contents: string, score = 1): SearchResult {
  return { chunk: chunk(path, contents), score };
}

/** Just the surface packWithDependencies touches. */
function fakeGraph(imports: Record<string, string[]>): CodeGraph {
  return { getImportsOf: (p: string) => imports[p] ?? [] } as unknown as CodeGraph;
}

function fakeStore(chunksByPath: Record<string, Chunk[]>): SqliteStore {
  return {
    getChunksByPath: (p: string, limit: number) => (chunksByPath[p] ?? []).slice(0, limit),
  } as unknown as SqliteStore;
}

describe("packWithDependencies", () => {
  const primary = [result("src/app.ts", "import { helper } from './util';\nexport function app() { return helper(); }")];
  const utilChunk = chunk("src/util.ts", "export function helper() { return 42; }");
  const store = fakeStore({
    "src/util.ts": [utilChunk],
    "src/deep.ts": [chunk("src/deep.ts", "export function deep() {}")],
  });

  it("appends imported files under a Dependencies heading", () => {
    const graph = fakeGraph({ "src/app.ts": ["src/util.ts"] });
    const packed = packWithDependencies(primary, graph, store, { maxTotalChars: 4000 });
    expect(packed.output).toContain("Dependencies (imported by above):");
    expect(packed.output).toContain("helper");
    expect(packed.includedFiles).toBe(2);
  });

  it("does not duplicate a file already present in the primary results", () => {
    const both = [result("src/app.ts", "app body"), result("src/util.ts", utilChunk.contents)];
    const graph = fakeGraph({ "src/app.ts": ["src/util.ts"] });
    const packed = packWithDependencies(both, graph, store, { maxTotalChars: 4000 });
    expect(packed.output).not.toContain("Dependencies (imported by above):");
    expect(packed.includedFiles).toBe(2);
  });

  it("respects maxDependencyResults", () => {
    const graph = fakeGraph({
      "src/app.ts": ["src/util.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts"],
    });
    const wide = fakeStore({
      ...Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h"].map(l => [`src/${l}.ts`, [chunk(`src/${l}.ts`, `export const ${l} = 1;`)]])),
      "src/util.ts": [utilChunk],
    });
    const packed = packWithDependencies(primary, graph, wide, { maxTotalChars: 100_000, maxDependencyResults: 3 });
    // 2 primary decisions at most + capped dependencies; the file count is
    // primary(1) + capped deps(3).
    expect(packed.includedFiles).toBe(4);
  });

  it("follows a second hop of imports when depth allows", () => {
    const graph = fakeGraph({
      "src/app.ts": ["src/mid.ts"],
      "src/mid.ts": ["src/deep.ts"],
    });
    const deepStore = fakeStore({
      "src/mid.ts": [chunk("src/mid.ts", "export function mid() {}")],
      "src/deep.ts": [chunk("src/deep.ts", "export function deep() {}")],
    });
    const packed = packWithDependencies(primary, graph, deepStore, { maxTotalChars: 4000 });
    expect(packed.output).toContain("mid()");
    expect(packed.output).toContain("deep()");
  });

  it("carves the budget: dependencies may not consume the primary share", () => {
    const graph = fakeGraph({ "src/app.ts": ["src/util.ts"] });
    const big = [result("src/app.ts", "x".repeat(300))];
    const bigUtil = fakeStore({ "src/util.ts": [chunk("src/util.ts", "y".repeat(5000))] });
    // Total budget 1000 → primary 700, deps 300: the 5000-char dependency
    // chunk cannot fit whole, but the primary must still be there.
    const packed = packWithDependencies(big, graph, bigUtil, { maxTotalChars: 1000 });
    expect(packed.totalChars).toBeLessThanOrEqual(1000 + 200 /* heading slack */);
    expect(packed.output).toContain("x".repeat(100));
  });

  it("degrades to plain packing when the graph has no imports", () => {
    const packed = packWithDependencies(primary, fakeGraph({}), store, { maxTotalChars: 4000 });
    expect(packed.output).not.toContain("Dependencies");
    expect(packed.includedFiles).toBe(1);
  });
});
