import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenContext } from "./context";
import { OpenContextConfig, File } from "./types";
import { EmbeddingProvider } from "./embedder";

/**
 * Keyword-only mode: when sqlite-vec can't load (unsupported platform), the
 * engine must index and search on BM25/FTS5 alone — with ZERO embedding
 * calls. The exploding embedder makes any accidental embed call a test
 * failure, not just wasted work.
 */

const DIM = 4;

function explodingEmbedder(): { embedder: EmbeddingProvider; callCount: () => number } {
  let calls = 0;
  const embedder: EmbeddingProvider = {
    embed: async () => {
      calls++;
      throw new Error("embed() must never be called in keyword-only mode");
    },
    getDimension: () => DIM,
    getModel: () => "mock",
  };
  return { embedder, callCount: () => calls };
}

const FILES: File[] = [
  { path: "src/auth.ts", contents: "export function authenticateUser(token: string) { return verifySession(token); }" },
  { path: "src/chart.ts", contents: "export function renderChart(data: number[]) { return toSvg(data); }" },
  { path: "src/db.ts", contents: "export function openDatabase(file: string) { return connect(file); }" },
];

let dir: string;
afterEach(async () => {
  try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
});

async function makeContext(embedder: EmbeddingProvider, keywordOnly: boolean): Promise<OpenContext> {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-kw-"));
  const config: OpenContextConfig = {
    workspaceRoot: dir,
    storePath: path.join(dir, ".store"),
    embedding: { provider: "ollama", model: "mock", dimension: DIM, batchSize: 32 },
    embedder,
    ...(keywordOnly ? { resolveVecPath: () => "/nonexistent/vec0.so" } : {}),
  };
  return OpenContext.create(config);
}

describe("keyword-only mode (sqlite-vec unavailable)", () => {
  it("indexes and searches with zero embedding calls", async () => {
    const mock = explodingEmbedder();
    const ctx = await makeContext(mock.embedder, true);
    try {
      const result = await ctx.addFiles(FILES);
      expect(result.failed).toBeUndefined();
      expect(result.newlyIndexed).toHaveLength(FILES.length);
      expect(ctx.getChunkCount()).toBeGreaterThan(0);
      expect(mock.callCount()).toBe(0);

      const hits = await ctx.searchRaw("authenticateUser", 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].chunk.path).toBe("src/auth.ts");
      expect(mock.callCount()).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("reports keyword-only status with a reason", async () => {
    const mock = explodingEmbedder();
    const ctx = await makeContext(mock.embedder, true);
    try {
      const status = ctx.getStatus();
      expect(status.searchMode).toBe("keyword-only");
      expect(status.degradedReason).toBeTruthy();
    } finally {
      ctx.close();
    }
  });

  it("retrieveDebug surfaces empty vector hits without erroring", async () => {
    const mock = explodingEmbedder();
    const ctx = await makeContext(mock.embedder, true);
    try {
      await ctx.addFiles(FILES);
      const report = await ctx.searchDebug("renderChart", 5);
      expect(report.vectorHits).toEqual([]);
      expect(report.bm25Hits.length).toBeGreaterThan(0);
      expect(report.final.length).toBeGreaterThan(0);
      expect(mock.callCount()).toBe(0);
    } finally {
      ctx.close();
    }
  });

  it("a vec-capable context still reports hybrid mode", async () => {
    // Sanity check on the same machinery: with the real vec0 (available on
    // every CI platform), the flag must stay hybrid.
    const working: EmbeddingProvider = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      getDimension: () => DIM,
      getModel: () => "mock",
    };
    const ctx = await makeContext(working, false);
    try {
      expect(ctx.getStatus().searchMode).toBe("hybrid");
      expect(ctx.getStatus().degradedReason).toBeUndefined();
    } finally {
      ctx.close();
    }
  });
});
