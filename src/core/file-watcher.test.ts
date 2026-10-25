import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileWatcher } from "./file-watcher";
import { OpenContext } from "./context";
import { OpenContextConfig, IndexingResult, File } from "./types";
import { EmbeddingProvider } from "./embedder";

/**
 * Watcher regression suite. The recent bug cluster was all interrupted runs
 * and watcher-filled stores; these pin the contract the fixes rely on:
 * a watcher keeps a real store in step (create/edit/delete), defers nothing
 * forever, reports honestly, survives indexing errors, and never drops a
 * change that lands while a flush is in flight.
 */

const DIM = 4;

function mockEmbedder(): EmbeddingProvider {
  return {
    embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
    getDimension: () => DIM,
    getModel: () => "mock",
  };
}

const tmpDirs: string[] = [];
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-watch-"));
  tmpDirs.push(dir);
  return dir;
}

function realConfig(root: string): OpenContextConfig {
  return {
    workspaceRoot: root,
    storePath: path.join(root, ".store"),
    embedding: { provider: "ollama", model: "mock", dimension: DIM, batchSize: 32 },
    embedder: mockEmbedder(),
  };
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

describe("FileWatcher against a real store", () => {
  it("keeps the store in step across create, edit, and delete", async () => {
    const root = makeWorkspace();
    const ctx = await OpenContext.create(realConfig(root));
    const watcher = new FileWatcher(ctx, realConfig(root), 60);
    await watcher.start();
    try {
      const file = path.join(root, "a.ts");
      fs.writeFileSync(file, "export const alpha = 1;\n");
      await waitFor(() => ctx.getIndexedFiles().some(f => f.path === "a.ts"), "create lands in the index");

      fs.writeFileSync(file, "export const alpha = 2;\nexport const beta = 3;\n");
      await waitFor(async () => (await ctx.searchRaw("beta")).some(r => r.chunk.path === "a.ts"), "edited content is searchable");

      fs.unlinkSync(file);
      await waitFor(() => !ctx.getIndexedFiles().some(f => f.path === "a.ts"), "delete leaves the index");
      expect(ctx.getChunkCount()).toBe(0);
    } finally {
      await watcher.stop();
      ctx.close();
    }
  });

  it("drops a file that stops being indexable (replaced by binary content)", async () => {
    const root = makeWorkspace();
    const ctx = await OpenContext.create(realConfig(root));
    const watcher = new FileWatcher(ctx, realConfig(root), 60);
    await watcher.start();
    try {
      const file = path.join(root, "b.ts");
      fs.writeFileSync(file, "export const bravo = 1;\n");
      await waitFor(() => ctx.getIndexedFiles().some(f => f.path === "b.ts"), "initial index");

      // The path still exists, so chokidar reports a change — but the new
      // bytes are binary and must be treated as a removal. The deferred
      // removal has no event to piggyback on; the watcher must flush it on
      // its own or the stale chunks linger forever.
      fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
      await waitFor(() => !ctx.getIndexedFiles().some(f => f.path === "b.ts"), "binary replacement is evicted");
    } finally {
      await watcher.stop();
      ctx.close();
    }
  });

  it("never deletes an indexed file when nothing about it changed", async () => {
    // Guard the guard: a binary neighbour must not cost the healthy file its
    // place in the index (removals are per-path, not a sweep).
    const root = makeWorkspace();
    const ctx = await OpenContext.create(realConfig(root));
    const watcher = new FileWatcher(ctx, realConfig(root), 60);
    await watcher.start();
    try {
      fs.writeFileSync(path.join(root, "keep.ts"), "export const keep = 1;\n");
      await waitFor(() => ctx.getIndexedFiles().some(f => f.path === "keep.ts"), "keep.ts indexed");
      fs.writeFileSync(path.join(root, "drop.png"), Buffer.from([0x00, 0x01, 0x00, 0xff]));
      await new Promise(r => setTimeout(r, 400));
      expect(ctx.getIndexedFiles().map(f => f.path)).toEqual(["keep.ts"]);
    } finally {
      await watcher.stop();
      ctx.close();
    }
  });
});

interface FakeCalls {
  added: File[][];
  removed: string[][];
  errors: Error[];
  reports: IndexingResult[];
  failNextAdd?: Error;
  /** Holds each addFiles call open until released; entries are the resolvers. */
  gates?: Array<() => void>;
}

function fakeContext(calls: FakeCalls): OpenContext {
  const EMPTY: IndexingResult = { newlyIndexed: [], alreadyIndexed: [], removed: [], duration: 0 };
  return {
    addFiles: async (files: File[]) => {
      if (calls.failNextAdd) { const e = calls.failNextAdd; calls.failNextAdd = undefined; throw e; }
      calls.added.push(files);
      if (calls.gates) await new Promise<void>(resolve => calls.gates!.push(resolve));
      return { ...EMPTY, newlyIndexed: files.map(f => f.path) };
    },
    removeFromIndex: async (paths: string[]) => { calls.removed.push(paths); },
    getChunkCount: () => 0,
  } as unknown as OpenContext;
}

function fakeConfig(root: string): OpenContextConfig {
  return { workspaceRoot: root, embedding: { provider: "voyage", model: "voyage-code-3", dimension: 1024, batchSize: 32 } };
}

describe("FileWatcher batching and failure behaviour", () => {
  it("reports removals alongside additions from the same window", async () => {
    const root = makeWorkspace();
    const calls: FakeCalls = { added: [], removed: [], errors: [], reports: [] };
    // chokidar's awaitWriteFinish holds add/change events ~250ms past the
    // write while unlink fires at once, so a debounce shorter than that
    // splits them into two flushes. 600ms keeps one window.
    const watcher = new FileWatcher(fakeContext(calls), fakeConfig(root), 600);
    await watcher.start({ onReindex: r => calls.reports.push(r), onError: e => calls.errors.push(e) });
    try {
      fs.writeFileSync(path.join(root, "old.ts"), "old\n");
      fs.writeFileSync(path.join(root, "new.ts"), "new\n");
      await waitFor(() => calls.added.flat().some(f => f.path === "old.ts"), "initial add settles");
      fs.unlinkSync(path.join(root, "old.ts"));
      fs.writeFileSync(path.join(root, "newer.ts"), "newer\n");
      await waitFor(() => calls.reports.some(r => r.newlyIndexed.includes("newer.ts")), "second window reported");
      const report = calls.reports.find(r => r.newlyIndexed.includes("newer.ts"))!;
      expect(report.removed).toContain("old.ts");
    } finally {
      await watcher.stop();
    }
  });

  it("survives an indexing error and processes the next change", async () => {
    const root = makeWorkspace();
    const calls: FakeCalls = { added: [], removed: [], errors: [], reports: [] };
    calls.failNextAdd = new Error("simulated store failure");
    const watcher = new FileWatcher(fakeContext(calls), fakeConfig(root), 60);
    await watcher.start({ onReindex: r => calls.reports.push(r), onError: e => calls.errors.push(e) });
    try {
      fs.writeFileSync(path.join(root, "one.ts"), "one\n");
      await waitFor(() => calls.errors.length === 1, "error surfaces via onError");
      fs.writeFileSync(path.join(root, "two.ts"), "two\n");
      await waitFor(() => calls.added.flat().some(f => f.path === "two.ts"), "watcher still works after the error");
      expect(calls.errors).toHaveLength(1);
    } finally {
      await watcher.stop();
    }
  });

  it("queues a change that lands while a flush is running, then flushes it", async () => {
    const root = makeWorkspace();
    const calls: FakeCalls = { added: [], removed: [], errors: [], reports: [], gates: [] };
    const watcher = new FileWatcher(fakeContext(calls), fakeConfig(root), 60);
    await watcher.start({ onReindex: r => calls.reports.push(r), onError: e => calls.errors.push(e) });
    try {
      fs.writeFileSync(path.join(root, "slow.ts"), "slow\n");
      // Wait for flush #1 to be inside addFiles (gate held), then change again.
      await waitFor(() => calls.gates.length === 1, "first flush is inside addFiles");
      fs.writeFileSync(path.join(root, "late.ts"), "late\n");
      // Release flush #1; the change that landed mid-flush must get its own.
      calls.gates.shift()!();
      await waitFor(() => calls.gates.length === 1, "queued change gets its own flush");
      expect(calls.added.flat().map(f => f.path)).toContain("late.ts");
    } finally {
      for (const release of calls.gates ?? []) release();
      await watcher.stop();
    }
  });

  it("stop() cancels a pending flush: no indexing happens after stop", async () => {
    const root = makeWorkspace();
    const calls: FakeCalls = { added: [], removed: [], errors: [], reports: [] };
    const watcher = new FileWatcher(fakeContext(calls), fakeConfig(root), 80);
    await watcher.start();
    fs.writeFileSync(path.join(root, "never.ts"), "never\n");
    await watcher.stop();
    await new Promise(r => setTimeout(r, 300));
    expect(calls.added).toHaveLength(0);
    expect(calls.removed).toHaveLength(0);
  });
});
