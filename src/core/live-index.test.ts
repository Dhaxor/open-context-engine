import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { liveIndex } from "./live-index";
import { OpenContext } from "./context";
import { OpenContextConfig, IndexingResult, File } from "./types";

const EMPTY_RESULT: IndexingResult = { newlyIndexed: [], alreadyIndexed: [], removed: [], duration: 0 };

interface FakeCalls {
  incremental: number;
  added: File[][];
  removed: string[][];
}

function fakeContext(calls: FakeCalls): OpenContext {
  return {
    incrementalIndex: async () => { calls.incremental++; return { ...EMPTY_RESULT }; },
    addFiles: async (files: File[]) => { calls.added.push(files); return { ...EMPTY_RESULT, newlyIndexed: files.map(f => f.path) }; },
    removeFromIndex: async (paths: string[]) => { calls.removed.push(paths); },
    getChunkCount: () => 0,
  } as unknown as OpenContext;
}

const tmpDirs: string[] = [];
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-live-"));
  tmpDirs.push(dir);
  return dir;
}
function config(root: string): OpenContextConfig {
  return { workspaceRoot: root, embedding: { provider: "voyage", model: "voyage-code-3", dimension: 1024, batchSize: 32 } };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

describe("liveIndex", () => {
  it("runs an incremental index and returns no watcher when watch is disabled", async () => {
    const calls: FakeCalls = { incremental: 0, added: [], removed: [] };
    const root = makeWorkspace();
    const { result, watcher } = await liveIndex(fakeContext(calls), config(root), { watch: false });
    expect(calls.incremental).toBe(1);
    expect(watcher).toBeNull();
    expect(result).toEqual(EMPTY_RESULT);
  });

  it("starts a watcher that re-indexes on file changes", async () => {
    const calls: FakeCalls = { incremental: 0, added: [], removed: [] };
    const root = makeWorkspace();
    const reindexed: IndexingResult[] = [];
    const { watcher } = await liveIndex(fakeContext(calls), config(root), {
      watch: true,
      debounceMs: 50,
      onReindex: (r) => reindexed.push(r),
    });
    expect(watcher).not.toBeNull();
    try {
      fs.writeFileSync(path.join(root, "hello.ts"), "export const hello = 1;\n");
      await waitFor(() => calls.added.length > 0, 5000);
      expect(calls.added.flat().map(f => f.path)).toContain("hello.ts");
      expect(reindexed.length).toBeGreaterThan(0);
    } finally {
      await watcher!.stop();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise(r => setTimeout(r, 25));
  }
}
