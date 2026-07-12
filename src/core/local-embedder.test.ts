import { describe, it, expect, afterEach } from "vitest";
import { LocalEmbeddingProvider, __setTransformersLoaderForTests, localModelCacheDir, createEmbeddingProvider } from "./embedder";

afterEach(() => {
  __setTransformersLoaderForTests(null);
  delete process.env.OCE_MODEL_DIR;
});

/** Fake transformers module: pipeline() returns a callable that mean-embeds
 *  each text to a fixed-dimension vector derived from its length. */
function fakeTransformers(dimension: number, calls: string[][]) {
  return {
    env: {} as Record<string, unknown>,
    pipeline: async (_task: string, _model: string, _opts: unknown) => {
      return async (texts: string[], _o: unknown) => {
        calls.push(texts);
        const vectors = texts.map(t => Array.from({ length: dimension }, (_, i) => (t.length + i) % 7));
        return { tolist: () => vectors };
      };
    },
  };
}

describe("LocalEmbeddingProvider", () => {
  it("embeds via the transformers pipeline with batching", async () => {
    const calls: string[][] = [];
    __setTransformersLoaderForTests(async () => fakeTransformers(4, calls));
    const p = new LocalEmbeddingProvider({ provider: "local", model: "Xenova/test", dimension: 4, batchSize: 2 });
    const vecs = await p.embed(["a", "bb", "ccc"]);
    expect(vecs).toHaveLength(3);
    expect(vecs[0]).toHaveLength(4);
    expect(calls).toEqual([["a", "bb"], ["ccc"]]); // batchSize 2 → 2 calls
  });

  it("reuses one pipeline across embed calls", async () => {
    const calls: string[][] = [];
    let pipelineBuilds = 0;
    const mod = fakeTransformers(4, calls);
    const origPipeline = mod.pipeline;
    mod.pipeline = async (...args: [string, string, unknown]) => { pipelineBuilds++; return origPipeline(...args); };
    __setTransformersLoaderForTests(async () => mod);
    const p = new LocalEmbeddingProvider({ provider: "local", model: "Xenova/test", dimension: 4, batchSize: 8 });
    await p.embed(["x"]);
    await p.embed(["y"]);
    expect(pipelineBuilds).toBe(1);
  });

  it("points the transformers cache at localModelCacheDir (OCE_MODEL_DIR wins)", async () => {
    process.env.OCE_MODEL_DIR = "/tmp/oce-test-models";
    const calls: string[][] = [];
    const mod = fakeTransformers(4, calls);
    __setTransformersLoaderForTests(async () => mod);
    const p = new LocalEmbeddingProvider({ provider: "local", model: "Xenova/test", dimension: 4, batchSize: 8 });
    await p.embed(["x"]);
    expect(mod.env.cacheDir).toBe("/tmp/oce-test-models");
    expect(localModelCacheDir()).toBe("/tmp/oce-test-models");
  });

  it("gives an actionable install message when the optional dep is missing", async () => {
    __setTransformersLoaderForTests(async () => { throw new Error("Cannot find module"); });
    const p = new LocalEmbeddingProvider({ provider: "local", model: "Xenova/test", dimension: 4, batchSize: 8 });
    await expect(p.embed(["x"])).rejects.toThrow(/@huggingface\/transformers/);
  });

  it("retries the load after a failed attempt (user installs mid-session)", async () => {
    let attempt = 0;
    const calls: string[][] = [];
    __setTransformersLoaderForTests(async () => {
      if (attempt++ === 0) throw new Error("Cannot find module");
      return fakeTransformers(4, calls);
    });
    const p = new LocalEmbeddingProvider({ provider: "local", model: "Xenova/test", dimension: 4, batchSize: 8 });
    await expect(p.embed(["x"])).rejects.toThrow();
    await expect(p.embed(["x"])).resolves.toHaveLength(1);
  });

  it("is constructed by createEmbeddingProvider for provider 'local'", () => {
    const p = createEmbeddingProvider({ provider: "local", model: "Xenova/test", dimension: 4, batchSize: 8 });
    expect(p).toBeInstanceOf(LocalEmbeddingProvider);
    expect(p.getDimension()).toBe(4);
  });
});
