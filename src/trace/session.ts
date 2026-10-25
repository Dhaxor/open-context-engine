/**
 * TraceSession — one conversation, rendered as one event stream.
 *
 * Everything a surface needs arrives here as `TraceEvent`s: the Studio, the
 * TUI, and the desktop shell are all just subscribers. That is the whole reason
 * three front ends are affordable — none of them talks to the agent, and none
 * of them can drift from the others, because there is one place that decides
 * what happened.
 *
 * Events carry a monotonic `seq` and are buffered, so a client that drops its
 * connection resubscribes with a cursor and receives exactly what it missed.
 * Losing your place because a socket blinked is one of the loudest complaints
 * about the harnesses this competes with; it is designed out rather than
 * patched later.
 *
 * The session owns nothing it can rebuild: the agent, plan, permissions,
 * ledger, and checkpoint store are all injected, which is what lets the tests
 * drive a stub agent with no API key.
 */

import { ContextAgent } from "../agent/agent";
import { AgentPlan } from "../agent/plan";
import { ApprovalDecision, ApprovalMode, ApprovalRequest, PermissionManager } from "../agent/permissions";
import { SessionStore } from "../agent/session-store";
import { AgentMessage, EditProposal, StreamEvent } from "../agent/types";
import { AuditLogger, hashEvent } from "../core/audit";
import { CheckpointStore } from "./checkpoints";
import { ContextLedger } from "./ledger";
import { extractMentions, rankPaths } from "./composer";
import { toRetrievalTrace } from "./retrieval";
import {
  Checkpoint, PendingApproval, RunPhase, SessionMeta, TraceEnvelope, TraceEvent,
  approvalKind, riskOf,
} from "./protocol";
import type { RetrievalObservation } from "../agent/agent";

export interface TraceSessionOptions {
  id: string;
  agent: ContextAgent;
  plan: AgentPlan;
  permissions: PermissionManager;
  ledger: ContextLedger;
  checkpoints: CheckpointStore;
  /** Static session facts; `turn`, `mode`, and `startedAt` are managed here. */
  meta: Omit<SessionMeta, "turn" | "startedAt" | "mode">;
  audit?: AuditLogger;
  sessionStore?: SessionStore;
  /** Envelopes retained for reconnect replay. Default 2000. */
  bufferSize?: number;
  /** Indexed-caller lookup, so an approval can say how far an edit reaches. */
  callersOf?: (path: string) => number;
  /** Indexed paths, for `@` autocomplete. */
  listFiles?: () => string[];
  /** Read a workspace file, for resolving an `@` mention. */
  readFile?: (path: string) => Promise<string | null>;
  /** Run a shell command for `!`. Absent when policy disallows shell. */
  runCommand?: (command: string, signal?: AbortSignal) => Promise<string>;
}

export type Unsubscribe = () => void;

const DEFAULT_BUFFER = 2000;

export class TraceSession {
  private buffer: TraceEnvelope[] = [];
  private seq = 0;
  private subscribers = new Set<(e: TraceEnvelope) => void>();
  private running: AbortController | null = null;
  private pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private retrievalCalls = new Map<string, string>();
  private toolStarts = new Map<string, number>();
  /** read-file results carry no path, so it is captured from the call args. */
  private readPaths = new Map<string, string>();
  private edits: EditProposal[] = [];
  private turn = 0;
  private title = "";
  private startedAt = new Date().toISOString();
  private phase: RunPhase = "idle";
  /** In-memory hash chain used when auditing is off, so the spine still works.
   *  Hashes are real content hashes; they are simply not persisted. */
  private localPrev = "";

  constructor(private opts: TraceSessionOptions) {
    this.opts.permissions.setAsk(req => this.requestApproval(req));
    this.opts.plan.onUpdate(steps => this.emit({ type: "plan", steps }));
  }

  // ─── subscription ──────────────────────────────────────────────────────────

  /**
   * Subscribe, optionally replaying from a cursor.
   *
   * With a cursor: everything after it, in order — a reconnect resumes exactly
   * where it left off.
   *
   * Without one: current session state followed by the WHOLE retained buffer.
   * A client opening onto a session that is already underway — a browser
   * attached to a running CLI, a second window, a resumed conversation — has to
   * see the history that exists, not an empty transcript with a live badge.
   */
  subscribe(fn: (e: TraceEnvelope) => void, since?: number): Unsubscribe {
    // Guarded exactly like emit(): a client that throws on its first render is
    // a broken UI, and it must not take the session down on attach.
    const deliver = (env: TraceEnvelope) => { try { fn(env); } catch {} };
    if (since !== undefined) {
      for (const env of this.buffer) if (env.seq > since) deliver(env);
    } else {
      // The synthetic snapshot is numbered 0 so it never advances the client's
      // cursor past buffered events it has not been given yet.
      deliver({ seq: 0, ts: new Date().toISOString(), sessionId: this.opts.id, event: { type: "session", meta: this.meta() } });
      for (const env of this.buffer) deliver(env);
    }
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Newest sequence number emitted so far. */
  cursor(): number { return this.seq; }

  /** Everything after a cursor, for clients that poll instead of streaming. */
  since(seq: number): TraceEnvelope[] {
    return this.buffer.filter(e => e.seq > seq);
  }

  meta(): SessionMeta {
    return {
      ...this.opts.meta,
      mode: this.opts.permissions.getMode(),
      turn: this.turn,
      startedAt: this.startedAt,
    };
  }

  getPhase(): RunPhase { return this.phase; }
  isRunning(): boolean { return this.running !== null; }
  checkpoints(): Checkpoint[] { return this.opts.checkpoints.list(); }

  private emit(event: TraceEvent, agentId?: string): TraceEnvelope {
    const env = this.envelope(event, agentId);
    this.buffer.push(env);
    const max = this.opts.bufferSize ?? DEFAULT_BUFFER;
    if (this.buffer.length > max) this.buffer.splice(0, this.buffer.length - max);
    // A throwing subscriber is a broken UI, not a broken run.
    for (const fn of this.subscribers) { try { fn(env); } catch {} }
    return env;
  }

  private envelope(event: TraceEvent, agentId?: string): TraceEnvelope {
    return {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      sessionId: this.opts.id,
      ...(agentId ? { agentId } : {}),
      event,
    };
  }

  private setPhase(phase: RunPhase, detail?: string): void {
    if (this.phase === phase && !detail) return;
    this.phase = phase;
    this.emit({ type: "phase", phase, ...(detail ? { detail } : {}) });
  }

  // ─── retrieval telemetry ───────────────────────────────────────────────────

  /**
   * Wired as `onRetrieval` when the tools are built. Correlates back to the
   * tool call by query text: the `tool_call` event is emitted before the
   * handler runs, so the mapping is already in place by the time this fires.
   */
  readonly observeRetrieval = (o: RetrievalObservation): void => {
    const toolCallId = this.retrievalCalls.get(o.query);
    const trace = toRetrievalTrace({
      id: toolCallId ?? `ret-${this.seq}`,
      report: o.report,
      durationMs: o.durationMs,
      searchMode: this.opts.meta.searchMode,
      stages: o.stages,
      ...(toolCallId ? { toolCallId } : {}),
    });
    this.opts.ledger.noteRetrieval(trace, o.report.finalResults);
    this.emit({ type: "retrieval", trace });
    this.emitContext();
  };

  private emitContext(): void {
    this.emit({ type: "context", snapshot: this.opts.ledger.snapshot(this.opts.agent.getMessages()) });
  }

  // ─── sub-agents ────────────────────────────────────────────────────────────

  /**
   * Wired into the delegate tool when the tools are built.
   *
   * A sub-agent's intermediate output never reaches the parent's context — that
   * is the point of delegating — but it is republished here, tagged with the
   * delegation's id, so the user can watch work that would otherwise be a
   * multi-minute silence. The child's activity deliberately does NOT touch the
   * ledger or the checkpoint store: it is not in the main thread's window, and
   * claiming otherwise would make the context meter lie.
   */
  readonly delegateObserver = {
    start: (id: string, task: string): void => {
      this.emit({ type: "subagent_start", id, task });
      this.setPhase("calling-tool", `delegate · ${task.slice(0, 60)}`);
    },
    event: (id: string, ev: StreamEvent): void => {
      switch (ev.type) {
        case "text":
          if (ev.text) this.emit({ type: "text", text: ev.text }, id);
          break;
        case "tool_call":
          this.emit({ type: "tool_call", call: ev.toolCall! }, id);
          break;
        case "tool_result": {
          const r = ev.toolResult!;
          this.emit({ type: "tool_result", id: r.id, name: r.name, ok: !r.error, chars: r.result.length }, id);
          break;
        }
        case "run_end":
          if (ev.stats) this.emit({ type: "usage", usage: ev.stats.usage }, id);
          break;
      }
    },
    end: (id: string, result: { ok: boolean; chars: number; ms: number }): void => {
      this.emit({ type: "subagent_end", id, ...result });
      this.setPhase("thinking");
    },
  };

  // ─── running a turn ────────────────────────────────────────────────────────

  async prompt(text: string): Promise<void> {
    if (this.running) throw new Error("A turn is already running — interrupt it first.");
    const query = text.trim();
    if (!query) return;

    this.turn++;
    if (!this.title) this.title = query;
    this.opts.ledger.setTurn(this.turn);

    // Mentions resolve BEFORE the turn starts, so the files are already pinned
    // in the window the model is about to be given rather than arriving a turn
    // late. The `@path` text stays in the prompt: the model needs to know which
    // file the sentence is about, not just that one was attached.
    const mentions = extractMentions(query);
    if (mentions.length) await this.mention(mentions);
    this.running = new AbortController();
    this.emit({ type: "turn_start", turn: this.turn, prompt: query });
    this.setPhase("thinking");

    try {
      await this.opts.agent.run(query, {
        signal: this.running.signal,
        onStream: ev => this.onAgentEvent(ev),
      });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (/abort/i.test(message)) {
        this.setPhase("interrupted");
        this.emit({ type: "notice", level: "warn", message: "Run interrupted." });
      } else {
        this.emit({ type: "notice", level: "error", message });
      }
    } finally {
      this.running = null;
      this.closeTurn(query);
      this.setPhase("idle");
    }
  }

  private onAgentEvent(ev: StreamEvent): void {
    switch (ev.type) {
      case "text":
        if (ev.text) this.emit({ type: "text", text: ev.text });
        break;
      case "tool_call": {
        const call = ev.toolCall!;
        if (call.name === "codebase-retrieval") {
          const q = String(call.arguments?.information_request ?? "");
          if (q) this.retrievalCalls.set(q, call.id);
          this.setPhase("retrieving", q);
        } else {
          if (call.name === "read-file" && call.arguments?.path) {
            this.readPaths.set(call.id, String(call.arguments.path));
          }
          this.setPhase("calling-tool", call.name);
        }
        this.toolStarts.set(call.id, Date.now());
        this.emit({ type: "tool_call", call });
        break;
      }
      case "tool_result": {
        const r = ev.toolResult!;
        const started = this.toolStarts.get(r.id);
        this.toolStarts.delete(r.id);
        if (r.name === "read-file" && !r.error) {
          this.opts.ledger.noteFileRead(r.id, this.readPaths.get(r.id) ?? "(file)", r.result);
          this.readPaths.delete(r.id);
          this.emitContext();
        }
        this.emit({
          type: "tool_result",
          id: r.id,
          name: r.name,
          ok: !r.error,
          ...(started !== undefined ? { ms: Date.now() - started } : {}),
          chars: r.result.length,
        });
        this.setPhase("thinking");
        break;
      }
      case "edit_proposed":
        if (ev.edit) {
          this.edits.push(ev.edit);
          this.opts.checkpoints.noteEdit(ev.edit);
          this.emit({ type: "edit", edit: ev.edit });
        }
        break;
      case "model_selected":
        if (ev.tier) this.emit({ type: "model", tier: ev.tier });
        break;
      case "usage":
        if (ev.usage) this.emit({ type: "usage", usage: ev.usage });
        break;
      case "history_compacted":
        this.emit({ type: "compacted", dropped: ev.droppedMessages ?? 0, summarized: !!ev.summarized });
        this.emitContext();
        break;
      case "retry":
        this.emit({
          type: "retry",
          attempt: ev.retryAttempt ?? 0,
          delayMs: ev.retryDelayMs ?? 0,
          reason: ev.retryReason ?? "",
        });
        break;
      case "run_end":
        if (ev.stats) this.emit({ type: "turn_end", turn: this.turn, stats: ev.stats });
        break;
      case "error":
        if (ev.error) this.emit({ type: "notice", level: "error", message: ev.error });
        break;
    }
  }

  /** Close the turn: checkpoint it on the audit chain, then publish state. */
  private closeTurn(query: string): void {
    const link = this.appendToChain("turn-end", { turn: this.turn, prompt: query, edits: this.edits.length });
    const { edits: _edits, ...checkpoint } = this.opts.checkpoints.commit({
      seq: link.seq,
      hash: link.hash,
      prev: link.prev,
      label: query,
      turn: this.turn,
      ts: link.ts,
    });
    this.edits = [];
    this.emit({ type: "checkpoint", checkpoint });
    this.emitContext();
    this.persist();
  }

  /**
   * Extend the hash chain. With auditing on this is the real tamper-evident
   * log; with it off the chain is computed identically but kept in memory, so
   * the timeline works either way — and `meta.auditing` tells the UI which it
   * is rather than implying a guarantee that is not there.
   */
  private appendToChain(type: string, data: Record<string, unknown>): { seq: number; hash: string; prev: string; ts: string } {
    if (this.opts.audit) {
      const event = this.opts.audit.log(type, data);
      if (event) return { seq: event.seq, hash: event.hash, prev: event.prev, ts: event.ts };
    }
    const body = { seq: this.turn, ts: new Date().toISOString(), type, data, prev: this.localPrev };
    const hash = hashEvent(body);
    this.localPrev = hash;
    return { seq: body.seq, hash, prev: body.prev, ts: body.ts };
  }

  private persist(): void {
    if (!this.opts.sessionStore) return;
    try {
      this.opts.sessionStore.save(this.opts.id, this.title || "untitled", this.opts.agent.exportSession(), this.turn);
    } catch {}
  }

  // ─── mentions and direct shell ─────────────────────────────────────────────

  /** Indexed paths ranked against a query, for the composer's `@` menu. */
  files(query: string, limit = 12): string[] {
    return rankPaths(this.opts.listFiles?.() ?? [], query, limit);
  }

  /**
   * Pull `@`-mentioned files into the window, pinned.
   *
   * A mention is an instruction — "this file is relevant" — so it goes in
   * pinned: it rides in the system prompt and survives compaction, rather than
   * ageing out of the middle of the history the way a retrieved chunk does.
   * Retrieval decides what MIGHT matter; a mention is the user saying what does.
   */
  async mention(paths: string[]): Promise<{ pinned: string[]; missing: string[] }> {
    const pinned: string[] = [];
    const missing: string[] = [];
    for (const path of paths) {
      const contents = this.opts.readFile ? await this.opts.readFile(path) : null;
      if (contents === null) { missing.push(path); continue; }
      const id = `mention:${path}`;
      this.opts.ledger.noteFileRead(id, path, contents);
      const entry = this.opts.ledger.snapshot(this.opts.agent.getMessages()).entries.find(e => e.label === path);
      if (entry) this.opts.ledger.pin(entry.id);
      pinned.push(path);
    }
    if (missing.length) {
      this.emit({
        type: "notice",
        level: "warn",
        message: `Not in the index: ${missing.join(", ")}`,
      });
    }
    if (pinned.length) this.emitContext();
    return { pinned, missing };
  }

  /**
   * Run a shell command the user typed, outside the model loop.
   *
   * It still goes through the permission manager: `!rm -rf` typed by hand is no
   * safer than the same command proposed by the agent, and the approval UI
   * already exists. The call and its result are emitted as ordinary tool events
   * so the transcript shows what was run — otherwise the model's next turn
   * would inherit a workspace that changed for reasons the record cannot explain.
   */
  async runShell(command: string): Promise<void> {
    const run = this.opts.runCommand;
    if (!run) {
      this.emit({ type: "notice", level: "error", message: "Shell commands are disabled by policy." });
      return;
    }
    const call = { id: `sh-${this.seq + 1}`, name: "run-command", arguments: { command } };
    const decision = await this.opts.permissions.check(call);
    if (decision.behavior === "deny") {
      this.emit({ type: "notice", level: "warn", message: `Not run: ${decision.reason}` });
      return;
    }

    this.emit({ type: "tool_call", call });
    this.setPhase("calling-tool", command.slice(0, 60));
    const started = Date.now();
    try {
      const result = await run(command);
      this.emit({
        type: "tool_result",
        id: call.id, name: call.name, ok: true,
        ms: Date.now() - started, chars: result.length, result,
      });
    } catch (err: any) {
      const message = String(err?.message ?? err);
      this.emit({
        type: "tool_result",
        id: call.id, name: call.name, ok: false,
        ms: Date.now() - started, chars: message.length, result: message,
      });
    } finally {
      this.setPhase("idle");
    }
  }

  // ─── commands ──────────────────────────────────────────────────────────────

  interrupt(): boolean {
    if (!this.running) return false;
    this.running.abort();
    return true;
  }

  private requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = `ap-${this.seq + 1}`;
    const kind = approvalKind(req.call.name);
    const path = String(req.call.arguments?.path ?? "");
    const callers = path && this.opts.callersOf ? this.opts.callersOf(path) : undefined;
    const request: PendingApproval = {
      id,
      call: req.call,
      title: req.title,
      preview: req.preview,
      kind,
      risk: riskOf(kind, req.preview, callers),
      ...(callers !== undefined ? { callers } : {}),
    };
    this.setPhase("awaiting-approval", req.title);
    this.emit({ type: "approval_request", request });
    return new Promise<ApprovalDecision>(resolve => {
      this.pendingApprovals.set(id, decision => {
        this.emit({ type: "approval_resolved", id, decision });
        this.setPhase("thinking");
        resolve(decision);
      });
    });
  }

  /** Resolve a pending approval. Returns false if it is unknown or already answered. */
  approve(id: string, decision: ApprovalDecision): boolean {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return false;
    this.pendingApprovals.delete(id);
    resolve(decision);
    return true;
  }

  pendingApproval(): string[] { return [...this.pendingApprovals.keys()]; }

  pin(entryId: string): boolean { return this.applyLedger(() => this.opts.ledger.pin(entryId)); }
  unpin(entryId: string): boolean { return this.applyLedger(() => this.opts.ledger.unpin(entryId)); }
  evict(entryId: string): boolean { return this.applyLedger(() => this.opts.ledger.evict(entryId)); }
  restore(entryId: string): boolean { return this.applyLedger(() => this.opts.ledger.restore(entryId)); }

  /**
   * Ledger edits rewrite the agent's history, so the next request genuinely
   * reflects what the user did. Rewriting mid-run would race the agent, so it
   * is deferred to the next turn instead.
   */
  private applyLedger(mutate: () => boolean): boolean {
    if (!mutate()) return false;
    if (!this.running) {
      this.opts.agent.loadMessages(this.opts.ledger.rewrite(this.opts.agent.getMessages()));
    }
    this.emitContext();
    return true;
  }

  setMode(mode: ApprovalMode): void {
    this.opts.permissions.setMode(mode);
    this.emit({ type: "mode", mode });
  }

  async compact(): Promise<void> {
    const result = await this.opts.agent.compact();
    this.emit({ type: "compacted", dropped: result.dropped, summarized: result.summarized });
    this.emitContext();
  }

  reset(): void {
    this.opts.agent.reset();
    this.opts.plan.clear();
    this.opts.ledger.clear();
    this.opts.checkpoints.clear();
    this.edits = [];
    this.turn = 0;
    this.title = "";
    this.emit({ type: "notice", level: "info", message: "Conversation cleared." });
    this.emitContext();
  }

  /**
   * Rewind to a checkpoint: undo the file changes made since, drop the turns
   * that produced them from the conversation, and report anything left alone
   * because the user had edited it themselves.
   */
  async rewind(hash: string): Promise<void> {
    if (this.running) throw new Error("Interrupt the running turn before rewinding.");
    const result = await this.opts.checkpoints.rewindTo(hash);

    this.opts.agent.loadMessages(truncateToTurn(this.opts.agent.getMessages(), result.turn));
    this.turn = result.turn;
    this.opts.ledger.setTurn(result.turn);

    this.emit({
      type: "rewound",
      toHash: hash,
      turnsDropped: result.checkpointsDropped,
      filesRestored: result.filesRestored.length,
    });
    for (const skipped of result.filesSkipped) {
      this.emit({
        type: "notice",
        level: "warn",
        message: `Left ${skipped.path} alone — ${skipped.reason}.`,
      });
    }
    this.emit({ type: "session", meta: this.meta() });
    this.emitContext();
    this.persist();
  }
}

/**
 * Drop everything after the Nth user turn. Turn boundaries are user messages,
 * so this keeps whole exchanges rather than cutting a tool call from its result
 * and leaving the provider with a dangling reference.
 */
export function truncateToTurn(messages: readonly AgentMessage[], turn: number): AgentMessage[] {
  if (turn <= 0) return [];
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue;
    seen++;
    if (seen > turn) return messages.slice(0, i);
  }
  return [...messages];
}
