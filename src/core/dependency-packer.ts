import { SearchResult } from "./types";
import { CodeGraph } from "./code-graph";
import { SqliteStore } from "./sqlite-store";
import { packSearchResults, PackedContext, PackingOptions } from "./context-packer";

export interface DependencyPackingOptions extends PackingOptions {
  dependencyBudgetRatio?: number;
  maxDependencyDepth?: number;
  maxDependencyResults?: number;
}

const DEP_DEFAULTS = {
  dependencyBudgetRatio: 0.3,
  maxDependencyDepth: 2,
  maxDependencyResults: 8,
};

export function packWithDependencies(
  results: SearchResult[],
  graph: CodeGraph,
  store: SqliteStore,
  opts: DependencyPackingOptions = {},
): PackedContext {
  const cfg = { ...DEP_DEFAULTS, ...opts };
  const maxTotalChars = opts.maxTotalChars ?? 24_000;
  const primaryBudget = Math.floor(maxTotalChars * (1 - cfg.dependencyBudgetRatio));
  const depBudget = maxTotalChars - primaryBudget;

  const primaryPacked = packSearchResults(results, { ...opts, maxTotalChars: primaryBudget });

  const includedPaths = new Set(results.map(r => r.chunk.path));
  const depResults = collectDependencyChunks(results, graph, store, includedPaths, cfg);

  if (!depResults.length) return primaryPacked;

  const depPacked = packSearchResults(depResults, { ...opts, maxTotalChars: depBudget });

  const combinedOutput = [
    primaryPacked.output,
    depPacked.output ? `\n\n---\n\n**Dependencies (imported by above):**\n\n${depPacked.output}` : "",
  ].filter(Boolean).join("");

  return {
    output: combinedOutput,
    decisions: [...primaryPacked.decisions, ...depPacked.decisions],
    includedFiles: primaryPacked.includedFiles + depPacked.includedFiles,
    includedChunks: primaryPacked.includedChunks + depPacked.includedChunks,
    droppedChunks: primaryPacked.droppedChunks + depPacked.droppedChunks,
    totalChars: combinedOutput.length,
  };
}

function collectDependencyChunks(
  results: SearchResult[],
  graph: CodeGraph,
  store: SqliteStore,
  excludePaths: Set<string>,
  cfg: typeof DEP_DEFAULTS,
): SearchResult[] {
  const depChunks: SearchResult[] = [];
  const seen = new Set<string>();

  for (const result of results.slice(0, 5)) {
    const imports = graph.getImportsOf(result.chunk.path);
    for (const importedPath of imports) {
      if (excludePaths.has(importedPath)) continue;
      if (seen.has(importedPath)) continue;
      seen.add(importedPath);

      const chunks = store.getChunksByPath(importedPath, 2);
      if (!chunks.length) continue;

      const best = chunks[0];
      depChunks.push({ chunk: best, score: result.score * 0.4 });

      if (depChunks.length >= cfg.maxDependencyResults) break;
    }
    if (depChunks.length >= cfg.maxDependencyResults) break;

    if (cfg.maxDependencyDepth >= 2) {
      for (const depResult of [...depChunks].slice(0, 3)) {
        const deepImports = graph.getImportsOf(depResult.chunk.path);
        for (const deepPath of deepImports.slice(0, 2)) {
          if (excludePaths.has(deepPath) || seen.has(deepPath)) continue;
          seen.add(deepPath);

          const chunks = store.getChunksByPath(deepPath, 1);
          if (chunks.length) {
            depChunks.push({ chunk: chunks[0], score: depResult.score * 0.3 });
          }
          if (depChunks.length >= cfg.maxDependencyResults) break;
        }
        if (depChunks.length >= cfg.maxDependencyResults) break;
      }
    }
  }

  return depChunks.sort((a, b) => b.score - a.score);
}
