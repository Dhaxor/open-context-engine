import { describe, expect, it } from "vitest";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { SqliteStore } from "./sqlite-store";
import { buildRepoMap } from "./repo-map";
import { Chunk } from "./types";

function makeStore(files: Record<string, { symbolName: string; symbolKind: string; startLine: number; endLine: number }[]>): SqliteStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-repomap-"));
  const store = new SqliteStore(dir, 4);
  return store.initialize().then(() => store) as any;
}

async function withStore(files: Record<string, Chunk[]>, fn: (store: SqliteStore) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-repomap-"));
  const store = new SqliteStore(dir, 4);
  await store.initialize();
  const all: Chunk[] = [];
  for (const [p, chunks] of Object.entries(files)) {
    for (const c of chunks) {
      all.push({ ...c, path: p, vector: [0.1, 0.2, 0.3, 0.4] });
    }
  }
  store.addBatch(all as any);
  fn(store);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function chunk(id: string, symbolName: string, symbolKind: string, startLine: number, endLine: number): Chunk {
  return { id, path: "", startLine, endLine, contents: "// " + id, symbolName, symbolKind } as Chunk;
}

describe("buildRepoMap", () => {
  it("renders files with their declared symbols and line ranges", async () => {
    await withStore({
      "src/retriever.ts": [
        chunk("a1", "HybridRetriever", "class", 105, 276),
        chunk("a2", "reciprocalRankFusion", "function", 280, 299),
      ],
      "src/store.ts": [
        chunk("b1", "SqliteStore", "class", 170, 600),
      ],
    }, store => {
      const map = buildRepoMap(store);
      expect(map).toContain("src/retriever.ts");
      expect(map).toContain("class HybridRetriever (105-276)");
      expect(map).toContain("fn reciprocalRankFusion (280-299)");
      expect(map).toContain("src/store.ts");
      expect(map).toContain("class SqliteStore (170-600)");
    });
  });

  it("ranks structure-dense files first", async () => {
    await withStore({
      "src/many.ts": [
        chunk("m1", "A", "class", 1, 2),
        chunk("m2", "B", "class", 3, 4),
        chunk("m3", "C", "function", 5, 6),
      ],
      "src/few.ts": [
        chunk("f1", "D", "class", 1, 2),
      ],
    }, store => {
      const map = buildRepoMap(store);
      expect(map.indexOf("src/many.ts")).toBeLessThan(map.indexOf("src/few.ts"));
    });
  });

  it("respects the char budget", async () => {
    await withStore({
      "src/big1.ts": [
        chunk("x1", "VeryLongSymbolNameOne", "class", 1, 2),
        chunk("x2", "VeryLongSymbolNameTwo", "class", 3, 4),
        chunk("x3", "VeryLongSymbolNameThree", "class", 5, 6),
      ],
      "src/big2.ts": [
        chunk("y1", "AnotherLongSymbolNameHere", "class", 1, 2),
      ],
    }, store => {
      const map = buildRepoMap(store, { maxChars: 200 });
      expect(map.length).toBeLessThanOrEqual(250);
    });
  });

  it("deduplicates repeated symbol names within a file", async () => {
    await withStore({
      "src/one.ts": [
        chunk("d1", "helper", "method", 1, 2),
        chunk("d2", "helper", "method", 3, 4),
        chunk("d3", "helper", "method", 5, 6),
      ],
    }, store => {
      const map = buildRepoMap(store);
      expect(map.match(/helper/g)?.length).toBe(1);
    });
  });

  it("honors the path prefix and returns empty for a bare store", async () => {
    await withStore({
      "src/a.ts": [chunk("p1", "A", "class", 1, 2)],
      "lib/b.ts": [chunk("p2", "B", "class", 1, 2)],
    }, store => {
      const scoped = buildRepoMap(store, { pathPrefix: "lib/" });
      expect(scoped).toContain("lib/b.ts");
      expect(scoped).not.toContain("src/a.ts");
    });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oce-empty-"));
    const store = new SqliteStore(empty, 4);
    await store.initialize();
    expect(buildRepoMap(store)).toBe("");
    store.close();
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
