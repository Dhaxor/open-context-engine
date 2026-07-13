import * as fs from "fs";
import * as path from "path";

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
}

export class SessionStore {
  constructor(private dir: string) {}

  static forWorkspace(workspaceRoot: string, storePath?: string): SessionStore {
    return new SessionStore(path.join(storePath || path.join(workspaceRoot, ".open-context"), "sessions"));
  }

  newId(): string {
    const t = new Date();
    const stamp = t.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  }

  save(id: string, title: string, exportedSession: string, turns: number): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const payload: SavedSession = {
      id,
      title: title.slice(0, 80),
      updatedAt: new Date().toISOString(),
      turns,
      session: exportedSession,
    };
    const file = path.join(this.dir, `${id}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
  }

  load(id: string): SavedSession | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as SavedSession;
    } catch {
      return null;
    }
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
    try { fs.unlinkSync(path.join(this.dir, `${id}.json`)); return true; } catch { return false; }
  }
}
