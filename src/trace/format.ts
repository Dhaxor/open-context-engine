/**
 * Small pure formatters shared by the components.
 *
 * Separated from the JSX so the fiddly parts — diff classification, token
 * abbreviation, stage sparklines — are unit-testable without rendering
 * anything. These are exactly the details that look fine until a 12,000-token
 * count renders as "12000" next to one that says "1.2k".
 */

import { BUCKET_COLORS, SCORE_RAMP, scoreColor } from "./tokens";
import type { ContextBucket, ContextSnapshot, GraphEdgeRef, RetrievalStage, RetrievedChunk } from "./protocol";

export { scoreColor, SCORE_RAMP, BUCKET_COLORS };

/** Compact token counts. Everything on screen uses one rule, so columns line up. */
export function tokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  // Round BEFORE choosing the format, or a value that rounds up across a
  // boundary renders in the wrong one — 9,950 would read "10.0k" while 10,000
  // reads "10k", two widths for neighbouring numbers in the same column.
  const k = Math.round(n / 100) / 10;
  if (k < 10) return `${k.toFixed(1)}k`;
  if (k < 1000) return `${Math.round(k)}k`;
  const m = Math.round(n / 100_000) / 10;
  return `${m.toFixed(1)}m`;
}

/** Two decimals, always — a score column that changes width reads as noise. */
export function score(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export type DiffLineKind = "add" | "rem" | "hunk" | "ctx" | "meta";

/** Classify one unified-diff line. `+++`/`---` are headers, not content —
 *  colouring them as additions and removals is the classic tell of a
 *  hand-rolled diff view. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "rem";
  return "ctx";
}

export interface DiffLine { kind: DiffLineKind; text: string; }

export function parseDiff(diff: string, maxLines = 400): DiffLine[] {
  const lines = diff.split("\n");
  const kept = lines.slice(0, maxLines).map(text => ({ kind: diffLineKind(text), text }));
  if (lines.length > maxLines) {
    kept.push({ kind: "meta", text: `… ${lines.length - maxLines} more lines` });
  }
  return kept;
}

/** Additions and removals only — the number a reviewer actually wants. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    const kind = diffLineKind(line);
    if (kind === "add") added++;
    else if (kind === "rem") removed++;
  }
  return { added, removed };
}

/** Bar heights for the stage sparkline, newest stage shortest. */
export function stageBars(stages: RetrievalStage[], max = 6): number[] {
  if (!stages.length) return [];
  const counts = stages.slice(-max).map(s => s.count);
  const peak = Math.max(...counts, 1);
  return counts.map(c => Math.max(2, Math.round((c / peak) * 11)));
}

/** The one-line summary that replaces a spinner. */
export function retrievalSummary(chunks: RetrievedChunk[], graphAdded: number, ms: number): string {
  const top = chunks.length ? Math.max(...chunks.map(c => c.score)) : 0;
  const parts = [`retrieved ${chunks.length}`];
  if (chunks.length) parts.push(`top ${score(top)}`);
  if (graphAdded > 0) parts.push(`graph +${graphAdded}`);
  parts.push(duration(ms));
  return parts.filter(Boolean).join(" · ");
}

/** "called by search.ts" — reads as prose, not as a data structure. */
export function edgeLabel(edge: GraphEdgeRef): string {
  const verb = {
    calls: "calls",
    "called-by": "called by",
    imports: "imports",
    "imported-by": "imported by",
    implements: "implements",
    extends: "extends",
    exports: "exports",
    "type-of": "type of",
    defines: "defines",
  }[edge.kind];
  const target = edge.label.split("/").pop() ?? edge.label;
  return `← ${verb} ${target}${edge.count && edge.count > 1 ? ` +${edge.count - 1}` : ""}`;
}

export interface BudgetSegment { bucket: ContextBucket; tokens: number; percent: number; color: string; }

/**
 * Segments for the meter, largest first. Percentages are of USED tokens, not of
 * the window — the meter's job is to show the composition of what is in there;
 * the fill against the window is a separate number in the label.
 */
export function budgetSegments(snapshot: ContextSnapshot | null): BudgetSegment[] {
  if (!snapshot || !snapshot.usedTokens) return [];
  return (Object.keys(snapshot.buckets) as ContextBucket[])
    .map(bucket => ({
      bucket,
      tokens: snapshot.buckets[bucket],
      percent: (snapshot.buckets[bucket] / snapshot.usedTokens) * 100,
      color: BUCKET_COLORS[bucket],
    }))
    .filter(s => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

/** Risk needs a colour with meaning, not a gradient: green, amber, red. */
export function riskColor(risk: number): string {
  if (risk >= 0.6) return "var(--del)";
  if (risk >= 0.35) return "var(--warn)";
  return "var(--ok)";
}

/** `src/core/retriever.ts` → `retriever.ts` for tight columns, keeping the
 *  full path available as a title. */
export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Plain-text ellipsis. The terminal has its own ANSI-aware version. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
