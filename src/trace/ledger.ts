/**
 * The context ledger — the model's window as an addressable object.
 *
 * Every harness shows a token counter. This tracks WHAT those tokens are: which
 * retrieved chunks, which file reads, what the conversation costs, and what the
 * system prompt and tool schemas take before anything useful is in there. That
 * turns "76% full" into "76% full, and 31k of it is one over-broad retrieval you
 * can drop".
 *
 * Pin and evict are real, not cosmetic:
 *
 *   evict  rewrites the tool result the chunk came from. Because the ledger
 *          retains the SearchResults behind each retrieval, the remaining
 *          chunks are re-rendered through the SAME formatSearchOutput the agent
 *          originally saw — no string surgery, no drift, and the model's next
 *          request genuinely no longer contains the evicted code.
 *   pin    re-injects the chunk through the system prompt, so it survives
 *          compaction instead of aging out of the middle of the history.
 *
 * Both are reversible: eviction never discards the source, so `restore` puts
 * the chunk back exactly.
 */

import { AgentMessage } from "../agent/types";
import { estimateTokens, messageTokens } from "../agent/utils";
import { SearchResult } from "../core/types";
import { formatSearchOutput } from "../core/search";
import {
  ContextBucket, ContextEntry, ContextSnapshot, GraphEdgeRef, RetrievalTrace, RetrievalVia, emptyBuckets,
} from "./protocol";

/** Retained per retrieval so eviction can re-render exactly what the agent saw. */
interface RetrievalRecord {
  toolCallId: string;
  query: string;
  results: SearchResult[];
  turn: number;
}

interface MutableEntry extends ContextEntry {
  /** The tool result this entry's tokens live inside. */
  toolCallId: string;
  /** Chunk id within that result, for retrieval entries. */
  chunkId?: string;
  /** Full text, kept for pinned re-injection. */
  contents?: string;
}

export interface ContextLedgerOptions {
  /** The model's context window — contextWindowFor(model). */
  windowTokens: number;
  /** Rendered system prompt, for the `system` bucket. */
  systemPrompt: () => string;
  /** Tool schemas as sent to the provider, for the `tools` bucket. */
  toolSchemas: () => unknown;
  /** Cap on retained retrievals; older records drop their contents (and with
   *  them the ability to evict per-chunk) to bound memory on long sessions. */
  maxRetainedRetrievals?: number;
  /** Char budget used when re-rendering a partially evicted retrieval. Must
   *  match what the agent's search used, or eviction would change unrelated
   *  truncation. */
  maxOutputLength?: number;
}

const DEFAULT_RETAINED = 24;

export class ContextLedger {
  private entries = new Map<string, MutableEntry>();
  private retrievals = new Map<string, RetrievalRecord>();
  private order: string[] = [];
  private turn = 0;
  /** Tool results that have ever been rewritten. They must keep being re-derived
   *  even after everything is restored, or an undone eviction would leave its
   *  "[… evicted]" note behind forever. */
  private touched = new Set<string>();

  constructor(private opts: ContextLedgerOptions) {}

  setTurn(turn: number): void { this.turn = turn; }
  getTurn(): number { return this.turn; }

  /** Record a retrieval and its chunks. `results` are retained so eviction can
   *  re-render; pass the report's finalResults. */
  noteRetrieval(trace: RetrievalTrace, results: SearchResult[]): void {
    const toolCallId = trace.toolCallId ?? trace.id;
    this.retrievals.set(toolCallId, { toolCallId, query: trace.query, results, turn: this.turn });
    this.order.push(toolCallId);
    this.evictOldestRetained();

    for (const c of trace.chunks) {
      const chunkId = c.chunkId ?? `${c.path}:${c.startLine}`;
      const id = `r:${toolCallId}:${chunkId}`;
      // A chunk retrieved again keeps its pin/evict state — re-retrieving
      // something the user threw out must not silently bring it back.
      const prior = this.entries.get(id);
      this.entries.set(id, {
        id,
        bucket: "retrieval",
        label: c.path,
        lines: `${c.startLine}-${c.endLine}`,
        score: c.score,
        via: c.via,
        ...(c.edges ? { edges: c.edges } : {}),
        tokens: c.tokens,
        pinned: prior?.pinned ?? false,
        evicted: prior?.evicted ?? false,
        turn: this.turn,
        toolCallId,
        chunkId,
        contents: results.find(r => r.chunk.id === chunkId)?.chunk.contents,
      });
    }
  }

  /** Record a read-file result. Files are evictable as a whole. */
  noteFileRead(toolCallId: string, path: string, contents: string): void {
    const id = `f:${toolCallId}`;
    const prior = this.entries.get(id);
    this.entries.set(id, {
      id,
      bucket: "files",
      label: path,
      tokens: estimateTokens(contents),
      pinned: prior?.pinned ?? false,
      evicted: prior?.evicted ?? false,
      turn: this.turn,
      toolCallId,
      contents,
    });
  }

  pin(id: string): boolean { return this.setFlags(id, { pinned: true, evicted: false }); }
  unpin(id: string): boolean { return this.setFlags(id, { pinned: false }); }
  evict(id: string): boolean { return this.setFlags(id, { evicted: true, pinned: false }); }
  restore(id: string): boolean { return this.setFlags(id, { evicted: false }); }

  private setFlags(id: string, flags: Partial<Pick<ContextEntry, "pinned" | "evicted">>): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.evicted || flags.evicted) this.touched.add(e.toolCallId);
    Object.assign(e, flags);
    return true;
  }

  getEntry(id: string): ContextEntry | undefined {
    const e = this.entries.get(id);
    return e && stripInternal(e);
  }

  /**
   * Current occupancy. `entries` lists only what is addressable — retrieved
   * chunks and file reads. System prompt, tool schemas, and conversation are
   * real costs but not things a user can act on, so they appear as bucket
   * totals in the meter rather than as rows you cannot do anything with.
   */
  snapshot(messages: readonly AgentMessage[]): ContextSnapshot {
    const buckets = emptyBuckets();
    buckets.system = estimateTokens(this.opts.systemPrompt());
    buckets.tools = estimateTokens(safeJson(this.opts.toolSchemas()));

    const entries: ContextEntry[] = [];
    for (const e of this.entries.values()) {
      entries.push(stripInternal(e));
      if (!e.evicted) buckets[e.bucket] += e.tokens;
    }

    // History is everything in the transcript we have NOT already attributed to
    // a tracked tool result — otherwise retrieval would be counted twice.
    const attributed = new Set<string>();
    for (const e of this.entries.values()) if (e.toolCallId) attributed.add(e.toolCallId);
    for (const m of messages) {
      if (m.role === "tool" && m.toolCallId && attributed.has(m.toolCallId)) continue;
      buckets.history += messageTokens(m);
    }

    entries.sort(byRankThenRecency);
    const usedTokens = (Object.keys(buckets) as ContextBucket[]).reduce((sum, k) => sum + buckets[k], 0);
    return { windowTokens: this.opts.windowTokens, usedTokens, buckets, entries };
  }

  /**
   * Apply evictions to the history the agent is about to send. Returns a new
   * array; the agent's own messages are never mutated in place, so a failed
   * rewrite can never corrupt the session.
   */
  rewrite(messages: readonly AgentMessage[]): AgentMessage[] {
    if (!this.touched.size) return [...messages];

    const evictedByCall = new Map<string, Set<string>>();
    const evictedFiles = new Set<string>();
    const fileContents = new Map<string, string>();
    for (const e of this.entries.values()) {
      if (e.bucket === "files") {
        if (e.evicted) evictedFiles.add(e.toolCallId);
        else if (e.contents !== undefined) fileContents.set(e.toolCallId, e.contents);
      } else if (e.evicted && e.bucket === "retrieval" && e.chunkId) {
        const set = evictedByCall.get(e.toolCallId) ?? new Set<string>();
        set.add(e.chunkId);
        evictedByCall.set(e.toolCallId, set);
      }
    }

    return messages.map(m => {
      // Every touched result is re-derived from source on each pass, so undoing
      // an eviction restores the original text rather than leaving a stale note.
      if (m.role !== "tool" || !m.toolCallId || !this.touched.has(m.toolCallId)) return m;
      if (evictedFiles.has(m.toolCallId)) {
        return { ...m, content: "[file contents evicted from context by the user]" };
      }
      const restoredFile = fileContents.get(m.toolCallId);
      if (restoredFile !== undefined) return { ...m, content: restoredFile };

      const record = this.retrievals.get(m.toolCallId);
      const dropped = evictedByCall.get(m.toolCallId);
      // Without the retained results we cannot re-render honestly, so the whole
      // result goes rather than silently leaving evicted code in the window.
      if (!record) {
        return dropped ? { ...m, content: "[retrieval results evicted from context by the user]" } : m;
      }
      const kept = dropped ? record.results.filter(r => !dropped.has(r.chunk.id)) : record.results;
      const note = dropped?.size
        ? `\n\n[${dropped.size} result${dropped.size === 1 ? "" : "s"} evicted from context by the user]`
        : "";
      if (!kept.length) return { ...m, content: `No results retained for this search.${note}` };
      return {
        ...m,
        content: formatSearchOutput(kept, { maxOutputLength: this.opts.maxOutputLength }) + note,
      };
    });
  }

  /**
   * Pinned context, rendered for the system prompt. Riding in the system prompt
   * (rather than the transcript) is what makes a pin durable: compaction evicts
   * the middle of the history, and a pin the user set must outlive that.
   */
  pinnedBlock(): string | null {
    const pinned = [...this.entries.values()].filter(e => e.pinned && e.contents);
    if (!pinned.length) return null;
    const sections = pinned.map(e => {
      const where = e.lines ? `${e.label}:${e.lines}` : e.label;
      return `### ${where}\n\`\`\`\n${e.contents}\n\`\`\``;
    });
    return `## Pinned context\nThe user pinned this code as always-relevant. Treat it as current.\n\n${sections.join("\n\n")}`;
  }

  /** Forget everything (a /reset). */
  clear(): void {
    this.entries.clear();
    this.retrievals.clear();
    this.touched.clear();
    this.order = [];
    this.turn = 0;
  }

  /** Drop retained contents for the oldest retrievals, keeping the entries (and
   *  so the accounting) but giving up exact per-chunk eviction on them. */
  private evictOldestRetained(): void {
    const max = this.opts.maxRetainedRetrievals ?? DEFAULT_RETAINED;
    while (this.order.length > max) {
      const oldest = this.order.shift();
      if (oldest) this.retrievals.delete(oldest);
    }
  }
}

function stripInternal(e: MutableEntry): ContextEntry {
  const { toolCallId: _t, chunkId: _c, contents: _co, ...rest } = e;
  return rest;
}

/** Highest-scoring evidence first; ties and non-scored rows by recency. */
function byRankThenRecency(a: ContextEntry, b: ContextEntry): number {
  if (a.turn !== b.turn) return b.turn - a.turn;
  const as = a.score ?? -1;
  const bs = b.score ?? -1;
  if (as !== bs) return bs - as;
  return a.label.localeCompare(b.label);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

export type { ContextEntry, ContextSnapshot, GraphEdgeRef, RetrievalVia };
