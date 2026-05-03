import { SearchResult } from "./types";

export interface PackingOptions {
  maxTotalChars?: number;
  maxFileChars?: number;
  maxChunksPerFile?: number;
  mergeLineGap?: number;
}

export interface PackingDecision {
  path: string;
  lines: string;
  action: "included" | "merged" | "dropped";
  reason: string;
  chars: number;
  score?: number;
}

export interface PackedContext {
  output: string;
  decisions: PackingDecision[];
  includedFiles: number;
  includedChunks: number;
  droppedChunks: number;
  totalChars: number;
}

interface Span {
  path: string;
  startLine: number;
  endLine: number;
  contents: string;
  score: number;
  symbols: Set<string>;
  sourceCount: number;
}

const DEFAULTS = { maxTotalChars: 24_000, maxFileChars: 8_000, maxChunksPerFile: 4, mergeLineGap: 8 };

export function packSearchResults(results: SearchResult[], opts: PackingOptions = {}): PackedContext {
  const cfg = { ...DEFAULTS, ...opts };
  const decisions: PackingDecision[] = [];
  if (!results.length) return { output: "No results found.", decisions, includedFiles: 0, includedChunks: 0, droppedChunks: 0, totalChars: 17 };

  const byPath = new Map<string, SearchResult[]>();
  for (const r of results) {
    const arr = byPath.get(r.chunk.path) ?? [];
    arr.push(r); byPath.set(r.chunk.path, arr);
  }
  const files = [...byPath.entries()].sort((a, b) => maxScore(b[1]) - maxScore(a[1]));
  const sections: string[] = [];
  let total = 0, includedChunks = 0, droppedChunks = 0;

  for (const [path, fileResults] of files) {
    const selected = fileResults
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.maxChunksPerFile)
      .sort((a, b) => a.chunk.startLine - b.chunk.startLine);
    for (const r of fileResults.slice(cfg.maxChunksPerFile)) {
      droppedChunks++;
      decisions.push(decision(r, "dropped", "per-file chunk budget"));
    }

    const spans = mergeSpans(selected, cfg.mergeLineGap, decisions);
    let fileBody = renderFile(path, spans, cfg.maxFileChars, decisions);
    if (!fileBody) continue;
    if (total + fileBody.length > cfg.maxTotalChars) {
      const remaining = cfg.maxTotalChars - total;
      if (remaining < 400) {
        droppedChunks += spans.reduce((n, s) => n + s.sourceCount, 0);
        for (const s of spans) decisions.push(spanDecision(s, "dropped", "total context budget"));
        continue;
      }
      fileBody = fileBody.slice(0, remaining - 28) + "\n... (file truncated)";
    }
    sections.push(fileBody);
    total += fileBody.length + 7;
    includedChunks += spans.reduce((n, s) => n + s.sourceCount, 0);
    if (total >= cfg.maxTotalChars) break;
  }

  const output = [
    `Relevant context (packed): ${sections.length} file${sections.length === 1 ? "" : "s"}, ${includedChunks} chunk${includedChunks === 1 ? "" : "s"}${droppedChunks ? `, ${droppedChunks} dropped by budget` : ""}.`,
    sections.join("\n\n---\n\n"),
  ].filter(Boolean).join("\n\n");
  return { output, decisions, includedFiles: sections.length, includedChunks, droppedChunks, totalChars: output.length };
}

function mergeSpans(results: SearchResult[], gap: number, decisions: PackingDecision[]): Span[] {
  const spans: Span[] = [];
  for (const r of results) {
    const c = r.chunk;
    const next: Span = {
      path: c.path, startLine: c.startLine, endLine: c.endLine, contents: c.contents, score: r.score,
      symbols: new Set([c.symbolName, c.parentSymbol].filter(Boolean) as string[]), sourceCount: 1,
    };
    const last = spans[spans.length - 1];
    if (last && next.startLine <= last.endLine + gap) {
      last.contents = joinContents(last, next);
      last.endLine = Math.max(last.endLine, next.endLine);
      last.score = Math.max(last.score, next.score);
      for (const s of next.symbols) last.symbols.add(s);
      last.sourceCount += 1;
      decisions.push(decision(r, "merged", `nearby range ${last.startLine}-${last.endLine}`));
    } else {
      spans.push(next);
      decisions.push(decision(r, "included", "selected by rank"));
    }
  }
  return spans;
}

function joinContents(a: Span, b: Span): string {
  const bLines = b.contents.split("\n");
  const overlap = Math.max(0, a.endLine - b.startLine + 1);
  const tail = bLines.slice(overlap);
  const gap = Math.max(0, b.startLine - a.endLine - 1);
  return [a.contents, gap ? `... (${gap} lines omitted)` : "", tail.join("\n")].filter(Boolean).join("\n");
}

function renderFile(path: string, spans: Span[], maxChars: number, decisions: PackingDecision[]): string {
  const parts = [`## ${path}`];
  const symbols = [...new Set(spans.flatMap(s => [...s.symbols]))].slice(0, 8);
  if (symbols.length) parts.push(`Symbols: ${symbols.join(", ")}`);
  let used = parts.join("\n").length;
  for (const s of spans) {
    const block = `\n\nLines ${s.startLine}-${s.endLine} (score ${s.score.toFixed(4)}):\n${numbered(s)}`;
    if (used + block.length > maxChars) {
      decisions.push(spanDecision(s, "dropped", "per-file character budget"));
      continue;
    }
    parts.push(block); used += block.length;
  }
  return parts.length > (symbols.length ? 2 : 1) ? parts.join("\n") : "";
}

function numbered(s: Span): string { return s.contents.split("\n").map((l, i) => `${String(s.startLine + i).padStart(5)} │ ${l}`).join("\n"); }
function maxScore(results: SearchResult[]): number { return Math.max(...results.map(r => r.score)); }
function decision(r: SearchResult, action: PackingDecision["action"], reason: string): PackingDecision { return { path: r.chunk.path, lines: `${r.chunk.startLine}-${r.chunk.endLine}`, action, reason, chars: r.chunk.contents.length, score: r.score }; }
function spanDecision(s: Span, action: PackingDecision["action"], reason: string): PackingDecision { return { path: s.path, lines: `${s.startLine}-${s.endLine}`, action, reason, chars: s.contents.length, score: s.score }; }
