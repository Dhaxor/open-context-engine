/**
 * Studio's transport: an EventSource that resumes rather than restarts.
 *
 * The token arrives in the URL fragment (`#token=…`) so it never reaches the
 * server as a query string a proxy or log could keep. It is read once, stashed
 * in memory, and stripped from the address bar immediately.
 *
 * Reconnect carries the cursor, so a laptop waking from sleep rejoins mid-turn
 * with nothing missing — the failure mode this whole protocol was shaped
 * around.
 */

import type { ApprovalDecision, ApprovalMode, TraceEnvelope } from "../protocol";

export interface TraceClientHandlers {
  onEvent: (envelope: TraceEnvelope) => void;
  onConnectionChange: (connected: boolean) => void;
  onError?: (message: string) => void;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8000;

export class TraceClient {
  private source: EventSource | null = null;
  private cursor = 0;
  private retryMs = RECONNECT_MIN_MS;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Null addresses the server's active session; an id pins this client to one. */
  private sessionId: string | null = null;

  constructor(private token: string, private handlers: TraceClientHandlers) {}

  /** Read the token from the fragment and remove it from the visible URL. */
  static tokenFromLocation(loc: { hash: string } = window.location): string {
    const match = /token=([^&]+)/.exec(loc.hash ?? "");
    if (!match) return "";
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {}
    return decodeURIComponent(match[1]);
  }

  connect(from = this.cursor): void {
    this.stopped = false;
    this.close();
    const params = new URLSearchParams({ token: this.token });
    if (from > 0) params.set("since", String(from));
    if (this.sessionId) params.set("session", this.sessionId);
    const source = new EventSource(`/api/events?${params.toString()}`);
    this.source = source;

    source.addEventListener("open", () => {
      this.retryMs = RECONNECT_MIN_MS;
      this.handlers.onConnectionChange(true);
    });

    source.addEventListener("trace", (ev) => {
      try {
        const envelope = JSON.parse((ev as MessageEvent).data) as TraceEnvelope;
        // Track the cursor here, not in the reducer: reconnect must resume from
        // what was RECEIVED even if the view chose to ignore something.
        if (envelope.seq > this.cursor) this.cursor = envelope.seq;
        this.handlers.onEvent(envelope);
      } catch {}
    });

    source.addEventListener("error", () => {
      this.handlers.onConnectionChange(false);
      source.close();
      if (this.stopped) return;
      // Backoff, but always resume from the cursor — never from zero, which
      // would replay the whole session into the transcript.
      this.timer = setTimeout(() => this.connect(this.cursor), this.retryMs);
      this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
    });
  }

  close(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.source?.close();
    this.source = null;
  }

  stop(): void {
    this.stopped = true;
    this.close();
  }

  getCursor(): number { return this.cursor; }

  // ─── commands ──────────────────────────────────────────────────────────────

  /**
   * Point this client at a different session.
   *
   * The cursor resets and the stream reconnects from zero — the new session has
   * its own sequence, and carrying the old cursor across would silently skip
   * everything it had already emitted.
   */
  switchTo(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.cursor = 0;
    this.connect(0);
  }

  getSessionId(): string | null { return this.sessionId; }

  async sessions(): Promise<{ sessions: any[]; parallel: boolean }> {
    const res = await fetch(`/api/sessions?token=${encodeURIComponent(this.token)}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.ok ? res.json() : { sessions: [], parallel: false };
  }

  createSession(title: string) { return this.post("/api/sessions", { action: "create", title }); }
  reviewSession(id: string) { return this.post("/api/sessions", { action: "review", id }); }
  landSession(id: string) { return this.post("/api/sessions", { action: "land", id }); }
  closeSession(id: string, discardChanges = false) {
    return this.post("/api/sessions", { action: "close", id, discardChanges });
  }

  private async post(route: string, body: unknown): Promise<any> {
    const res = await fetch(this.withSession(route), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = payload?.error ?? `Request failed (${res.status})`;
      this.handlers.onError?.(message);
      throw new Error(message);
    }
    return payload;
  }

  /** Registry routes address the server, not a session; everything else is
   *  scoped to the one this client is pinned to. */
  private withSession(route: string): string {
    if (!this.sessionId || route === "/api/sessions") return route;
    return `${route}?session=${encodeURIComponent(this.sessionId)}`;
  }

  /** Ranked indexed paths for the composer's `@` menu. Failures produce an
   *  empty menu rather than an error banner on every keystroke. */
  async files(query: string): Promise<string[]> {
    try {
      const params = new URLSearchParams({ q: query, token: this.token });
      if (this.sessionId) params.set("session", this.sessionId);
      const res = await fetch(`/api/files?${params.toString()}`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      return res.ok ? (await res.json()).files ?? [] : [];
    } catch {
      return [];
    }
  }

  prompt(text: string) { return this.post("/api/prompt", { text }); }
  shell(command: string) { return this.post("/api/shell", { command }); }
  mention(paths: string[]) { return this.post("/api/mention", { paths }); }
  interrupt() { return this.post("/api/interrupt", {}); }
  approve(id: string, decision: ApprovalDecision) { return this.post("/api/approve", { id, decision }); }
  setMode(mode: ApprovalMode) { return this.post("/api/mode", { mode }); }
  compact() { return this.post("/api/compact", {}); }
  reset() { return this.post("/api/reset", {}); }
  rewind(hash: string) { return this.post("/api/rewind", { hash }); }
  context(action: "pin" | "unpin" | "evict" | "restore", entryId: string) {
    return this.post("/api/context", { action, entryId });
  }
}
