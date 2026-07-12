import { describe, it, expect } from "vitest";
import { ChunkWorkerPool, defaultPoolSize } from "./chunk-pool";
import { AstChunker } from "./ast-chunker";
import { CodeChunker } from "./chunker";
import { File } from "./types";

/** The pool runs the COMPILED worker (dist/core/chunk-worker.js). When the
 *  project hasn't been built the pool reports unavailable and indexing stays
 *  inline — that path is covered by every other indexing test. The tests
 *  below exercise the real workers whenever a build is present. */

const available = ChunkWorkerPool.isAvailable();

function sampleFiles(): File[] {
  return [
    { path: "src/a.ts", contents: "export function alpha() { return 1; }\nexport function beta() { return 2; }" },
    { path: "src/b.py", contents: "def gamma(x):\n    return x + 1\n\nclass Thing:\n    def method(self):\n        return 2\n" },
    { path: "src/c.rb", contents: "class Invoice\n  def total\n    42\n  end\nend\n" },
    { path: "notes.txt", contents: "not code, falls back to line chunking\n".repeat(5) },
  ];
}

describe("ChunkWorkerPool", () => {
  it("isAvailable() answers without throwing", () => {
    expect(typeof available).toBe("boolean");
  });

  it("defaultPoolSize is sane", () => {
    expect(defaultPoolSize()).toBeGreaterThanOrEqual(1);
    expect(defaultPoolSize()).toBeLessThanOrEqual(4);
  });

  it.runIf(available)("produces the same chunks as the inline path", async () => {
    const files = sampleFiles();
    const maxChunkChars = 20_000;

    const chunker = new AstChunker({ maxChunkChars, fallback: new CodeChunker(80, 15, maxChunkChars) });
    const inline: Record<string, string[]> = {};
    for (const f of files) {
      inline[f.path] = (await chunker.chunkFile(f)).map(c => `${c.symbolName ?? "?"}@${c.startLine}-${c.endLine}`);
    }
    chunker.dispose();

    const pool = new ChunkWorkerPool({ maxChunkChars, chunkSize: 80, chunkOverlap: 15, size: 2 });
    try {
      const pooled = await pool.run(files);
      expect(pooled.map(p => p.path)).toEqual(files.map(f => f.path)); // order preserved
      for (const p of pooled) {
        expect(p.chunks.map(c => `${c.symbolName ?? "?"}@${c.startLine}-${c.endLine}`)).toEqual(inline[p.path]);
      }
    } finally {
      await pool.destroy();
    }
  });

  it.runIf(available)("extracts graph edges in the workers too", async () => {
    const pool = new ChunkWorkerPool({ maxChunkChars: 20_000, size: 1 });
    try {
      const [res] = await pool.run([
        { path: "src/m.ts", contents: "import { helper } from './util';\nexport function go() { return helper(); }" },
      ]);
      expect(res.edges.some(e => e.kind === "imports" && e.targetPath === "src/util")).toBe(true);
    } finally {
      await pool.destroy();
    }
  });

  it.runIf(available)("rejects cleanly after destroy", async () => {
    const pool = new ChunkWorkerPool({ maxChunkChars: 20_000, size: 1 });
    await pool.destroy();
    await expect(pool.run(sampleFiles().slice(0, 1))).rejects.toThrow();
  });
});
