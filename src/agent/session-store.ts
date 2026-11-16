import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { CheckpointRecord } from "../trace/checkpoints";

/**
 * Durable chat sessions on disk (`.open-context/sessions/*.json`) so the CLI
 * can `--continue` the last conversation or `--resume <id>` any older one —
 * table stakes for a daily-driver coding CLI.
 *
 * The payload is whatever ContextAgent.exportSession() produced; this store
 * only adds identity, titles, and listing. Writes are atomic (tmp+rename) so
 * a crash mid-save never corrupts a session.
 */

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
}

export interface SavedSession extends SessionMeta {
  /** ContextAgent.exportSession() payload. */
  session: string;
  /** The Trace timeline, when the conversation ran in a TraceSession. */
  trace?: SavedTrace;
}

/**
 * What a TraceSession needs beyond the messages to come back whole: its
 * checkpoints (each with the before/after contents of the files its turn
 * edited — what Rewind and per-edit undo work from) and where its in-memory
 * hash chain had got to. Kept in a sidecar file (`checkpoints/<id>.json`),
 * because list() parses every session file and this one holds whole files.
 */
export interface SavedTrace {
  checkpoints: CheckpointRecord[];
  chainPrev?: string;
}

export class SessionStore {
  constructor(private dir: string) {}

  private traceFile(id: string): string {
    return path.join(this.dir, "checkpoints", `${id}.json`);
  }

  static forWorkspace(workspaceRoot: string, storePath?: string): SessionStore {
    return new SessionStore(path.join(storePath || path.join(workspaceRoot, ".open-context"), "sessions"));
  }

  newId(): string {
    const t = new Date();
    const stamp = t.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    // Trace addresses sessions by this id (`?session=`), so the suffix comes
    // from the CSPRNG rather than Math.random.
    return `${stamp}-${randomBytes(3).toString("hex")}`;
  }

  /**
   * `updatedAt` defaults to now; an import of older conversations keeps theirs.
   * `trace` replaces the saved timeline (an empty one removes it); leaving it
   * out keeps whatever is there — callers without a timeline never erase one.
   */
  save(id: string, title: string, exportedSession: string, turns: number, updatedAt: string = new Date().toISOString(), trace?: SavedTrace): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const payload: SessionMeta & { session: string } = {
      id,
      title: title.slice(0, 80),
      updatedAt,
      turns,
      session: exportedSession,
    };
    writeAtomic(path.join(this.dir, `${id}.json`), JSON.stringify(payload));
    if (trace) {
      const file = this.traceFile(id);
      if (trace.checkpoints.length || trace.chainPrev) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(trace));
      } else {
        try { fs.unlinkSync(file); } catch {}
      }
    }
  }

  load(id: string): SavedSession | null {
    let saved: SavedSession;
    try {
      saved = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as SavedSession;
    } catch {
      return null;
    }
    // A missing or unreadable timeline costs Rewind, never the conversation.
    try {
      const trace = JSON.parse(fs.readFileSync(this.traceFile(id), "utf8")) as SavedTrace;
      if (trace && Array.isArray(trace.checkpoints)) saved.trace = trace;
    } catch {}
    return saved;
  }

  list(): SessionMeta[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter(f => f.endsWith(".json") && !f.endsWith(".tmp"));
    } catch {
      return [];
    }
    const out: SessionMeta[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        out.push({ id: parsed.id, title: parsed.title, updatedAt: parsed.updatedAt, turns: parsed.turns });
      } catch {}
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  latest(): SavedSession | null {
    const [head] = this.list();
    return head ? this.load(head.id) : null;
  }

  remove(id: string): boolean {
    try { fs.unlinkSync(this.traceFile(id)); } catch {}
    try { fs.unlinkSync(path.join(this.dir, `${id}.json`)); return true; } catch { return false; }
  }
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
