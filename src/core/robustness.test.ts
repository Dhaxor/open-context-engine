import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { VoyageEmbeddingProvider, parseRetryAfterMs, EmbeddingProvider } from "./embedder";
import { OpenContext } from "./context";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds and caps them", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("3600")).toBe(60_000); // capped
  });

  it("parses HTTP-dates and ignores garbage", () => {
    const inTwoSec = new Date(Date.now() + 2000).toUTCString();
    const parsed = parseRetryAfterMs(inTwoSec)!;
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(2000);
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe("embedding HTTP hardening", () => {
  it("attaches a timeout signal and honors Retry-After on 429", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (_url: any, init: any) => {
      calls.push(init);
      if (calls.length === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }), { status: 200 });
    });
    const provider = new VoyageEmbeddingProvider({ provider: "voyage", model: "voyage-code-3", apiKey: "vk", dimension: 4, batchSize: 8 });
    const vectors = await provider.embed(["hello"]);
    expect(vectors).toEqual([[1, 2, 3, 4]]);
    expect(calls).toHaveLength(2);            // 429 → immediate (Retry-After: 0) retry → 200
    expect(calls[0].signal).toBeInstanceOf(AbortSignal); // hung sockets get cut
  });
});

describe("minScore relevance floor", () => {
  const embedder: EmbeddingProvider = {
    // "alpha" texts → [1,0,0,0]; everything else → [0,1,0,0].
    embed: async (texts) => texts.map(t => (t.includes("alpha") ? [1, 0, 0, 0] : [0, 1, 0, 0])),
    getDimension: () => 4,
    getModel: () => "mock",
  };

  async function makeCtx(minScore: number) {
    const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-minscore-"));
    const ctx = await OpenContext.create({
      workspaceRoot: ws,
      storePath: path.join(ws, ".store"),
      embedding: { provider: "ollama", model: "mock", dimension: 4, batchSize: 8 },
      embedder,
      search: { minScore },
      policy: false,
    });
    await ctx.addFiles([
      { path: "alpha.txt", contents: "the alpha subsystem does alpha things" },
      { path: "beta.txt", contents: "unrelated beta content entirely" },
    ]);
    return { ctx, ws };
  }

  it("floors out low-relevance vector matches, keeps strong ones", async () => {
    const { ctx, ws } = await makeCtx(0.5);
    try {
      const results = await ctx.searchRaw("alpha subsystem", 10, { expandSymbols: false });
      const paths = results.map(r => r.chunk.path);
      expect(paths).toContain("alpha.txt");
      expect(paths).not.toContain("beta.txt"); // cosine 0 < 0.5 floor
    } finally {
      ctx.close();
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });

  it("minScore 0 (default) keeps everything, preserving old behavior", async () => {
    const { ctx, ws } = await makeCtx(0);
    try {
      const results = await ctx.searchRaw("alpha subsystem", 10, { expandSymbols: false });
      expect(results.length).toBeGreaterThanOrEqual(2);
    } finally {
      ctx.close();
      await fs.promises.rm(ws, { recursive: true, force: true });
    }
  });
});
