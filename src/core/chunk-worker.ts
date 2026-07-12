/**
 * Worker-thread entry for CPU-bound file processing: tree-sitter parse,
 * AST chunking, and graph-edge extraction. Spawned by ChunkWorkerPool from
 * the COMPILED dist tree (worker_threads can't run .ts) — keep this file free
 * of imports that drag in native modules or the embedding/sqlite layers.
 *
 * Protocol: parent sends { id, file }, worker answers
 * { id, ok: true, chunks, edges } or { id, ok: false, error }.
 * Everything crossing the boundary is plain structured-cloneable data.
 */
import { parentPort, workerData } from "worker_threads";
import { AstChunker } from "./ast-chunker";
import { CodeChunker } from "./chunker";
import { extractEdges } from "./graph-extractor";
import { File, Chunk } from "./types";
import { GraphEdge } from "./code-graph";

interface WorkerInit { maxChunkChars: number; chunkSize?: number; chunkOverlap?: number; }
interface WorkRequest { id: number; file: File; }
export interface WorkResponse { id: number; ok: boolean; chunks?: Chunk[]; edges?: GraphEdge[]; error?: string; }

const init = (workerData ?? {}) as WorkerInit;
const chunker = new AstChunker({
  maxChunkChars: init.maxChunkChars,
  fallback: new CodeChunker(init.chunkSize, init.chunkOverlap, init.maxChunkChars),
});

parentPort?.on("message", (msg: WorkRequest) => {
  void (async () => {
    try {
      const parsed = await chunker.parseFile(msg.file);
      try {
        const chunks = await chunker.chunkFile(msg.file, { parsed });
        const language = parsed?.language ?? AstChunker.languageFor(msg.file.path);
        let edges: GraphEdge[] = [];
        if (language) {
          try { edges = extractEdges(msg.file, language, parsed?.tree ?? null).edges; } catch {}
        }
        parentPort!.postMessage({ id: msg.id, ok: true, chunks, edges } satisfies WorkResponse);
      } finally {
        parsed?.dispose();
      }
    } catch (e: any) {
      parentPort!.postMessage({ id: msg.id, ok: false, error: String(e?.message ?? e) } satisfies WorkResponse);
    }
  })();
});
