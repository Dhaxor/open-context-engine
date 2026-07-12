import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Tamper-evident audit log.
 *
 * Append-only JSONL where every event carries a SHA-256 hash over its own
 * canonical fields plus the previous event's hash — a hash chain. Editing,
 * reordering, or deleting any line breaks verification from that point on,
 * which is what compliance reviewers ask for ("can a developer quietly
 * rewrite the log?" — no, not without detection).
 *
 * The logger is a plain local primitive with no license logic; surfaces that
 * enable it decide the gating (see cli/index.ts and the extension). Writes are
 * best-effort and synchronous: an audit failure must never take down indexing
 * or an agent run, so errors are swallowed and counted instead of thrown.
 */

export interface AuditEvent {
  /** Monotonic sequence number within this log file, starting at 1. */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Event type, e.g. "run-start", "tool-call", "edit", "search", "mcp". */
  type: string;
  /** Event payload. Values are truncated at write time to bound file growth. */
  data: Record<string, unknown>;
  /** Hash of the previous event ("" for the first event in the file). */
  prev: string;
  /** SHA-256 over seq/ts/type/data/prev — see hashEvent. */
  hash: string;
}

export interface AuditLoggerOptions {
  /** Directory the log lives in (created on demand), e.g. `<ws>/.open-context/audit`. */
  dir: string;
  /** Log file name. Default "audit.jsonl". */
  fileName?: string;
  /** Per-string truncation cap for data values. Default 2000 chars. */
  maxValueChars?: number;
}

export function hashEvent(e: Omit<AuditEvent, "hash">): string {
  const h = crypto.createHash("sha256");
  h.update(`${e.seq}\n${e.ts}\n${e.type}\n${JSON.stringify(e.data)}\n${e.prev}`);
  return h.digest("hex");
}

/** Read the last complete JSONL line of a file without loading the whole file. */
function readLastLine(file: string): string | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return null;
    fd = fs.openSync(file, "r");
    const span = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter(l => l.trim().length > 0);
    return lines.length ? lines[lines.length - 1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

export class AuditLogger {
  private file: string;
  private seq = 0;
  private prev = "";
  private failures = 0;
  private maxValueChars: number;

  constructor(opts: AuditLoggerOptions) {
    this.maxValueChars = opts.maxValueChars ?? 2000;
    this.file = path.join(opts.dir, opts.fileName ?? "audit.jsonl");
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      // Resume the chain from the existing tail so restarts keep one
      // continuous verifiable history instead of forking a new chain.
      const last = readLastLine(this.file);
      if (last) {
        const e = JSON.parse(last) as AuditEvent;
        if (typeof e.seq === "number" && typeof e.hash === "string") {
          this.seq = e.seq;
          this.prev = e.hash;
        }
      }
    } catch {
      this.failures++;
    }
  }

  getFilePath(): string { return this.file; }
  /** Number of events that could not be written (never throws instead). */
  getFailureCount(): number { return this.failures; }

  /** Append one event. Best-effort: returns the event, or null on write failure. */
  log(type: string, data: Record<string, unknown> = {}): AuditEvent | null {
    try {
      const body: Omit<AuditEvent, "hash"> = {
        seq: this.seq + 1,
        ts: new Date().toISOString(),
        type,
        data: this.truncate(data),
        prev: this.prev,
      };
      const event: AuditEvent = { ...body, hash: hashEvent(body) };
      fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
      this.seq = event.seq;
      this.prev = event.hash;
      return event;
    } catch {
      this.failures++;
      return null;
    }
  }

  private truncate(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string" && v.length > this.maxValueChars) {
        out[k] = v.slice(0, this.maxValueChars) + `…[+${v.length - this.maxValueChars} chars]`;
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }
}

export interface ReadAuditOptions {
  /** Only events of this type. */
  type?: string;
  /** Only events at/after this time. */
  since?: Date;
  /** Only events at/before this time. */
  until?: Date;
  /** Keep only the last N matching events. */
  limit?: number;
}

/** Read events from an audit log file (or the default file inside a directory). */
export function readAuditEvents(fileOrDir: string, opts: ReadAuditOptions = {}): AuditEvent[] {
  let file = fileOrDir;
  try {
    if (fs.statSync(fileOrDir).isDirectory()) file = path.join(fileOrDir, "audit.jsonl");
  } catch {}
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const events: AuditEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as AuditEvent;
      if (opts.type && e.type !== opts.type) continue;
      if (opts.since && new Date(e.ts) < opts.since) continue;
      if (opts.until && new Date(e.ts) > opts.until) continue;
      events.push(e);
    } catch {
      // Torn/corrupt line: skip here; verifyAuditChain reports gaps via seq.
    }
  }
  return opts.limit && events.length > opts.limit ? events.slice(events.length - opts.limit) : events;
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  /** Sequence number of the first bad event when !ok. */
  brokenAtSeq?: number;
  reason?: string;
}

/** Recompute the hash chain over events as read from disk (unfiltered!). */
export function verifyAuditChain(events: AuditEvent[]): AuditVerification {
  let prev = "";
  let lastSeq = 0;
  for (const e of events) {
    if (e.seq !== lastSeq + 1) {
      return { ok: false, checked: lastSeq, brokenAtSeq: e.seq, reason: `sequence gap: expected ${lastSeq + 1}, found ${e.seq} (an event was removed or reordered)` };
    }
    if (e.prev !== prev) {
      return { ok: false, checked: lastSeq, brokenAtSeq: e.seq, reason: "previous-hash mismatch (an earlier event was altered or removed)" };
    }
    const expected = hashEvent({ seq: e.seq, ts: e.ts, type: e.type, data: e.data, prev: e.prev });
    if (e.hash !== expected) {
      return { ok: false, checked: lastSeq, brokenAtSeq: e.seq, reason: "event hash mismatch (this event was altered)" };
    }
    prev = e.hash;
    lastSeq = e.seq;
  }
  return { ok: true, checked: lastSeq };
}

/** Default audit directory for a workspace. */
export function defaultAuditDir(workspaceRoot: string, storePath?: string): string {
  return path.join(storePath || path.join(workspaceRoot, ".open-context"), "audit");
}
