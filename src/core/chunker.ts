import { Chunk, File, DEFAULT_CHUNK_CONFIG } from "./types";
import { computeBlobName } from "./utils";

const BOUNDARY_PATTERNS = [
  /^(export\s+)?(default\s+)?(async\s+)?function\s+/,
  /^(export\s+)?(default\s+)?(abstract\s+)?(class|interface|type|enum)\s+/,
  /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(\(|async|function)/,
  /^def\s+/,
  /^class\s+/,
  /^async\s+def\s+/,
  /^(pub\s+)?(fn|struct|impl|trait|enum|mod)\s+/,
  /^(public|private|protected|internal)\s+(static\s+)?(abstract\s+)?(class|interface|enum|void|async|record|struct)\s+/,
  /^func\s+/,
  /^type\s+\w+\s+struct/,
  /^package\s+/,
  /^module\s+/,
];

export class CodeChunker {
  private chunkSize: number;
  private chunkOverlap: number;
  private maxChunkChars: number;

  constructor(
    chunkSize = DEFAULT_CHUNK_CONFIG.chunkSize,
    chunkOverlap = DEFAULT_CHUNK_CONFIG.chunkOverlap,
    maxChunkChars = 20000,
  ) {
    if (chunkOverlap >= chunkSize) throw new Error("chunkOverlap must be less than chunkSize");
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
    this.maxChunkChars = maxChunkChars;
  }

  chunkFile(file: File): Chunk[] {
    const lines = file.contents.split("\n");
    if (!lines.length || (lines.length === 1 && lines[0] === "")) return [];
    const spans = lines.length <= this.chunkSize
      ? [[1, lines.length] as [number, number]]
      : this.boundarySpans(lines);
    const chunks: Chunk[] = [];
    for (const [start, end] of spans) {
      const body = lines.slice(start - 1, end);
      if (!body.length) continue;
      for (const sub of this.splitByChars(body, start)) {
        chunks.push(this.mk(file, sub.lines, sub.start, sub.end));
      }
    }
    return chunks;
  }

  private boundarySpans(lines: string[]): [number, number][] {
    const bounds: number[] = [1];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      if (!BOUNDARY_PATTERNS.some(p => p.test(l))) continue;
      const lineNo = i + 1;
      if (lineNo - bounds[bounds.length - 1] >= 2) bounds.push(lineNo);
    }
    bounds.push(lines.length + 1);
    const spans: [number, number][] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const start = bounds[i];
      let end = bounds[i + 1] - 1;
      while (end - start + 1 > this.chunkSize && i + 2 < bounds.length) break;
      spans.push([start, end]);
    }
    return this.mergeSmallAndSplitLarge(spans);
  }

  private mergeSmallAndSplitLarge(spans: [number, number][]): [number, number][] {
    const merged: [number, number][] = [];
    for (const s of spans) {
      const size = s[1] - s[0] + 1;
      if (size > this.chunkSize) {
        for (let ls = s[0]; ls <= s[1]; ls += Math.max(1, this.chunkSize - this.chunkOverlap)) {
          const le = Math.min(ls + this.chunkSize - 1, s[1]);
          merged.push([ls, le]);
          if (le >= s[1]) break;
        }
        continue;
      }
      const last = merged[merged.length - 1];
      if (last && (last[1] - last[0] + 1) + size <= this.chunkSize) {
        last[1] = s[1];
      } else {
        merged.push([s[0], s[1]]);
      }
    }
    return merged;
  }

  private splitByChars(lines: string[], startLine: number): { lines: string[]; start: number; end: number }[] {
    const text = lines.join("\n");
    if (text.length <= this.maxChunkChars) return [{ lines, start: startLine, end: startLine + lines.length - 1 }];
    const out: { lines: string[]; start: number; end: number }[] = [];
    let offset = 0;
    while (offset < lines.length) {
      let end = offset;
      let len = 0;
      while (end < lines.length && len + lines[end].length + 1 <= this.maxChunkChars) {
        len += lines[end].length + 1;
        end++;
      }
      if (end === offset) end = offset + 1;
      out.push({
        lines: lines.slice(offset, end),
        start: startLine + offset,
        end: startLine + end - 1,
      });
      offset = end;
    }
    return out;
  }

  private mk(f: File, lines: string[], start: number, end: number): Chunk {
    const c = lines.join("\n");
    return {
      id: computeBlobName(`${f.path}:${start}-${end}`, c),
      path: f.path,
      startLine: start,
      endLine: end,
      contents: c,
    };
  }
}
