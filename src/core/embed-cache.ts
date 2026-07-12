import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { licenseConfigDir } from "./license";

/**
 * Persistent embedding cache, keyed by (model, dimension, sha256(content)).
 *
 * Why it exists: incremental indexing already skips unchanged FILES, but any
 * touched file re-embeds ALL of its chunks even when only one changed — and
 * branch switches / store rebuilds re-embed everything. Content-hash caching
 * makes those free, and because the cache lives at the user level, every
 * checkout of every repo on the machine shares it. Combined with team index
 * artifacts this is the "one embedding bill for the whole team" story.
 *
 * Vectors are stored as Float32 blobs (4 bytes/dim — half the space of JSON
 * at full retrieval precision). All failures are swallowed: a broken cache
 * must never break indexing, it just stops saving money.
 */

export interface EmbedCacheStats {
  hits: number;
  misses: number;
  writes: number;
}

export function defaultEmbedCachePath(): string {
  return process.env.OCE_EMBED_CACHE || path.join(licenseConfigDir(), "embed-cache.db");
}

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export class EmbedCache {
  private db: import("better-sqlite3").Database | null = null;
  private initFailed = false;
  private stats: EmbedCacheStats = { hits: 0, misses: 0, writes: 0 };

  constructor(private dbPath: string = defaultEmbedCachePath()) {}

  private async ensureDb(): Promise<import("better-sqlite3").Database | null> {
    if (this.db) return this.db;
    if (this.initFailed) return null;
    try {
      const { loadBetterSqlite3 } = await import("./sqlite-store");
      const Database = await loadBetterSqlite3();
      await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
      const db = new Database(this.dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        hash TEXT NOT NULL,
        vector BLOB NOT NULL,
        created INTEGER NOT NULL,
        PRIMARY KEY (model, dim, hash)
      )`);
      this.db = db;
      return db;
    } catch {
      this.initFailed = true;
      return null;
    }
  }

  /** Bulk lookup. Returns a map of content-hash → vector for every hit. */
  async get(model: string, dim: number, hashes: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const db = await this.ensureDb();
    if (!db || !hashes.length) return out;
    try {
      const stmt = db.prepare("SELECT vector FROM embeddings WHERE model = ? AND dim = ? AND hash = ?");
      for (const hash of hashes) {
        const row = stmt.get(model, dim, hash) as { vector: Buffer } | undefined;
        if (!row) continue;
        const floats = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
        if (floats.length === dim) out.set(hash, Array.from(floats));
      }
    } catch {}
    this.stats.hits += out.size;
    this.stats.misses += hashes.length - out.size;
    return out;
  }

  /** Bulk insert (upsert). Best-effort. */
  async put(model: string, dim: number, entries: { hash: string; vector: number[] }[]): Promise<void> {
    const db = await this.ensureDb();
    if (!db || !entries.length) return;
    try {
      const stmt = db.prepare(
        "INSERT INTO embeddings (model, dim, hash, vector, created) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(model, dim, hash) DO NOTHING",
      );
      const now = Date.now();
      const insertAll = db.transaction((rows: { hash: string; vector: number[] }[]) => {
        for (const r of rows) {
          stmt.run(model, dim, r.hash, Buffer.from(new Float32Array(r.vector).buffer), now);
        }
      });
      insertAll(entries);
      this.stats.writes += entries.length;
    } catch {}
  }

  getStats(): EmbedCacheStats { return { ...this.stats }; }
  getPath(): string { return this.dbPath; }

  close(): void {
    try { this.db?.close(); } catch {}
    this.db = null;
  }
}
