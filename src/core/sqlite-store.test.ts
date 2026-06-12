import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "./sqlite-store";
import { Chunk } from "./types";

const DIM = 4;

function makeVec(seed: number, dim = DIM): number[] {
  const v = new Array(dim).fill(0).map((_, i) => Math.sin(seed + i * 0.37));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function makeChunk(id: string, opts: Partial<Chunk> = {}): Chunk {
  return {
    id,
    path: opts.path ?? `src/${id}.ts`,
    startLine: opts.startLine ?? 1,
    endLine: opts.endLine ?? 10,
    contents: opts.contents ?? `function ${id}() { return ${id}; }`,
    vector: opts.vector ?? makeVec(id.charCodeAt(0)),
    symbolName: opts.symbolName,
    symbolKind: opts.symbolKind,
    parentSymbol: opts.parentSymbol,
    language: opts.language,
  };
}

async function freshStore(): Promise<{ store: SqliteStore; dir: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sqlite-store-test-"));
  const store = new SqliteStore(dir, DIM);
  await store.initialize();
  return { store, dir };
}

describe("SqliteStore", () => {
  let store: SqliteStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = await freshStore());
  });

  afterEach(async () => {
    try { store.close(); } catch {}
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
  });

  it("starts empty", () => {
    expect(store.getChunkCount()).toBe(0);
    expect(store.getFileCount()).toBe(0);
    expect(store.getIndexedPaths()).toEqual([]);
  });

  it("adds a chunk and reports counts", () => {
    store.add(makeChunk("a"));
    expect(store.getChunkCount()).toBe(1);
    expect(store.getIndexedPaths()).toEqual(["src/a.ts"]);
  });

  it("addBatch is transactional", () => {
    store.addBatch([makeChunk("a"), makeChunk("b"), makeChunk("c")]);
    expect(store.getChunkCount()).toBe(3);
  });

  it("rejects chunks without a vector", () => {
    const bad: Chunk = { ...makeChunk("a"), vector: undefined };
    expect(() => store.add(bad)).toThrow(/embedding vector/);
  });

  it("rejects chunks with the wrong dimension", () => {
    const bad = makeChunk("a", { vector: [0, 0, 0] });
    expect(() => store.add(bad)).toThrow(/dimension mismatch/);
  });

  it("removeByPath deletes chunks, vectors, and fts rows", () => {
    store.add(makeChunk("a"));
    store.add(makeChunk("b", { path: "src/b.ts" }));
    const removed = store.removeByPath("src/a.ts");
    expect(removed).toBe(1);
    expect(store.getIndexedPaths()).toEqual(["src/b.ts"]);
  });

  it("upsertFile records file hashes", () => {
    store.upsertFile("src/a.ts", "hash-1");
    store.upsertFile("src/a.ts", "hash-2");
    const hashes = store.getFileHashes();
    expect(hashes.get("src/a.ts")).toBe("hash-2");
    expect(store.getFileCount()).toBe(1);
  });

  it("vectorSearch returns nearest chunk first", () => {
    const anchor = makeVec(1);
    store.add(makeChunk("near", { vector: anchor }));
    store.add(makeChunk("far", { vector: makeVec(1000) }));
    const results = store.vectorSearch(anchor, 2);
    expect(results).toHaveLength(2);
    expect(results[0].chunk.id).toBe("near");
  });

  it("vectorSearch respects pathPrefix", () => {
    store.add(makeChunk("a", { path: "src/a.ts" }));
    store.add(makeChunk("b", { path: "tests/b.ts" }));
    const results = store.vectorSearch(makeVec(1), 10, "tests/");
    expect(results.map(r => r.chunk.path)).toEqual(["tests/b.ts"]);
  });

  it("vectorSearch over-fetches so a path-scoped hit isn't lost behind closer out-of-scope chunks", () => {
    const anchor = makeVec(1);
    // Many near, out-of-prefix chunks would fill a small KNN cut and starve the
    // single in-prefix match if filtering happened only after the cut.
    for (let i = 0; i < 40; i++) store.add(makeChunk(`src${i}`, { path: `src/f${i}.ts`, vector: makeVec(1 + i * 0.001) }));
    store.add(makeChunk("target", { path: "tests/target.ts", vector: makeVec(1.05) }));
    const results = store.vectorSearch(anchor, 3, "tests/");
    expect(results.map(r => r.chunk.path)).toContain("tests/target.ts");
  });

  it("clears chunks, files, and graph edges when a re-index is forced", async () => {
    store.add(makeChunk("a"));
    store.upsertFile("src/a.ts", "hash-1");
    store.addGraphEdges([{ sourcePath: "src/a.ts", targetPath: "src/b.ts", kind: "imports", confidence: 1 }]);
    expect(store.getChunkCount()).toBe(1);
    expect(store.getFileCount()).toBe(1);
    expect(store.getGraphEdgeCount()).toBe(1);
    store.close();
    // Reopening with a different embedding dimension forces a clean re-index.
    const s2 = new SqliteStore(dir, DIM + 4);
    await s2.initialize();
    expect(s2.getChunkCount()).toBe(0);
    expect(s2.getFileCount()).toBe(0);
    expect(s2.getGraphEdgeCount()).toBe(0);
    s2.close();
  });

  it("bm25Search finds keyword matches", () => {
    store.add(makeChunk("login", { contents: "function authenticateUser(password: string) {}" }));
    store.add(makeChunk("misc", { contents: "function renderButton() {}" }));
    const results = store.bm25Search("authenticateUser", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.id).toBe("login");
  });

  it("bm25Search returns [] for gibberish with no tokens", () => {
    store.add(makeChunk("a"));
    expect(store.bm25Search("!!!", 5)).toEqual([]);
  });

  it("getChunksReferencingIdentifier finds whole-word references via FTS", () => {
    store.add(makeChunk("a", { contents: "function authenticate() { return token; }" }));
    store.add(makeChunk("b", { contents: "function renderButton() { return ui; }" }));
    const hits = store.getChunksReferencingIdentifier("authenticate");
    expect(hits.map(c => c.id)).toEqual(["a"]);
  });

  it("getChunksReferencingIdentifier does not match substrings of larger tokens", () => {
    store.add(makeChunk("a", { contents: "function superAuthenticateUser() {}" }));
    store.add(makeChunk("b", { contents: "function authenticate() {}" }));
    const hits = store.getChunksReferencingIdentifier("authenticate");
    expect(hits.map(c => c.id)).toEqual(["b"]);
  });

  it("getChunksReferencingIdentifier is case-sensitive (exact identifier)", () => {
    store.add(makeChunk("a", { contents: "function Authenticate() {}" }));
    const hits = store.getChunksReferencingIdentifier("authenticate");
    expect(hits).toEqual([]);
  });

  it("getChunksReferencingIdentifier respects a path filter", () => {
    store.add(makeChunk("a", { path: "src/a.ts", contents: "call doThing();" }));
    store.add(makeChunk("b", { path: "tests/b.ts", contents: "call doThing();" }));
    const hits = store.getChunksReferencingIdentifier("doThing", "tests/b.ts");
    expect(hits.map(c => c.path)).toEqual(["tests/b.ts"]);
  });

  it("getChunksBySymbol indexes by symbol_name", () => {
    store.add(makeChunk("a", { symbolName: "renderHeader", symbolKind: "function" }));
    store.add(makeChunk("b", { symbolName: "renderFooter", symbolKind: "function" }));
    const hits = store.getChunksBySymbol("renderHeader");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("a");
  });

  it("auto-deletes legacy JSON files on first open", async () => {
    const legacyDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "legacy-"));
    await fs.promises.writeFile(path.join(legacyDir, "store.json"), "{}");
    await fs.promises.writeFile(path.join(legacyDir, "vectors.json"), "[]");
    const s = new SqliteStore(legacyDir, DIM);
    await s.initialize();
    expect(fs.existsSync(path.join(legacyDir, "store.json"))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, "vectors.json"))).toBe(false);
    s.close();
    await fs.promises.rm(legacyDir, { recursive: true, force: true });
  });

  it("round-trips indexed git state", () => {
    expect(store.getIndexedGit()).toBeUndefined();
    store.setIndexedGit({ available: true, branch: "main", commit: "abc123" });
    expect(store.getIndexedGit()).toEqual({ available: true, branch: "main", commit: "abc123" });
    store.setIndexedGit(undefined);
    expect(store.getIndexedGit()).toBeUndefined();
  });

  it("persists across reopen", async () => {
    store.add(makeChunk("a"));
    store.close();
    const s2 = new SqliteStore(dir, DIM);
    await s2.initialize();
    expect(s2.getChunkCount()).toBe(1);
    s2.close();
  });

  describe("bm25 ranking (porter stemming + column weights)", () => {
    it("stems query words to match identifier/path morphology", () => {
      // "chunks" (query) must reach "chunker"/"chunking" (code) — without
      // stemming these are disjoint tokens and the real ast-chunker.ts
      // never surfaced for chunking queries.
      store.add(makeChunk("c1", {
        path: "src/core/ast-chunker.ts",
        symbolName: "AstChunker",
        contents: "class AstChunker { /* chunking code along boundaries */ }",
      }));
      const hits = store.bm25Search("split code into chunks", 5);
      expect(hits.some(h => h.chunk.path === "src/core/ast-chunker.ts")).toBe(true);
    });

    it("ranks a path/symbol match above heavy content repetition", () => {
      // store.ts spams "chunk" in its body (table names); chunker.ts matches
      // on path + symbol. The weighted bm25 must put chunker.ts first.
      store.add(makeChunk("spam", {
        path: "src/core/store.ts",
        symbolName: "Store",
        contents: Array.from({ length: 60 }, () => "insert into chunks (chunk) values (chunk);").join("\n"),
      }));
      store.add(makeChunk("real", {
        path: "src/core/chunker.ts",
        symbolName: "CodeChunker",
        contents: "export class CodeChunker { split(file) { return pieces; } }",
      }));
      const hits = store.bm25Search("chunker", 5);
      expect(hits[0]?.chunk.path).toBe("src/core/chunker.ts");
    });

    it("camel-split symbols are lexically reachable", () => {
      // "StepBudget" is one unicode61 token; the split copy ("Step Budget")
      // lets the stemmed query word "steps" land on the symbol column.
      store.add(makeChunk("sb", {
        path: "src/agent/step-budget.ts",
        symbolName: "StepBudget",
        contents: "export class StepBudget { remaining() { return 1; } }",
      }));
      const hits = store.bm25Search("limiting agent tool steps", 5);
      expect(hits.some(h => h.chunk.symbolName === "StepBudget")).toBe(true);
    });
  });
});

describe("SqliteStore keyword-only mode (sqlite-vec unavailable)", () => {
  const brokenVec = { resolveVecPath: () => "/nonexistent/vec0.so" };
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      try { await fs.promises.rm(d, { recursive: true, force: true }); } catch {}
    }
  });

  async function keywordOnlyStore(dir?: string): Promise<{ store: SqliteStore; dir: string }> {
    const d = dir ?? (await fs.promises.mkdtemp(path.join(os.tmpdir(), "sqlite-store-kw-")));
    if (!dir) dirs.push(d);
    const store = new SqliteStore(d, DIM, brokenVec);
    await store.initialize();
    return { store, dir: d };
  }

  function vectorlessChunk(id: string, opts: Partial<Chunk> = {}): Chunk {
    const c = makeChunk(id, opts);
    delete (c as any).vector;
    return c;
  }

  it("initializes without vec0 and reports keyword-only", async () => {
    const { store } = await keywordOnlyStore();
    expect(store.isVectorAvailable()).toBe(false);
    expect(store.getVectorDiagnosis()).toBeDefined();
    store.close();
  });

  it("accepts vector-less chunks and serves BM25 search; vectorSearch is empty", async () => {
    const { store } = await keywordOnlyStore();
    store.add(vectorlessChunk("alpha", { contents: "export function authenticateUser() { return session; }" }));
    store.add(vectorlessChunk("beta", { contents: "export function renderChart() { return svg; }" }));
    expect(store.getChunkCount()).toBe(2);
    const hits = store.bm25Search("authenticateUser", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.path).toBe("src/alpha.ts");
    expect(store.vectorSearch(makeVec(1), 5)).toEqual([]);
    store.close();
  });

  it("removeByPath works without vec statements", async () => {
    const { store } = await keywordOnlyStore();
    store.add(vectorlessChunk("gamma"));
    expect(store.removeByPath("src/gamma.ts")).toBe(1);
    expect(store.getChunkCount()).toBe(0);
    expect(store.bm25Search("gamma", 5)).toEqual([]);
    store.close();
  });

  it("persists across keyword-only reopens without wiping", async () => {
    const { store, dir } = await keywordOnlyStore();
    store.add(vectorlessChunk("delta"));
    store.close();
    const { store: reopened } = await keywordOnlyStore(dir);
    expect(reopened.isVectorAvailable()).toBe(false);
    expect(reopened.getChunkCount()).toBe(1);
    expect(reopened.bm25Search("delta", 5).length).toBeGreaterThan(0);
    reopened.close();
  });

  it("recreates the store when a keyword-only DB is reopened with vectors available", async () => {
    const { store, dir } = await keywordOnlyStore();
    store.add(vectorlessChunk("epsilon"));
    store.close();
    // Real vec0 loads in CI — the persisted fts-only state must force a clean
    // rebuild, otherwise hash-matched files would never get embeddings.
    const vecStore = new SqliteStore(dir, DIM);
    await vecStore.initialize();
    expect(vecStore.isVectorAvailable()).toBe(true);
    expect(vecStore.getChunkCount()).toBe(0);
    expect(vecStore.getFileHashes().size).toBe(0);
    vecStore.close();
  });

  it("recreates the store when a vector DB is reopened keyword-only", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sqlite-store-kw-"));
    dirs.push(dir);
    const vecStore = new SqliteStore(dir, DIM);
    await vecStore.initialize();
    vecStore.add(makeChunk("zeta"));
    vecStore.upsertFile("src/zeta.ts", "hash1");
    vecStore.close();
    const { store } = await keywordOnlyStore(dir);
    expect(store.isVectorAvailable()).toBe(false);
    expect(store.getChunkCount()).toBe(0);
    expect(store.getFileHashes().size).toBe(0);
    store.add(vectorlessChunk("eta"));
    expect(store.bm25Search("eta", 5).length).toBeGreaterThan(0);
    store.close();
  });
});
