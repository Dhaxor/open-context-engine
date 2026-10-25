/**
 * Trace protocol — the one contract every harness surface binds to.
 *
 * A TraceSession emits `TraceEvent`s; the Studio (browser), the TUI (Ink), and
 * the desktop shell all render the same stream. Nothing renderer-specific lives
 * here: no colors, no widths, no ANSI. Types only, plus small pure helpers that
 * both ends need to agree on.
 *
 * Two things distinguish this from an ordinary agent event stream, and they are
 * the reason the harness exists:
 *
 *   1. `retrieval` carries the ranked evidence WITH its scores. Every other
 *      harness collapses a search into "searched the codebase"; the retriever
 *      already computes per-chunk vector/BM25/rerank/fused scores (see
 *      RetrievalDebugReport in core/retriever.ts) and we refuse to throw them
 *      away on the way to the UI.
 *   2. `context` describes what is actually occupying the model's window right
 *      now, bucketed and itemized, so the window is an object the user can
 *      inspect and edit rather than an invisible number.
 *
 * Events are wrapped in a `TraceEnvelope` with a monotonic `seq` so a client
 * that reconnects can replay from a cursor instead of losing the session.
 */

// Type-only, always: Studio bundles this module for the browser, so nothing
// here may pull a value (and therefore sqlite, fs, or the agent) into the
// browser graph. `import type` guarantees erasure under every bundler.
import type { EditProposal, RunStats, TokenUsage, ToolCall } from "../agent/types";
import type { PlanStep } from "../agent/plan";
import type { ApprovalDecision, ApprovalMode } from "../agent/permissions";

export type { EditProposal, RunStats, TokenUsage, ToolCall, PlanStep, ApprovalDecision, ApprovalMode };

// ─── retrieval evidence ──────────────────────────────────────────────────────

/** How a chunk earned its place in the context window. */
export type RetrievalVia =
  | "vector"    // dense similarity only
  | "bm25"      // keyword only
  | "hybrid"    // both lists agreed — the strongest signal
  | "rerank"    // promoted by the cross-encoder
  | "graph"     // pulled in by an import/call edge from a higher-ranked chunk
  | "expansion" // symbol expansion resolved a referenced definition
  | "manual";   // the user pinned it

/** Edge kinds the AST graph extracts, plus the direction they were traversed
 *  in. Kept faithful rather than collapsed — "called by" and "calls" mean very
 *  different things when you are deciding whether an edit is safe. */
export type GraphEdgeKind =
  | "calls" | "called-by"
  | "imports" | "imported-by"
  | "implements" | "extends" | "exports" | "type-of"
  | "defines";

/** An edge from the AST code graph, shown as provenance on a chunk. */
export interface GraphEdgeRef {
  kind: GraphEdgeKind;
  /** The symbol or path on the other end of the edge. */
  label: string;
  /** How many edges of this kind, when collapsed (e.g. "called by 3"). */
  count?: number;
}

/** One ranked piece of evidence. Scores are raw — the UI decides how to encode them. */
export interface RetrievedChunk {
  /** 1-based position in the final ranking. */
  rank: number;
  chunkId?: string;
  path: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  parentSymbol?: string;
  language?: string;
  /** Final fused score after boosts — what the ranking is sorted by. */
  score: number;
  vectorScore?: number;
  bm25Score?: number;
  rerankScore?: number;
  via: RetrievalVia;
  edges?: GraphEdgeRef[];
  /** First lines of the chunk, for hover/expand without a second round-trip. */
  preview: string;
  /** Estimated tokens this chunk costs in the window. */
  tokens: number;
}

/**
 * Per-stage timing. The retriever fires `onStage` as each pipeline stage lands
 * (bm25 → vector → fused → reranked), and BM25 returns before the query
 * embedding round-trip — so a UI can show first results in milliseconds rather
 * than spinning until the whole pipeline finishes.
 */
export interface RetrievalStage {
  stage: "bm25" | "vector" | "fused" | "reranked" | "expanded";
  ms: number;
  count: number;
}

export interface RetrievalTrace {
  id: string;
  query: string;
  /** The tool call this retrieval served, when it came from one. */
  toolCallId?: string;
  chunks: RetrievedChunk[];
  stages: RetrievalStage[];
  durationMs: number;
  /** "keyword-only" when sqlite-vec is unavailable — the UI must say so
   *  rather than silently presenting degraded ranking as normal. */
  searchMode: "hybrid" | "keyword-only";
  /** Query signals the retriever extracted (identifiers, symbols). */
  signals: string[];
  /** Chunks added by graph expansion beyond the raw ranking. */
  graphAdded: number;
  /** Chunks the packer dropped for budget, so "why isn't X here" is answerable. */
  droppedChunks: number;
  totalChars: number;
}

// ─── the context window as an object ─────────────────────────────────────────

export type ContextBucket = "retrieval" | "files" | "history" | "system" | "tools";

export const CONTEXT_BUCKETS: readonly ContextBucket[] = ["retrieval", "files", "history", "system", "tools"];

/** One addressable thing occupying the window. */
export interface ContextEntry {
  id: string;
  bucket: ContextBucket;
  /** File path, tool name, or a short description — what the row reads as. */
  label: string;
  /** "118-160" when the entry is a code range. */
  lines?: string;
  score?: number;
  via?: RetrievalVia;
  edges?: GraphEdgeRef[];
  tokens: number;
  /** Pinned entries survive compaction and re-retrieval. */
  pinned: boolean;
  /** Evicted entries are excluded from the next request but kept for undo. */
  evicted: boolean;
  /** Turn number this entered the window on. */
  turn: number;
}

export interface ContextSnapshot {
  /** The model's total context window, from contextWindowFor(model). */
  windowTokens: number;
  usedTokens: number;
  /** Token totals per bucket — the segmented budget meter reads this. */
  buckets: Record<ContextBucket, number>;
  entries: ContextEntry[];
}

export function emptyBuckets(): Record<ContextBucket, number> {
  return { retrieval: 0, files: 0, history: 0, system: 0, tools: 0 };
}

// ─── checkpoints (the spine) ─────────────────────────────────────────────────

/**
 * One link of the audit hash chain, surfaced as a navigable point in time.
 * The chain already exists and is tamper-evident (core/audit.ts); the harness
 * just makes it the primary navigation axis instead of a file tree.
 */
export interface Checkpoint {
  seq: number;
  hash: string;
  prev: string;
  /** First 4 chars of `hash` — what the spine renders. */
  short: string;
  ts: string;
  /** Short human label, usually the prompt that opened the turn. */
  label: string;
  turn: number;
  filesTouched: number;
  /** False when no file snapshot backs this point (nothing to restore to). */
  restorable: boolean;
}

// ─── approvals ───────────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  call: ToolCall;
  title: string;
  /** A unified diff for edits, the command line for shell. */
  preview: string;
  kind: "edit" | "create" | "remove" | "shell" | "other";
  /** Heuristic blast-radius score in [0,1] — see riskOf(). */
  risk: number;
  /** Indexed callers of the symbol being edited, when known. */
  callers?: number;
}

// ─── session ─────────────────────────────────────────────────────────────────

export interface SessionMeta {
  id: string;
  title: string;
  workspace: string;
  /** Branch/worktree this session runs in — parallel sessions each get one. */
  branch?: string;
  provider: string;
  model: string;
  mode: ApprovalMode;
  windowTokens: number;
  indexedChunks: number;
  searchMode: "hybrid" | "keyword-only";
  indexFresh: boolean;
  auditing: boolean;
  turn: number;
  startedAt: string;
}

export type RunPhase = "idle" | "thinking" | "retrieving" | "calling-tool" | "awaiting-approval" | "interrupted";

// ─── the event union ─────────────────────────────────────────────────────────

export type TraceEvent =
  /** Full session state — sent first on every (re)connect so a client can
   *  render without replaying history it does not have. */
  | { type: "session"; meta: SessionMeta }
  | { type: "turn_start"; turn: number; prompt: string }
  | { type: "phase"; phase: RunPhase; detail?: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; id: string; name: string; ok: boolean; ms?: number; chars: number; result?: string }
  | { type: "retrieval"; trace: RetrievalTrace }
  | { type: "context"; snapshot: ContextSnapshot }
  | { type: "checkpoint"; checkpoint: Checkpoint }
  | { type: "plan"; steps: PlanStep[] }
  | { type: "approval_request"; request: PendingApproval }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision }
  | { type: "edit"; edit: EditProposal }
  | { type: "model"; tier: { name: string; provider: string; model: string } }
  | { type: "usage"; usage: TokenUsage }
  | { type: "compacted"; dropped: number; summarized: boolean }
  | { type: "retry"; attempt: number; delayMs: number; reason: string }
  | { type: "rewound"; toHash: string; turnsDropped: number; filesRestored: number }
  | { type: "mode"; mode: ApprovalMode }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  /** A delegation opened. Events that follow carrying this id on the envelope
   *  belong to the child, not to the main thread. */
  | { type: "subagent_start"; id: string; task: string }
  | { type: "subagent_end"; id: string; ok: boolean; chars: number; ms: number }
  | { type: "turn_end"; turn: number; stats: RunStats };

export type TraceEventType = TraceEvent["type"];

/** Narrow a TraceEvent by its tag — saves a cast at every consumer. */
export function isEvent<T extends TraceEventType>(e: TraceEvent, type: T): e is Extract<TraceEvent, { type: T }> {
  return e.type === type;
}

/**
 * Transport wrapper. `seq` is monotonic per session and never reused, so a
 * reconnecting client sends `?since=<seq>` and gets exactly what it missed —
 * the fix for the class of bug where a dropped connection silently loses turns.
 */
export interface TraceEnvelope {
  seq: number;
  ts: string;
  sessionId: string;
  /**
   * Set when the event came from a sub-agent rather than the main thread.
   *
   * Carried on the envelope rather than duplicated onto every event variant:
   * nesting is a property of where an event came from, not of what it says, and
   * a renderer that ignores this field still shows a correct — merely flat —
   * transcript.
   */
  agentId?: string;
  event: TraceEvent;
}

// ─── commands (client → session) ─────────────────────────────────────────────

export type TraceCommand =
  | { type: "prompt"; text: string }
  | { type: "interrupt" }
  | { type: "approve"; id: string; decision: ApprovalDecision }
  | { type: "pin"; entryId: string }
  | { type: "unpin"; entryId: string }
  | { type: "evict"; entryId: string }
  | { type: "restore"; entryId: string }
  | { type: "rewind"; hash: string }
  | { type: "set_mode"; mode: ApprovalMode }
  | { type: "compact" }
  | { type: "reset" };

// ─── shared derivations ──────────────────────────────────────────────────────

/**
 * Blast-radius heuristic for a pending mutation, in [0,1]. Deliberately crude
 * and explainable — it orders approvals by how much they could break, it does
 * not pretend to be a safety guarantee. Kept here so the TUI and Studio show
 * the same number rather than each inventing one.
 */
export function riskOf(kind: PendingApproval["kind"], preview: string, callers = 0): number {
  const base = kind === "remove" ? 0.6 : kind === "shell" ? 0.5 : kind === "create" ? 0.15 : 0.25;
  const changed = preview.split("\n").filter(l => /^[+-][^+-]/.test(l)).length;
  const size = Math.min(0.25, changed / 200);
  const reach = Math.min(0.25, callers / 40);
  const destructive = /\brm\s+-rf|\bgit\s+(reset|clean)\s+--?\w*(hard|f)|\bDROP\s+TABLE|\bforce\b/i.test(preview) ? 0.2 : 0;
  return Math.min(1, Number((base + size + reach + destructive).toFixed(2)));
}

/** Classify a mutating tool call for approval display. */
export function approvalKind(toolName: string): PendingApproval["kind"] {
  switch (toolName) {
    case "str-replace": return "edit";
    case "create-file": return "create";
    case "remove-file": return "remove";
    case "run-command": return "shell";
    default: return "other";
  }
}

/** `path:start-end`, the citation format used everywhere in this product. */
export function chunkRef(c: Pick<RetrievedChunk, "path" | "startLine" | "endLine">): string {
  return `${c.path}:${c.startLine}-${c.endLine}`;
}
