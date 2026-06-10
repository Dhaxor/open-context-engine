import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import type { Database as BetterSqlite3Database, Statement } from "better-sqlite3";
import { Chunk, SearchResult, OpenContextState, SymbolKind, GitState } from "./types";
import type { GraphEdge, EdgeKind } from "./code-graph";
import { classifyNativeBindingError, type NativeBindingDiagnosis } from "./native-binding-error";

/**
 * Error thrown when the native SQLite binding fails to load or initialize.
 * Carries the structured diagnosis so callers (extension host, CLI) can show
 * the right user-facing message without re-parsing the raw error.
 */
export class NativeBindingError extends Error {
  readonly diagnosis: NativeBindingDiagnosis;
  constructor(diagnosis: NativeBindingDiagnosis) {
    super(diagnosis.title + " — " + diagnosis.message);
    this.name = "NativeBindingError";
    this.diagnosis = diagnosis;
  }
}

function nativeBindingError(err: unknown): NativeBindingError {
  if (err instanceof NativeBindingError) return err;
  return new NativeBindingError(classifyNativeBindingError(err));
}

/**
 * Dynamically import better-sqlite3 and surface any load failure (NMV
 * mismatch, missing module, glibc skew, etc.) as a structured NativeBindingError
 * instead of the raw require message that's been silently swallowed at startup.
 *
 * The return type is loose because better-sqlite3 uses CJS `export =` interop —
 * at runtime esModuleInterop hands us `mod.default`, but the declared types
 * treat the whole module as the constructor function. Callers immediately
 * `new Database(...)` so the looseness is contained.
 */
async function loadBetterSqlite3(): Promise<typeof import("better-sqlite3")> {
  try {
    const mod = await import("better-sqlite3");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((mod as any).default ?? mod) as typeof import("better-sqlite3");
  } catch (err) {
    throw nativeBindingError(err);
  }
}

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

const SCHEMA_VERSION = "2";

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
    const Database = await loadBetterSqlite3();
    this.maybeMigrateLegacy();
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("foreign_keys = ON");
      this.db.loadExtension(sqliteVecExtensionPath());
    } catch (err) {
      throw nativeBindingError(err);
    }
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
    const dimChanged = storedDim != null && Number(storedDim) !== this.expectedDim;
    const schemaChanged = storedSchema != null && storedSchema !== SCHEMA_VERSION;
    const needsReindex = dimChanged || schemaChanged;
    if (needsReindex) {
      // The vector/FTS layout or embedding space changed — drop the derived
      // indexes so they can be recreated with the new definition.
      this.db.exec(`
        DROP TABLE IF EXISTS chunks_vec;
        DROP TABLE IF EXISTS chunks_fts;
      `);
    }
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${this.expectedDim}] distance_metric=cosine)`);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path, symbol, content, tokenize='unicode61 remove_diacritics 0')`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        source_symbol TEXT,
        target_path TEXT NOT NULL,
        target_symbol TEXT,
        kind TEXT NOT NULL,
        confidence REAL DEFAULT 1.0
      );
      CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_path, source_symbol);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_path, target_symbol);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON graph_edges(kind);
    `);
    if (needsReindex) {
      // Source rows would otherwise survive with no matching vectors (and file
      // hashes would make an incremental index skip them), leaving a store that
      // returns nothing. Clear them so the next index run repopulates cleanly.
      const reason = dimChanged
        ? `Embedding dimension changed from ${Number(storedDim)} to ${this.expectedDim}`
        : `Store schema upgraded from v${storedSchema} to v${SCHEMA_VERSION}`;
      console.warn(`${reason}. Clearing existing index — a re-index is required.`);
      this.db.exec("DELETE FROM chunks; DELETE FROM files; DELETE FROM graph_edges;");
    }
    this.setMeta("schema_version", SCHEMA_VERSION);
    this.setMeta("embedding_dimension", String(this.expectedDim));
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

  /** Record the git branch/commit the index was last built against. */
  setIndexedGit(state: GitState | undefined): void {
    this.setMeta("git_branch", state?.branch ?? "");
    this.setMeta("git_commit", state?.commit ?? "");
  }

  /** The git state stored at the last index, or undefined if none was recorded. */
  getIndexedGit(): GitState | undefined {
    const branch = this.getMeta("git_branch");
    const commit = this.getMeta("git_commit");
    if (!branch && !commit) return undefined;
    return { available: true, branch: branch || undefined, commit: commit || undefined };
  }

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

  getChunkCountsByPath(): Map<string, number> {
    const rows = this.db.prepare("SELECT path, COUNT(*) AS n FROM chunks GROUP BY path").all() as { path: string; n: number }[];
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.path, r.n);
    return out;
  }

  getLastIndexedAt(): number | undefined {
    const row = this.db.prepare("SELECT MAX(last_indexed) AS ts FROM files").get() as { ts: number | null };
    return row.ts ?? undefined;
  }

  vectorSearch(queryVec: number[], topK: number, pathPrefix?: string): SearchResult[] {
    if (queryVec.length !== this.expectedDim) {
      throw new Error(`Query dim ${queryVec.length} != store dim ${this.expectedDim}`);
    }
    let rows: { rowid: number; distance: number }[];
    if (pathPrefix) {
      // sqlite-vec applies the KNN cut before the path filter, so asking for
      // exactly topK neighbors would yield far fewer after filtering. Over-fetch
      // neighbors (bounded by total chunk count) and keep the top matches in-path.
      const knnK = Math.min(this.getChunkCount() || topK, Math.max(topK * 10, 200));
      rows = this.db.prepare(
        `SELECT v.rowid, v.distance FROM chunks_vec v JOIN chunks c ON c.rowid = v.rowid
         WHERE v.embedding MATCH ? AND k = ? AND c.path LIKE ? ORDER BY v.distance LIMIT ?`,
      ).all(vectorToBlob(queryVec), knnK, pathPrefix + "%", topK) as { rowid: number; distance: number }[];
    } else {
      rows = this.db.prepare(
        "SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      ).all(vectorToBlob(queryVec), topK) as { rowid: number; distance: number }[];
    }
    const chunks = this.getChunksByRowIds(rows.map(r => r.rowid));
    return rows.map(r => ({ chunk: chunks.get(r.rowid)!, score: 1 / (1 + r.distance), vectorScore: r.distance }))
      .filter(r => r.chunk);
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
    const chunks = this.getChunksByRowIds(rows.map(r => r.rowid));
    return rows.map(r => ({ chunk: chunks.get(r.rowid)!, score: -r.score, bm25Score: r.score }))
      .filter(r => r.chunk);
  }

  // Hydrate many chunks in one round-trip instead of one query per rowid.
  private getChunksByRowIds(rowids: number[]): Map<number, Chunk> {
    const out = new Map<number, Chunk>();
    if (!rowids.length) return out;
    const CHUNK = 900; // stay under SQLite's bound-parameter limit
    for (let i = 0; i < rowids.length; i += CHUNK) {
      const slice = rowids.slice(i, i + CHUNK);
      const rows = this.db.prepare(`SELECT * FROM chunks WHERE rowid IN (${slice.map(() => "?").join(",")})`).all(...slice) as ChunkRow[];
      for (const r of rows) out.set(r.rowid, rowToChunk(r));
    }
    return out;
  }

  getChunkById(id: string): Chunk | null {
    const r = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as ChunkRow | undefined;
    return r ? rowToChunk(r) : null;
  }

  getChunksBySymbol(symbolName: string, limit = 5): Chunk[] {
    const rows = this.db.prepare("SELECT * FROM chunks WHERE symbol_name = ? LIMIT ?").all(symbolName, limit) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  getChunksByPath(pathName: string, limit = 5): Chunk[] {
    const rows = this.db.prepare("SELECT * FROM chunks WHERE path = ? ORDER BY start_line LIMIT ?").all(pathName, limit) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  getChunksReferencingIdentifier(identifier: string, pathFilter?: string, limit = 8): Chunk[] {
    // Use the FTS index instead of a full-table `contents LIKE '%x%'` scan. The
    // identifier is tokenized the same way the content was (unicode61), so an
    // exact-phrase match finds the same whole-word occurrences the regex below
    // already required; the regex is kept to enforce exact case + word bounds.
    const words = identifier.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    if (!words.length) return [];
    const match = `"${words.join(" ")}"`;
    const sql = pathFilter
      ? `SELECT c.* FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunks_fts MATCH ? AND c.path = ? LIMIT ?`
      : `SELECT c.* FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunks_fts MATCH ? LIMIT ?`;
    let rows: ChunkRow[];
    try {
      rows = (pathFilter
        ? this.db.prepare(sql).all(match, pathFilter, limit * 4)
        : this.db.prepare(sql).all(match, limit * 4)) as ChunkRow[];
    } catch {
      return [];
    }
    const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(identifier)}([^A-Za-z0-9_]|$)`);
    return rows.map(rowToChunk).filter(c => re.test(c.contents)).slice(0, limit);
  }

  getChunksByParentSymbol(parentSymbol: string, pathFilter?: string, limit = 5): Chunk[] {
    const rows = pathFilter
      ? this.db.prepare("SELECT * FROM chunks WHERE parent_symbol = ? AND path = ? ORDER BY start_line LIMIT ?").all(parentSymbol, pathFilter, limit) as ChunkRow[]
      : this.db.prepare("SELECT * FROM chunks WHERE parent_symbol = ? ORDER BY path, start_line LIMIT ?").all(parentSymbol, limit) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  getChunksNear(pathName: string, startLine: number, endLine: number, limit = 4): Chunk[] {
    const rows = this.db.prepare(`
      SELECT * FROM chunks
      WHERE path = ? AND NOT (start_line = ? AND end_line = ?)
      ORDER BY CASE WHEN end_line < ? THEN ? - end_line ELSE start_line - ? END ASC
      LIMIT ?
    `).all(pathName, startLine, endLine, startLine, startLine, endLine, limit) as ChunkRow[];
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

  addGraphEdges(edges: GraphEdge[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO graph_edges (source_path, source_symbol, target_path, target_symbol, kind, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((items: GraphEdge[]) => {
      for (const e of items) {
        stmt.run(e.sourcePath, e.sourceSymbol ?? null, e.targetPath, e.targetSymbol ?? null, e.kind, e.confidence);
      }
    });
    tx(edges);
  }

  removeGraphEdgesByPath(filePath: string): void {
    this.db.prepare("DELETE FROM graph_edges WHERE source_path = ? OR target_path = ?").run(filePath, filePath);
  }

  getGraphEdgesFrom(path: string, symbol?: string, kinds?: EdgeKind[]): GraphEdge[] {
    let sql = "SELECT * FROM graph_edges WHERE source_path = ?";
    const params: any[] = [path];
    if (symbol) { sql += " AND source_symbol = ?"; params.push(symbol); }
    if (kinds?.length) { sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`; params.push(...kinds); }
    sql += " LIMIT 50";
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToEdge);
  }

  getGraphEdgesTo(path: string | undefined, symbol?: string, kinds?: EdgeKind[]): GraphEdge[] {
    let sql = "SELECT * FROM graph_edges WHERE 1=1";
    const params: any[] = [];
    if (path) { sql += " AND target_path = ?"; params.push(path); }
    if (symbol) { sql += " AND target_symbol = ?"; params.push(symbol); }
    if (kinds?.length) { sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`; params.push(...kinds); }
    sql += " LIMIT 50";
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToEdge);
  }

  getGraphEdgeCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get() as { n: number };
    return row.n;
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

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function rowToEdge(r: any): GraphEdge {
  return {
    sourcePath: r.source_path,
    sourceSymbol: r.source_symbol ?? undefined,
    targetPath: r.target_path,
    targetSymbol: r.target_symbol ?? undefined,
    kind: r.kind,
    confidence: r.confidence,
  };
}

export function vectorToBlob(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}
