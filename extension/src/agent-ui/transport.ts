/**
 * The webview end of TraceBridge: a TraceTransport carried over postMessage.
 *
 * Studio (editor tab) and the sidebar both drive the agent through this, so the
 * same envelopes reach the same reducer whichever surface is looking.
 */

import type { ApprovalDecision, ApprovalMode, TraceEnvelope } from "../../../src/trace/protocol";
import type { ContextAction, TraceTransport, TraceTransportHandlers } from "../../../src/trace/studio/transport";
import type { HistoryRow, HostMessage, HostState, SearchHit, SessionRow, Surface, WebviewMessage } from "../trace/protocol";

interface VsCodeApi { postMessage(message: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi may be called exactly once per webview.
let api: VsCodeApi | null = null;
function vscode(): VsCodeApi {
  if (!api) api = acquireVsCodeApi();
  return api;
}

/** Pushes only the extension host can make. */
export interface HostHandlers {
  onState?: (state: HostState) => void;
  onSessions?: (sessions: SessionRow[], parallel: boolean) => void;
  onCompose?: (text: string, send: boolean) => void;
  /** The viewed session id after a host-side swap (null = following the active one). */
  onSessionChanged?: (sessionId: string | null) => void;
}

export class VsCodeTransport implements TraceTransport {
  private sessionId: string | null = null;
  private cursor = 0;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; quiet?: boolean }>();
  private readonly listener = (e: MessageEvent) => this.receive(e.data as HostMessage);

  constructor(
    private readonly surface: Surface,
    private readonly handlers: TraceTransportHandlers,
    private host: HostHandlers = {},
  ) {
    window.addEventListener("message", this.listener);
  }

  /** Late-bound host handlers: the React tree that owns them mounts after the transport. */
  setHostHandlers(host: HostHandlers): void { this.host = host; }

  private send(message: WebviewMessage): void { vscode().postMessage(message); }

  connect(): void {
    this.send({ kind: "ready", surface: this.surface });
    this.send({ kind: "subscribe", sessionId: this.sessionId, since: this.cursor });
  }

  stop(): void {
    window.removeEventListener("message", this.listener);
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
  }

  switchTo(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    // Each session numbers its own events; carrying the cursor across would
    // silently skip everything the new one had already emitted.
    this.cursor = 0;
    this.send({ kind: "subscribe", sessionId, since: 0 });
  }

  getSessionId(): string | null { return this.sessionId; }

  private receive(m: HostMessage): void {
    if (!m || typeof m !== "object" || !("kind" in m)) return;
    switch (m.kind) {
      case "trace":
        if (m.envelope.seq > this.cursor) this.cursor = m.envelope.seq;
        this.handlers.onEvent(m.envelope as TraceEnvelope);
        return;
      case "connection":
        this.handlers.onConnectionChange(m.connected);
        return;
      case "reset":
        this.sessionId = m.sessionId;
        this.cursor = 0;
        this.handlers.onReset?.();
        this.host.onSessionChanged?.(m.sessionId);
        return;
      case "rpc-result": {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else {
          if (!p.quiet) this.handlers.onError?.(m.error);
          p.reject(new Error(m.error));
        }
        return;
      }
      case "state": this.host.onState?.(m.state); return;
      case "sessions": this.host.onSessions?.(m.sessions, m.parallel); return;
      case "compose": this.host.onCompose?.(m.text, m.send); return;
    }
  }

  /** One host round trip. Failures also surface through `onError` as a notice. */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ kind: "rpc", id, method, params });
    });
  }

  // ─── TraceTransport ──────────────────────────────────────────────────────

  sessions() { return this.call<{ sessions: SessionRow[]; parallel: boolean }>("sessions"); }
  createSession(title: string) { return this.call<{ id: string; branch?: string; title: string }>("createSession", { title }); }
  reviewSession(id: string) { return this.call<any>("reviewSession", { id }); }
  landSession(id: string) { return this.call("landSession", { id }); }
  closeSession(id: string, discardChanges = false) { return this.call("closeSession", { id, discardChanges }); }
  /** Lookups happen per keystroke: a failure is an empty menu, not a notice. */
  files(query: string) { return this.quiet<string[]>("files", { query }, []); }
  prompt(text: string) { return this.call("prompt", { text }); }
  shell(command: string) { return this.call("shell", { command }); }
  mention(paths: string[]) { return this.call("mention", { paths }); }
  interrupt() { return this.call("interrupt"); }
  approve(id: string, decision: ApprovalDecision) { return this.call("approve", { id, decision }); }
  setMode(mode: ApprovalMode) { return this.call("setMode", { mode }); }
  compact() { return this.call("compact"); }
  reset() { return this.call("reset"); }
  rewind(hash: string) { return this.call("rewind", { hash }); }
  context(action: ContextAction, entryId: string) { return this.call("context", { action, entryId }); }

  // ─── the editor around the agent ─────────────────────────────────────────

  openFile(path: string, line = 0) { return this.call("openFile", { path, line }).catch(() => {}); }
  openEdit(id: string) { return this.call("openEdit", { id }).catch(() => {}); }
  openChanges(ids: string[], title: string) { return this.call("openChanges", { ids, title }).catch(() => {}); }
  undoEdit(id: string) { return this.call<{ status: "applied" | "undone" }>("undoEdit", { id }); }
  redoEdit(id: string) { return this.call<{ status: "applied" | "undone" }>("redoEdit", { id }); }
  confirm(message: string, confirmLabel?: string) { return this.quiet<boolean>("confirm", { message, confirmLabel }, false); }
  ask(message: string, placeholder?: string) { return this.quiet<string | null>("ask", { message, placeholder }, null); }
  pickFile() { return this.quiet<string | null>("pickFile", {}, null); }
  copy(text: string) { return this.call("copy", { text }).catch(() => {}); }
  history() { return this.quiet<HistoryRow[]>("history", {}, []); }
  resume(id: string) { return this.call("resume", { id }); }
  deleteHistory(id: string) { return this.call("deleteHistory", { id }); }
  search(query: string) { return this.call<SearchHit[]>("search", { query }); }
  command(name: "settings" | "index" | "studio" | "llmKey" | "health" | "folder") { return this.call("command", { name }).catch(() => {}); }

  private quiet<T>(method: string, params: Record<string, unknown>, fallback: T): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>(resolve => {
      this.pending.set(id, { resolve, reject: () => resolve(fallback), quiet: true });
      this.send({ kind: "rpc", id, method, params });
    });
  }
}
