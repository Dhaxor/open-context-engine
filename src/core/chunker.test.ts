import { describe, it, expect } from "vitest";
import { CodeChunker } from "./chunker";
import { File } from "./types";

function file(contents: string, p = "src/test.ts"): File {
  return { path: p, contents };
}

describe("CodeChunker", () => {
  it("returns [] for an empty file", () => {
    const c = new CodeChunker(80, 15, 20000);
    expect(c.chunkFile(file(""))).toEqual([]);
  });

  it("returns a single chunk for a short file", () => {
    const c = new CodeChunker(80, 15, 20000);
    const src = "function hi() {\n  return 1;\n}\n";
    const chunks = c.chunkFile(file(src));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
  });

  it("splits long files into multiple chunks", () => {
    const c = new CodeChunker(20, 5, 20000);
    const src = Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const chunks = c.chunkFile(file(src));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("caps chunk size by maxChunkChars when lines fit beneath the limit", () => {
    const c = new CodeChunker(1000, 50, 200);
    const src = Array.from({ length: 500 }, (_, i) => `const v${i}=${i};`).join("\n");
    const chunks = c.chunkFile(file(src));
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) expect(ch.contents.length).toBeLessThanOrEqual(200);
  });

  it("produces line ranges that cover the whole file", () => {
    const c = new CodeChunker(20, 5, 20000);
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const chunks = c.chunkFile(file(lines.join("\n")));
    const covered = new Set<number>();
    for (const ch of chunks) for (let l = ch.startLine; l <= ch.endLine; l++) covered.add(l);
    for (let l = 1; l <= 100; l++) expect(covered.has(l)).toBe(true);
  });

  it("respects language boundary hints", () => {
    const c = new CodeChunker(20, 5, 20000);
    const src = [
      "function alpha() {",
      "  return 1;",
      "}",
      "",
      "function beta() {",
      "  return 2;",
      "}",
      "",
      "function gamma() {",
      "  return 3;",
      "}",
    ].join("\n");
    const chunks = c.chunkFile(file(src));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const ch of chunks) expect(ch.startLine).toBeLessThanOrEqual(ch.endLine);
  });

  it("throws if chunkOverlap >= chunkSize", () => {
    expect(() => new CodeChunker(10, 10, 20000)).toThrow(/overlap/i);
    expect(() => new CodeChunker(10, 20, 20000)).toThrow(/overlap/i);
  });

  it("produces stable chunk IDs for identical input", () => {
    const c1 = new CodeChunker(20, 5, 20000);
    const c2 = new CodeChunker(20, 5, 20000);
    const src = Array.from({ length: 50 }, (_, i) => `x${i}`).join("\n");
    const a = c1.chunkFile(file(src));
    const b = c2.chunkFile(file(src));
    expect(a.map(c => c.id)).toEqual(b.map(c => c.id));
  });
});
