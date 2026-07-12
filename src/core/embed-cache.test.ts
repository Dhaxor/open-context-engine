import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EmbedCache, contentHash, defaultEmbedCachePath } from "./embed-cache";
import { OpenContext } from "./context";
import { EmbeddingProvider } from "./embedder";

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-ecache-"));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  delete process.env.OCE_EMBED_CACHE;
});

describe("EmbedCache", () => {
  it("round-trips vectors at full float32 precision", async () => {
    const cache = new EmbedCache(path.join(dir, "cache.db"));
    const vector = [0.125, -0.5, 3.25, 0];
    const hash = contentHash("const x = 1;");
    await cache.put("m", 4, [{ hash, vector }]);
    const got = await cache.get("m", 4, [hash]);
    expect(got.get(hash)).toEqual(vector);
    cache.close();
  });

  it("isolates entries by model and dimension", async () => {
    const cache = new EmbedCache(path.join(dir, "cache.db"));
    const hash = contentHash("shared content");
    await cache.put("model-a", 4, [{ hash, vector: [1, 2, 3, 4] }]);
    expect((await cache.get("model-b", 4, [hash])).size).toBe(0);
    expect((await cache.get("model-a", 8, [hash])).size).toBe(0);
    expect((await cache.get("model-a", 4, [hash])).size).toBe(1);
    cache.close();
  });

  it("persists across instances and tracks stats", async () => {
    const p = path.join(dir, "cache.db");
    const first = new EmbedCache(p);
    await first.put("m", 2, [{ hash: contentHash("a"), vector: [1, 2] }]);
    first.close();

    const second = new EmbedCache(p);
    const got = await second.get("m", 2, [contentHash("a"), contentHash("b")]);
    expect(got.size).toBe(1);
    expect(second.getStats()).toMatchObject({ hits: 1, misses: 1 });
    second.close();
  });

  it("never throws on an unusable path", async () => {
    const cache = new EmbedCache(path.join(dir, "\0nope", "cache.db"));
    await expect(cache.get("m", 2, [contentHash("a")])).resolves.toEqual(new Map());
    await expect(cache.put("m", 2, [{ hash: contentHash("a"), vector: [1, 2] }])).resolves.toBeUndefined();
    cache.close();
  });

  it("OCE_EMBED_CACHE overrides the default path", () => {
    process.env.OCE_EMBED_CACHE = "/tmp/custom-cache.db";
    expect(defaultEmbedCachePath()).toBe("/tmp/custom-cache.db");
  });
});

describe("OpenContext + embed cache", () => {
  const DIM = 4;

  function countingEmbedder() {
    let calls = 0;
    const embedder: EmbeddingProvider = {
      embed: async (texts: string[]) => { calls += texts.length; return texts.map(t => [t.length % 5, 0.25, 0.5, 0.75]); },
      getDimension: () => DIM,
      getModel: () => "mock-model",
    };
    return { embedder, calls: () => calls };
  }

  async function makeContext(ws: string, embedder: EmbeddingProvider, cachePath: string): Promise<OpenContext> {
    return OpenContext.create({
      workspaceRoot: ws,
      storePath: path.join(ws, ".store"),
      embedding: { provider: "ollama", model: "mock-model", dimension: DIM, batchSize: 32 },
      embedder,
      embedCache: cachePath,
      policy: false,
    });
  }

  it("a full re-index into a fresh store embeds nothing when the cache is warm", async () => {
    const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-ecache-ws-"));
    const cachePath = path.join(dir, "shared.db");
    await fs.promises.writeFile(path.join(ws, "a.ts"), "export const a = 1;\n");
    await fs.promises.writeFile(path.join(ws, "b.ts"), "export const b = 2;\n");
    try {
      const cold = countingEmbedder();
      const ctx1 = await makeContext(ws, cold.embedder, cachePath);
      await ctx1.indexWorkspace();
      ctx1.close();
      expect(cold.calls()).toBeGreaterThan(0);

      // Same content, brand-new store (e.g. teammate clone / store rebuild).
      await fs.promises.rm(path.join(ws, ".store"), { recursive: true, force: true });
      const warm = countingEmbedder();
      const ctx2 = await makeContext(ws, warm.embedder, cachePath);
      await ctx2.indexWorkspace();
      try {
        expect(warm.calls()).toBe(0); // every chunk came from the cache
        expect(await ctx2.search("export const")).toContain("a.ts");
      } finally {
        ctx2.close();
      }
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  });
});
