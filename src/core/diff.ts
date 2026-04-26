export interface UnifiedDiffOptions {
  contextLines?: number;
  fromLabel?: string;
  toLabel?: string;
}

type Op = "=" | "+" | "-";
interface LineOp { op: Op; text: string; }

export function unifiedDiff(oldText: string, newText: string, opts: UnifiedDiffOptions = {}): string {
  const contextLines = opts.contextLines ?? 3;
  const fromLabel = opts.fromLabel ?? "a";
  const toLabel = opts.toLabel ?? "b";
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  const ops = diffLines(oldLines, newLines);
  if (!ops.some(o => o.op !== "=")) return "";
  const hunks = buildHunks(ops, contextLines);
  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    for (const l of h.lines) out.push(l);
  }
  return out.join("\n") + "\n";
}

function diffLines(a: string[], b: string[]): LineOp[] {
  const n = a.length, m = b.length;
  if (n === 0) return b.map(t => ({ op: "+" as Op, text: t }));
  if (m === 0) return a.map(t => ({ op: "-" as Op, text: t }));
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: LineOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: "=", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: "-", text: a[i] }); i++; }
    else { out.push({ op: "+", text: b[j] }); j++; }
  }
  while (i < n) out.push({ op: "-", text: a[i++] });
  while (j < m) out.push({ op: "+", text: b[j++] });
  return out;
}

interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[]; }

function buildHunks(ops: LineOp[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLine = 1, newLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === "=") { oldLine++; newLine++; i++; continue; }
    const changeStart = i;
    let preContextStart = Math.max(0, changeStart);
    let preContextCount = 0;
    for (let k = changeStart - 1; k >= 0 && preContextCount < context && ops[k].op === "="; k--) {
      preContextStart = k; preContextCount++;
    }
    let endIdx = i;
    while (endIdx < ops.length) {
      if (ops[endIdx].op !== "=") { endIdx++; continue; }
      let run = 0, k = endIdx;
      while (k < ops.length && ops[k].op === "=" && run < context * 2) { run++; k++; }
      if (run >= context * 2 || k === ops.length) break;
      endIdx = k;
    }
    const postEnd = Math.min(ops.length, endIdx + context);
    const slice = ops.slice(preContextStart, postEnd);
    const preEq = changeStart - preContextStart;
    const hunkOldStart = oldLine - preEq;
    const hunkNewStart = newLine - preEq;
    let oldCount = 0, newCount = 0;
    const lines: string[] = [];
    for (const op of slice) {
      if (op.op === "=") { lines.push(" " + op.text); oldCount++; newCount++; }
      else if (op.op === "-") { lines.push("-" + op.text); oldCount++; }
      else { lines.push("+" + op.text); newCount++; }
    }
    hunks.push({
      oldStart: hunkOldStart === 0 && oldCount === 0 ? 0 : hunkOldStart,
      oldCount,
      newStart: hunkNewStart === 0 && newCount === 0 ? 0 : hunkNewStart,
      newCount,
      lines,
    });
    for (const op of slice) {
      if (op.op === "=") { oldLine++; newLine++; }
      else if (op.op === "-") oldLine++;
      else newLine++;
    }
    i = postEnd;
  }
  return hunks;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

export function replaceOnce(haystack: string, needle: string, replacement: string): { text: string; replaced: boolean; index: number } {
  if (!needle) return { text: haystack, replaced: false, index: -1 };
  const idx = haystack.indexOf(needle);
  if (idx < 0) return { text: haystack, replaced: false, index: -1 };
  return { text: haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length), replaced: true, index: idx };
}

export function replaceAll(haystack: string, needle: string, replacement: string): { text: string; count: number } {
  if (!needle) return { text: haystack, count: 0 };
  let count = 0, out = "", i = 0;
  while (i < haystack.length) {
    const idx = haystack.indexOf(needle, i);
    if (idx < 0) { out += haystack.slice(i); break; }
    out += haystack.slice(i, idx) + replacement;
    i = idx + needle.length;
    count++;
  }
  return { text: out, count };
}
