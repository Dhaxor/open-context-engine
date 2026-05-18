import { SearchResult, Chunk } from "./types";
import { CodeGraph, GraphEdge, EdgeKind } from "./code-graph";
import { SqliteStore } from "./sqlite-store";

export interface GraphExpansionOptions {
  maxResults?: number;
  maxDepth?: number;
  decayPerHop?: number;
  kinds?: EdgeKind[];
}

const DEFAULTS: Required<GraphExpansionOptions> = {
  maxResults: 15,
  maxDepth: 2,
  decayPerHop: 0.55,
  kinds: ["imports", "exports", "calls", "called_by", "implements", "extends", "type_of"],
};

export class GraphExpander {
  constructor(
    private graph: CodeGraph,
    private store: SqliteStore,
  ) {}

  expand(results: SearchResult[], query: string, opts: GraphExpansionOptions = {}): { results: SearchResult[]; reasons: Map<string, string> } {
    const cfg = { ...DEFAULTS, ...opts };
    const seen = new Set(results.map(r => r.chunk.id));
    const reasons = new Map<string, string>();
    const extras: SearchResult[] = [];

    const topResults = results.slice(0, 5);

    for (const result of topResults) {
      if (extras.length >= cfg.maxResults) break;
      const chunk = result.chunk;

      // Get edges from this chunk's file+symbol
      const outgoing = this.graph.getOutgoing(chunk.path, chunk.symbolName, cfg.kinds);
      const incoming = this.graph.getIncoming(chunk.path, chunk.symbolName, cfg.kinds);

      // Process outgoing edges (what this code depends on)
      for (const edge of outgoing) {
        if (extras.length >= cfg.maxResults) break;
        const expanded = this.resolveEdge(edge, "outgoing", result.score, cfg.decayPerHop, seen, reasons);
        if (expanded) extras.push(expanded);
      }

      // Process incoming edges (what depends on this code)
      for (const edge of incoming) {
        if (extras.length >= cfg.maxResults) break;
        const expanded = this.resolveEdge(edge, "incoming", result.score, cfg.decayPerHop, seen, reasons);
        if (expanded) extras.push(expanded);
      }

      // Depth 2: follow edges from first-hop results
      if (cfg.maxDepth >= 2 && extras.length < cfg.maxResults) {
        for (const extra of [...extras].slice(0, 3)) {
          if (extras.length >= cfg.maxResults) break;
          const deepOutgoing = this.graph.getOutgoing(extra.chunk.path, extra.chunk.symbolName, cfg.kinds);
          for (const edge of deepOutgoing.slice(0, 3)) {
            if (extras.length >= cfg.maxResults) break;
            const expanded = this.resolveEdge(edge, "depth-2", extra.score, cfg.decayPerHop, seen, reasons);
            if (expanded) extras.push(expanded);
          }
        }
      }
    }

    return { results: [...results, ...extras], reasons };
  }

  private resolveEdge(
    edge: GraphEdge,
    direction: string,
    parentScore: number,
    decay: number,
    seen: Set<string>,
    reasons: Map<string, string>,
  ): SearchResult | null {
    const targetPath = direction === "incoming" ? edge.sourcePath : edge.targetPath;
    const targetSymbol = direction === "incoming" ? edge.sourceSymbol : edge.targetSymbol;

    // Try to find the chunk by symbol in that file
    let chunks: Chunk[] = [];
    if (targetSymbol) {
      chunks = this.store.getChunksBySymbol(targetSymbol, 2);
      chunks = chunks.filter(c => c.path === targetPath || !targetPath);
    }
    if (!chunks.length && targetPath) {
      chunks = this.store.getChunksByPath(targetPath, 2);
    }
    if (!chunks.length) return null;

    const chunk = chunks[0];
    if (seen.has(chunk.id)) return null;
    seen.add(chunk.id);

    const score = parentScore * decay * edge.confidence;
    const reason = formatReason(edge, direction);
    reasons.set(chunk.id, reason);

    return { chunk, score };
  }
}

function formatReason(edge: GraphEdge, direction: string): string {
  const verb = edge.kind === "imports" ? "imports" :
    edge.kind === "calls" ? "calls" :
    edge.kind === "called_by" ? "called by" :
    edge.kind === "implements" ? "implements" :
    edge.kind === "extends" ? "extends" :
    edge.kind === "exports" ? "exports" :
    edge.kind === "type_of" ? "type of" :
    edge.kind;

  if (direction === "incoming") {
    return `${edge.sourcePath}${edge.sourceSymbol ? `:${edge.sourceSymbol}` : ""} ${verb} this`;
  }
  return `${verb} ${edge.targetPath}${edge.targetSymbol ? `:${edge.targetSymbol}` : ""}`;
}
