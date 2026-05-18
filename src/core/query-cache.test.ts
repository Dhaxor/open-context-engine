import { describe, it, expect } from "vitest";
import { QueryCache } from "./query-cache";

describe("QueryCache", () => {
  it("caches and retrieves embeddings", () => {
    const cache = new QueryCache();
    const vec = [1.0, 2.0, 3.0];
    cache.setEmbedding("hello", vec);
    expect(cache.getEmbedding("hello")).toEqual(vec);
  });

  it("returns null for missing entries", () => {
    const cache = new QueryCache();
    expect(cache.getEmbedding("missing")).toBeNull();
    expect(cache.getResults("missing")).toBeNull();
  });

  it("invalidates all entries on version bump", () => {
    const cache = new QueryCache();
    cache.setEmbedding("q1", [1, 2, 3]);
    cache.setResults("q1", [{ chunk: { id: "a", path: "a.ts", startLine: 1, endLine: 5, contents: "x" }, score: 1.0 }]);
    cache.invalidate();
    expect(cache.getEmbedding("q1")).toBeNull();
    expect(cache.getResults("q1")).toBeNull();
  });

  it("evicts oldest entry when full", () => {
    const cache = new QueryCache(2);
    cache.setEmbedding("first", [1]);
    cache.setEmbedding("second", [2]);
    cache.setEmbedding("third", [3]);
    expect(cache.getEmbedding("first")).toBeNull();
    expect(cache.getEmbedding("second")).toEqual([2]);
    expect(cache.getEmbedding("third")).toEqual([3]);
  });

  it("caches search results", () => {
    const cache = new QueryCache();
    const results = [{ chunk: { id: "c1", path: "file.ts", startLine: 1, endLine: 10, contents: "code" }, score: 0.95 }];
    cache.setResults("query-key", results);
    expect(cache.getResults("query-key")).toEqual(results);
  });

  it("increments version on invalidate", () => {
    const cache = new QueryCache();
    const v0 = cache.getVersion();
    cache.invalidate();
    expect(cache.getVersion()).toBe(v0 + 1);
  });
});
