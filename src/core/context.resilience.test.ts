import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenContext } from "./context";
import { OpenContextConfig, File } from "./types";
import { EmbeddingProvider } from "./embedder";

/**
 * Indexing resilience: one bad embedding batch must not abort the whole run.
 * Files are processed in windows of 48 (FILE_BATCH in context.ts); these tests
 * use file counts chosen to span multiple windows.
 */

const DIM = 4;

interface MockBehavior {
  failWhen?: (texts: string[]) => boolean;
  failWith?: () => Error;
}

function mockEmbedder(behavior: MockBehavior = {}) {
  let calls = 0;
  const embedder: EmbeddingProvider = {
    embed: async (texts: string[]) => {
      calls++;
      if (behavior.failWhen?.(texts)) throw behavior.failWith?.() ?? new Error("HTTP 500: transient upstream error");
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
    getDimension: () => DIM,
    getModel: () => "mock",
  };
  return { embedder, callCount: () => calls, behavior };
}

function makeFiles(count: number, marker: (i: number) => string = () => ""): File[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `notes/f${String(i).padStart(3, "0")}.txt`,
    contents: `note ${i} ${marker(i)} lorem ipsum dolor`,
  }));
}

let dir: string;
afterEach(async () => {
  try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
});

async function makeContext(embedder: EmbeddingProvider): Promise<OpenContext> {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-resil-"));
  const config: OpenContextConfig = {
    workspaceRoot: dir,
    storePath: path.join(dir, ".store"),
    embedding: { provider: "ollama", model: "mock", dimension: DIM, batchSize: 32 },
    embedder,
  };
  return OpenContext.create(config);
}

describe("indexing resilience", () => {
  it("clean runs report no failures", async () => {
    const mock = mockEmbedder();
    const ctx = await makeContext(mock.embedder);
    try {
      const result = await ctx.addFiles(makeFiles(10));
      expect(result.failed).toBeUndefined();
      expect(result.newlyIndexed).toHaveLength(10);
      expect(ctx.getChunkCount()).toBe(10);
    } finally { ctx.close(); }
  });

  it("a failing window marks only its own files failed and the run continues", async () => {
    // 110 files = windows [0..47], [48..95], [96..109]. Window 2 carries a
    // marker that makes the embedder throw; windows 1 and 3 must survive.
    const mock = mockEmbedder({ failWhen: (texts) => texts.some(t => t.includes("WINDOW2_MARKER")) });
    const ctx = await makeContext(mock.embedder);
    try {
      const files = makeFiles(110, (i) => (i >= 48 && i < 96 ? "WINDOW2_MARKER" : ""));
      const result = await ctx.addFiles(files);

      expect(result.failed).toBeDefined();
      expect(result.failed!).toHaveLength(48);
      expect(result.failed!.every(p => {
        const n = Number(p.match(/f(\d+)\.txt/)![1]);
        return n >= 48 && n < 96;
      })).toBe(true);
      expect(result.failedReason).toMatch(/transient/);

      // Succeeded files are indexed and hashed; failed files are neither
      // hashed (so the next incremental retries them) nor counted as new.
      expect(result.newlyIndexed).toHaveLength(62);
      const hashedPaths = new Set(ctx.getIndexedFiles().map(f => f.path));
      expect(hashedPaths.has("notes/f000.txt")).toBe(true);
      expect(hashedPaths.has("notes/f109.txt")).toBe(true);
      expect(hashedPaths.has("notes/f050.txt")).toBe(false);
    } finally { ctx.close(); }
  });

  it("stops hammering a downed provider after 3 consecutive window failures", async () => {
    // 220 files = 5 windows. All embeds fail; after 3 failed windows the run
    // stops and the remaining files are marked failed without further calls.
    const mock = mockEmbedder({ failWhen: () => true });
    const ctx = await makeContext(mock.embedder);
    try {
      const result = await ctx.addFiles(makeFiles(220));
      expect(result.failed).toHaveLength(220);
      expect(result.failedReason).toMatch(/unavailable/i);
      expect(result.newlyIndexed).toHaveLength(0);
      // Each 48-file window embeds in one concurrent group-pair → ≤2 calls per
      // window; 3 windows before the stop → at most 6 embed calls, never 10.
      expect(mock.callCount()).toBeLessThanOrEqual(6);
    } finally { ctx.close(); }
  });

  it("aborts immediately with a clear message on auth errors", async () => {
    const mock = mockEmbedder({
      failWhen: () => true,
      failWith: () => Object.assign(new Error("HTTP 401: unauthorized"), { status: 401 }),
    });
    const ctx = await makeContext(mock.embedder);
    try {
      await expect(ctx.addFiles(makeFiles(60))).rejects.toThrow(/API key/);
      // Fast abort: only the first window's embed attempt happened.
      expect(mock.callCount()).toBeLessThanOrEqual(2);
    } finally { ctx.close(); }
  });

  it("treats the providers' real missing-key message as an auth error (no status field)", async () => {
    // VoyageEmbeddingProvider throws exactly this shape when the key is absent —
    // an Error with NO status. The fast-abort must still fire.
    const mock = mockEmbedder({
      failWhen: () => true,
      failWith: () => new Error("VOYAGE_API_KEY is required. Set it via environment variable or config."),
    });
    const ctx = await makeContext(mock.embedder);
    try {
      await expect(ctx.addFiles(makeFiles(60))).rejects.toThrow(/API key/);
      expect(mock.callCount()).toBeLessThanOrEqual(2);
    } finally { ctx.close(); }
  });

  it("does NOT classify a 500 whose body echoes 'HTTP 401' as an auth error", async () => {
    // Gateways echo upstream errors in the body; the numeric status must win.
    const mock = mockEmbedder({
      failWhen: () => true,
      failWith: () => Object.assign(new Error("HTTP 500: upstream said HTTP 401 unauthorized"), { status: 500 }),
    });
    const ctx = await makeContext(mock.embedder);
    try {
      const result = await ctx.addFiles(makeFiles(60));
      // Resilient path, not an abort: files marked failed, run completed.
      expect(result.failed).toHaveLength(60);
      expect(result.failedReason).toMatch(/unavailable|HTTP 500/);
    } finally { ctx.close(); }
  });

  it("cleans up orphaned chunks of a failed-then-deleted file on the next incremental index", async () => {
    // Simulate the orphan state directly: chunks in the store for a path that
    // has NO hash row (exactly what a failed window leaves behind), where the
    // file doesn't exist on disk. The incremental stale-sweep must remove it.
    const mock = mockEmbedder();
    const ctx = await makeContext(mock.embedder);
    try {
      const store = (ctx as any).store;
      store.addBatch([{
        id: "orphan-1", path: "notes/deleted-while-failed.txt",
        startLine: 1, endLine: 1, contents: "orphaned partial chunk",
        vector: [0.1, 0.2, 0.3, 0.4],
      }]);
      expect(store.getIndexedPaths()).toContain("notes/deleted-while-failed.txt");

      const result = await ctx.incrementalIndex();
      expect(result.removed).toContain("notes/deleted-while-failed.txt");
      expect(store.getIndexedPaths()).not.toContain("notes/deleted-while-failed.txt");
    } finally { ctx.close(); }
  });

  it("recovers on retry: failed files succeed once the provider is healthy again", async () => {
    const mock = mockEmbedder({ failWhen: (texts) => texts.some(t => t.includes("WINDOW2_MARKER")) });
    const ctx = await makeContext(mock.embedder);
    try {
      const files = makeFiles(110, (i) => (i >= 48 && i < 96 ? "WINDOW2_MARKER" : ""));
      const first = await ctx.addFiles(files);
      expect(first.failed).toHaveLength(48);

      // Provider recovers.
      mock.behavior.failWhen = undefined;
      const retry = await ctx.addFiles(files.filter(f => first.failed!.includes(f.path)));
      expect(retry.failed).toBeUndefined();
      expect(retry.newlyIndexed).toHaveLength(48);
      const hashedPaths = new Set(ctx.getIndexedFiles().map(f => f.path));
      expect(hashedPaths.has("notes/f050.txt")).toBe(true);
      expect(ctx.getChunkCount()).toBe(110);
    } finally { ctx.close(); }
  });
});
