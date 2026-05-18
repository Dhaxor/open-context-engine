import { SqliteStore } from "./sqlite-store";

export type EdgeKind = "imports" | "exports" | "calls" | "called_by" | "implements" | "extends" | "type_of" | "member_of";

export interface GraphEdge {
  sourcePath: string;
  sourceSymbol?: string;
  targetPath: string;
  targetSymbol?: string;
  kind: EdgeKind;
  confidence: number;
}

export class CodeGraph {
  private store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  addEdges(edges: GraphEdge[]): void {
    this.store.addGraphEdges(edges);
  }

  removeByPath(path: string): void {
    this.store.removeGraphEdgesByPath(path);
  }

  getOutgoing(path: string, symbol?: string, kinds?: EdgeKind[]): GraphEdge[] {
    return this.store.getGraphEdgesFrom(path, symbol, kinds);
  }

  getIncoming(path: string, symbol?: string, kinds?: EdgeKind[]): GraphEdge[] {
    return this.store.getGraphEdgesTo(path, symbol, kinds);
  }

  getRelated(path: string, symbol?: string, maxDepth = 2): GraphEdge[] {
    const seen = new Set<string>();
    const results: GraphEdge[] = [];
    const queue: { path: string; symbol?: string; depth: number }[] = [{ path, symbol, depth: 0 }];

    while (queue.length > 0) {
      const { path: p, symbol: s, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      const key = `${p}:${s ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const outgoing = this.getOutgoing(p, s);
      const incoming = this.getIncoming(p, s);
      const edges = [...outgoing, ...incoming];

      for (const edge of edges) {
        const edgeKey = `${edge.sourcePath}:${edge.sourceSymbol ?? ""}->${edge.targetPath}:${edge.targetSymbol ?? ""}:${edge.kind}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        results.push(edge);

        if (depth + 1 < maxDepth) {
          const nextPath = edge.sourcePath === p ? edge.targetPath : edge.sourcePath;
          const nextSymbol = edge.sourcePath === p ? edge.targetSymbol : edge.sourceSymbol;
          queue.push({ path: nextPath, symbol: nextSymbol, depth: depth + 1 });
        }
      }
    }

    return results;
  }

  getImportersOf(path: string): string[] {
    const edges = this.getIncoming(path, undefined, ["imports"]);
    return [...new Set(edges.map(e => e.sourcePath))];
  }

  getImportsOf(path: string): string[] {
    const edges = this.getOutgoing(path, undefined, ["imports"]);
    return [...new Set(edges.map(e => e.targetPath))];
  }

  getCallersOf(symbol: string): GraphEdge[] {
    return this.store.getGraphEdgesTo(undefined as any, symbol, ["calls", "called_by"]);
  }

  getImplementorsOf(symbol: string): GraphEdge[] {
    return this.store.getGraphEdgesTo(undefined as any, symbol, ["implements", "extends"]);
  }
}
