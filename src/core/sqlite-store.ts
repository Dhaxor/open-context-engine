import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import type { Database as BetterSqlite3Database, Statement } from "better-sqlite3";
import { Chunk, ChunkMetadata, SearchResult, OpenContextState, FileIndexEntry, SymbolKind } from "./types";

const requireFromHere = createRequire(__filename);

function sqliteVecExtensionPath(): string {
  const { platform, arch } = process;
  const os = platform === "win32" ? "windows" : platform;
  const pkg = `sqlite-vec-${os}-${arch}`;
  const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
  try {
    return requireFromHere.resolve(`${pkg}/vec0.${suffix}`);
  } catch (err) {
    throw new Error(
      `Could not locate sqlite-vec native extension. Install ${pkg}, or use a platform supported by sqlite-vec. (${(err as Error).message})`,
    );
  }
}

export interface HybridSearchOptions {
  topK: number;
  candidateK: number;
  bm25Weight: number;
  vectorWeight: number;
  rrfK?: number;
  pathPrefix?: string;
}

interface ChunkRow {
  rowid: number;
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  hash: string;
  symbol_name: string | null;
  symbol_kind: string | null;
  parent_symbol: string | null;
  language: string | null;
  contents: string;
}

const SCHEMA_VERSION = "1";

export class SqliteStore {
  private db!: BetterSqlite3Database;
  private storeDir: string;
  private dbPath: string;
  private expectedDim: number;
  private insertChunkStmt!: Statement<any[]>;
  private insertVecStmt!: Statement<any[]>;
  private insertFtsStmt!: Statement<any[]>;
  private deleteByPathStmt!: Statement<any[]>;
  private deleteVecStmt!: Statement<any[]>;
  private deleteFtsStmt!: Statement<any[]>;
  private deleteFileStmt!: Statement<any[]>;
  private upsertFileStmt!: Statement<any[]>;

  constructor(storeDir: string, expectedDim: number) {
    this.storeDir = storeDir;
    this.expectedDim = expectedDim;
    this.dbPath = path.join(storeDir, "context.db");
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.storeDir, { recursive: true });
    const Database = (await import("better-sqlite3")).default;
    this.maybeMigrateLegacy();
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.loadExtension(sqliteVecExtensionPath());
    this.ensureSchema();
    this.prepareStatements();
  }

  private maybeMigrateLegacy(): void {
    const legacyFiles = ["store.json", "vectors.json", "state.json"];
    if (fs.existsSync(this.dbPath)) return;
    for (const name of legacyFiles) {
      const p = path.join(this.storeDir, name);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_indexed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        symbol_name TEXT,
        symbol_kind TEXT,
        parent_symbol TEXT,
        language TEXT,
        contents TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(symbol_name) WHERE symbol_name IS NOT NULL;
    `);
    const storedDim = this.getMeta("embedding_dimension");
    const storedSchema = this.getMeta("schema_version");
    if (storedSchema !== SCHEMA_VERSION || (storedDim && Number(storedDim) !== this.expectedDim)) {
      this.db.exec(`
        DROP TABLE IF EXISTS chunks_vec;
        DROP TABLE IF EXISTS chunks_fts;
      `);
    }
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${this.expectedDim}])`);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path, symbol, content, tokenize='unicode61 remove_diacritics 0')`);
    this.setMeta("schema_version", SCHEMA_VERSION);
    this.setMeta("embedding_dimension", String(this.expectedDim));
    if (storedDim && Number(storedDim) !== this.expectedDim) {
      this.db.exec("DELETE FROM chunks; DELETE FROM files;");
    }
  }

  private prepareStatements(): void {
    this.insertChunkStmt = this.db.prepare(`
      INSERT INTO chunks (id, path, start_line, end_line, hash, symbol_name, symbol_kind, parent_symbol, language, contents)
      VALUES (@id, @path, @start_line, @end_line, @hash, @symbol_name, @symbol_kind, @parent_symbol, @language, @contents)
    `);
    this.insertVecStmt = this.db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)");
    this.insertFtsStmt = this.db.prepare("INSERT INTO chunks_fts (rowid, path, symbol, content) VALUES (?, ?, ?, ?)");
    this.deleteByPathStmt = this.db.prepare("SELECT rowid FROM chunks WHERE path = ?");
    this.deleteVecStmt = this.db.prepare("DELETE FROM chunks_vec WHERE rowid = ?");
    this.deleteFtsStmt = this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
    this.deleteFileStmt = this.db.prepare("DELETE FROM files WHERE path = ?");
    this.upsertFileStmt = this.db.prepare(`
      INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, last_indexed = excluded.last_indexed
    `);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getExpectedDimension(): number { return this.expectedDim; }

  add(chunk: Chunk): void {
    if (!chunk.vector) throw new Error("Cannot add chunk without an embedding vector");
    if (chunk.vector.length !== this.expectedDim) {
      throw new Error(`Vector dimension mismatch: got ${chunk.vector.length}, store expects ${this.expectedDim}`);
    }
    const info = this.insertChunkStmt.run({
      id: chunk.id,
      path: chunk.path,
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      hash: chunk.id,
      symbol_name: chunk.symbolName ?? null,
      symbol_kind: chunk.symbolKind ?? null,
      parent_symbol: chunk.parentSymbol ?? null,
      language: chunk.language ?? null,
      contents: chunk.contents,
    });
    const rowid = BigInt(info.lastInsertRowid as number);
    this.insertVecStmt.run(rowid, vectorToBlob(chunk.vector));
    const symbolText = [chunk.symbolName, chunk.parentSymbol].filter(Boolean).join(" ");
    this.insertFtsStmt.run(rowid, chunk.path, symbolText, chunk.contents);
  }

  addBatch(chunks: Chunk[]): void {
    const tx = this.db.transaction((items: Chunk[]) => {
      for (const c of items) this.add(c);
    });
    tx(chunks);
  }

  removeByPath(filePath: string): number {
    const rows = this.deleteByPathStmt.all(filePath) as { rowid: number }[];
    if (!rows.length) return 0;
    const tx = this.db.transaction((items: { rowid: number }[]) => {
      for (const r of items) {
        this.deleteVecStmt.run(BigInt(r.rowid));
        this.deleteFtsStmt.run(BigInt(r.rowid));
      }
      this.db.prepare("DELETE FROM chunks WHERE path = ?").run(filePath);
      this.deleteFileStmt.run(filePath);
    });
    tx(rows);
    return rows.length;
  }

  upsertFile(filePath: string, hash: string): void {
    this.upsertFileStmt.run(filePath, hash, Date.now());
  }

  getFileHashes(): Map<string, string> {
    const rows = this.db.prepare("SELECT path, hash FROM files").all() as { path: string; hash: string }[];
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.path, r.hash);
    return out;
  }

  getIndexedPaths(): string[] {
    return (this.db.prepare("SELECT DISTINCT path FROM chunks ORDER BY path").all() as { path: string }[]).map(r => r.path);
  }

  getChunkCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    return row.n;
  }

  getFileCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number };
    return row.n;
  }

  vectorSearch(queryVec: number[], topK: number, pathPrefix?: string): SearchResult[] {
    if (queryVec.length !== this.expectedDim) {
      throw new Error(`Query dim ${queryVec.length} != store dim ${this.expectedDim}`);
    }
    const sql = pathPrefix
      ? `SELECT v.rowid, v.distance FROM chunks_vec v JOIN chunks c ON c.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ? AND c.path LIKE ? ORDER BY v.distance`
      : "SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance";
    const rows = pathPrefix
      ? (this.db.prepare(sql).all(vectorToBlob(queryVec), topK, pathPrefix + "%") as { rowid: number; distance: number }[])
      : (this.db.prepare(sql).all(vectorToBlob(queryVec), topK) as { rowid: number; distance: number }[]);
    return rows.map(r => {
      const chunk = this.getChunkByRowId(r.rowid)!;
      return { chunk, score: 1 / (1 + r.distance), vectorScore: r.distance };
    });
  }

  bm25Search(query: string, topK: number, pathPrefix?: string): SearchResult[] {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    const sql = pathPrefix
      ? `SELECT f.rowid, bm25(chunks_fts) AS score FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
         WHERE chunks_fts MATCH ? AND c.path LIKE ? ORDER BY score LIMIT ?`
      : "SELECT rowid, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?";
    let rows: { rowid: number; score: number }[];
    try {
      rows = pathPrefix
        ? (this.db.prepare(sql).all(ftsQuery, pathPrefix + "%", topK) as any)
        : (this.db.prepare(sql).all(ftsQuery, topK) as any);
    } catch {
      return [];
    }
    return rows.map(r => {
      const chunk = this.getChunkByRowId(r.rowid)!;
      return { chunk, score: -r.score, bm25Score: r.score };
    });
  }

  private getChunkByRowId(rowid: number): Chunk | null {
    const r = this.db.prepare("SELECT * FROM chunks WHERE rowid = ?").get(rowid) as ChunkRow | undefined;
    if (!r) return null;
    return rowToChunk(r);
  }

  getChunkById(id: string): Chunk | null {
    const r = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as ChunkRow | undefined;
    return r ? rowToChunk(r) : null;
  }

  getChunksBySymbol(symbolName: string, limit = 5): Chunk[] {
    const rows = this.db.prepare("SELECT * FROM chunks WHERE symbol_name = ? LIMIT ?").all(symbolName, limit) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  getState(wr: string, prov: string, mod: string): OpenContextState {
    const files = (this.db.prepare("SELECT path, hash, last_indexed FROM files").all() as { path: string; hash: string; last_indexed: number }[]).map(r => ({
      path: r.path,
      hash: r.hash,
      chunkIds: [] as string[],
      lastModified: r.last_indexed,
    }));
    return {
      version: 1,
      files,
      storePath: this.storeDir,
      workspaceRoot: wr,
      lastSynced: new Date().toISOString(),
      embeddingProvider: prov,
      embeddingModel: mod,
      embeddingDimension: this.expectedDim,
    };
  }

  close(): void {
    try { this.db?.close(); } catch {}
  }
}

function rowToChunk(r: ChunkRow): Chunk {
  return {
    id: r.id,
    path: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    contents: r.contents,
    symbolName: r.symbol_name ?? undefined,
    symbolKind: (r.symbol_kind as SymbolKind | null) ?? undefined,
    parentSymbol: r.parent_symbol ?? undefined,
    language: r.language ?? undefined,
  };
}

function sanitizeFtsQuery(q: string): string {
  const tokens = q.toLowerCase().match(/[a-z0-9_]{2,}/g);
  if (!tokens || !tokens.length) return "";
  const unique = [...new Set(tokens)].slice(0, 16);
  return unique.map(t => `"${t}"`).join(" OR ");
}

export function vectorToBlob(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}
