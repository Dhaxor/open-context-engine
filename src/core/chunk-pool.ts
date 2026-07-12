import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Worker } from "worker_threads";
import { File, Chunk } from "./types";
import { GraphEdge } from "./code-graph";

/**
 * Pool of worker threads for the CPU-bound half of indexing (tree-sitter
 * parse + AST chunk + graph extraction). Embedding stays on the main thread —
 * it's async network I/O and already concurrent.
 *
 * The workers run the COMPILED dist/core/chunk-worker.js. When that file
 * doesn't exist (ts-node, vitest, bundlers that inline), `isAvailable()` is
 * false and callers keep the in-process path — same results, one core.
 */

export interface ChunkedFile {
  path: string;
  chunks: Chunk[];
  edges: GraphEdge[];
}

export interface ChunkPoolOptions {
  maxChunkChars: number;
  chunkSize?: number;
  chunkOverlap?: number;
  /** Worker count. Default: min(4, cores - 2), at least 1. */
  size?: number;
}

interface Pending {
  resolve: (r: { chunks: Chunk[]; edges: GraphEdge[] }) => void;
  reject: (e: Error) => void;
}

export function defaultPoolSize(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 2));
}

export class ChunkWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private waiters: ((w: Worker) => void)[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private destroyed = false;

  static workerScriptPath(): string {
    const sibling = path.join(__dirname, "chunk-worker.js");
    try { if (fs.existsSync(sibling)) return sibling; } catch {}
    // Running from source (ts-node / vitest): use the compiled dist twin when
    // a build exists. Same code, just transpiled — workers can't execute .ts.
    const distTwin = path.join(__dirname.replace(/([\\/])src([\\/])/, "$1dist$2"), "chunk-worker.js");
    return distTwin;
  }

  /** True when a compiled worker script can be located. */
  static isAvailable(): boolean {
    try { return fs.existsSync(ChunkWorkerPool.workerScriptPath()); } catch { return false; }
  }

  constructor(opts: ChunkPoolOptions) {
    const size = Math.max(1, opts.size ?? defaultPoolSize());
    const script = ChunkWorkerPool.workerScriptPath();
    for (let i = 0; i < size; i++) {
      const w = new Worker(script, {
        workerData: { maxChunkChars: opts.maxChunkChars, chunkSize: opts.chunkSize, chunkOverlap: opts.chunkOverlap },
      });
      w.unref(); // never keep the process alive on our account
      w.on("message", (msg: { id: number; ok: boolean; chunks?: Chunk[]; edges?: GraphEdge[]; error?: string }) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        this.release(w);
        if (msg.ok) p.resolve({ chunks: msg.chunks ?? [], edges: msg.edges ?? [] });
        else p.reject(new Error(msg.error ?? "chunk worker failed"));
      });
      w.on("error", (err) => {
        // A crashed worker fails everything it owed and leaves the pool.
        for (const [id, p] of [...this.pending]) {
          this.pending.delete(id);
          p.reject(err instanceof Error ? err : new Error(String(err)));
        }
        this.workers = this.workers.filter(x => x !== w);
        this.idle = this.idle.filter(x => x !== w);
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number { return this.workers.length; }

  private acquire(): Promise<Worker> {
    const w = this.idle.pop();
    if (w) return Promise.resolve(w);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(w: Worker): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(w);
    else this.idle.push(w);
  }

  private processOne(file: File): Promise<{ chunks: Chunk[]; edges: GraphEdge[] }> {
    if (this.destroyed || !this.workers.length) return Promise.reject(new Error("chunk pool destroyed or empty"));
    return this.acquire().then((w) => new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, file });
    }));
  }

  /** Process a batch of files across the pool, preserving input order. */
  async run(files: File[]): Promise<ChunkedFile[]> {
    return Promise.all(files.map(async (file) => {
      const { chunks, edges } = await this.processOne(file);
      return { path: file.path, chunks, edges };
    }));
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    await Promise.allSettled(workers.map(w => w.terminate()));
  }
}
