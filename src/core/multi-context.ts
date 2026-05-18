import { OpenContext } from "./context";
import { OpenContextConfig, SearchResult, IndexingResult } from "./types";
import { RetrieveOptions } from "./retriever";
import { reciprocalRankFusion } from "./retriever";

export interface WorkspaceEntry {
  id: string;
  root: string;
  context: OpenContext;
}

export interface MultiSearchOptions extends RetrieveOptions {
  workspaceIds?: string[];
}

export class MultiContext {
  private workspaces = new Map<string, WorkspaceEntry>();

  async addWorkspace(id: string, config: OpenContextConfig): Promise<void> {
    const context = await OpenContext.create(config);
    this.workspaces.set(id, { id, root: config.workspaceRoot, context });
  }

  removeWorkspace(id: string): void {
    const entry = this.workspaces.get(id);
    if (entry) {
      entry.context.close();
      this.workspaces.delete(id);
    }
  }

  getWorkspace(id: string): OpenContext | null {
    return this.workspaces.get(id)?.context ?? null;
  }

  getWorkspaceIds(): string[] {
    return [...this.workspaces.keys()];
  }

  async search(query: string, opts: MultiSearchOptions = {}): Promise<SearchResult[]> {
    const targets = opts.workspaceIds
      ? [...this.workspaces.values()].filter(w => opts.workspaceIds!.includes(w.id))
      : [...this.workspaces.values()];

    if (!targets.length) return [];
    if (targets.length === 1) return targets[0].context.searchRaw(query, opts.topK, opts);

    const resultsPerWorkspace = await Promise.all(
      targets.map(async (w) => {
        const results = await w.context.searchRaw(query, undefined, opts);
        return results.map(r => ({
          ...r,
          chunk: { ...r.chunk, path: `[${w.id}] ${r.chunk.path}` },
        }));
      }),
    );

    const rankedLists = resultsPerWorkspace.map(results => ({ results, weight: 1.0 }));
    return reciprocalRankFusion(rankedLists, opts.topK ?? 15);
  }

  async indexAll(onProgress?: (workspaceId: string, status: string, current: number, total: number) => void): Promise<Map<string, IndexingResult>> {
    const results = new Map<string, IndexingResult>();
    await Promise.all(
      [...this.workspaces.entries()].map(async ([id, entry]) => {
        const result = await entry.context.incrementalIndex((status, current, total) => {
          onProgress?.(id, status, current, total);
        });
        results.set(id, result);
      }),
    );
    return results;
  }

  async listAllFiles(workspaceId?: string): Promise<{ workspaceId: string; path: string }[]> {
    const targets = workspaceId
      ? [[workspaceId, this.workspaces.get(workspaceId)!] as const]
      : [...this.workspaces.entries()];

    const allFiles: { workspaceId: string; path: string }[] = [];
    for (const [id, entry] of targets) {
      if (!entry) continue;
      const files = await entry.context.listFiles();
      for (const f of files) allFiles.push({ workspaceId: id, path: f });
    }
    return allFiles;
  }

  close(): void {
    for (const entry of this.workspaces.values()) {
      entry.context.close();
    }
    this.workspaces.clear();
  }
}
