import * as path from "path";
import { SqliteStore } from "./sqlite-store";
import { SearchResult, SearchConfig } from "./types";
import { EmbeddingProvider } from "./embedder";
import { Reranker } from "./reranker";
import { packSearchResults, PackingDecision } from "./context-packer";
import { RecencyScores, applyRecencyBoost } from "./git-recency";
import { expandQuery } from "./query-expander";
import { QueryCache } from "./query-cache";
import { GraphExpander } from "./graph-expander";

export interface RetrieveOptions {
  pathPrefix?: string;
  expandSymbols?: boolean;
  topK?: number;
  activePath?: string;
  openPaths?: string[];
  contextText?: string;
}

export interface RetrievalDebugItem {
  rank: number;
  path: string;
  lines: string;
  symbolName?: string;
  parentSymbol?: string;
  score: number;
  vectorScore?: number;
  bm25Score?: number;
  rerankScore?: number;
  reason?: string;
  preview: string;
}

export interface RetrievalDebugReport {
  query: string;
  signals: string[];
  editorContext?: { activePath?: string; openPaths: string[]; contextSignals: string[] };
  vectorHits: RetrievalDebugItem[];
  bm25Hits: RetrievalDebugItem[];
  fused: RetrievalDebugItem[];
  ranked: RetrievalDebugItem[];
  expanded: RetrievalDebugItem[];
  final: RetrievalDebugItem[];
  /** Full final results (after expansion), so callers needn't re-run the pipeline. */
  finalResults: SearchResult[];
  packing?: { includedFiles: number; includedChunks: number; droppedChunks: number; totalChars: number; decisions: PackingDecision[]; preview: string };
}

export class HybridRetriever {
  private cache: QueryCache;
  private recency: RecencyScores | null = null;
  private graphExpander: GraphExpander | null = null;

  constructor(
    private store: SqliteStore,
    private embedder: EmbeddingProvider,
    private search: SearchConfig,
    private reranker?: Reranker,
    cache?: QueryCache,
  ) {
    this.cache = cache ?? new QueryCache();
  }

  setRecencyScores(scores: RecencyScores): void {
    this.recency = scores;
  }

  setGraphExpander(expander: GraphExpander): void {
    this.graphExpander = expander;
  }

  getCache(): QueryCache {
    return this.cache;
  }

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<SearchResult[]> {
    const ranked = await this.rank(query, opts);
    const trimmed = ranked.results.slice(0, ranked.finalK);
    if (!(opts.expandSymbols ?? this.search.expandSymbols ?? true)) return trimmed;
    if (this.graphExpander) {
      const { results } = this.graphExpander.expand(trimmed, query);
      return results;
    }
    return this.expandResults(trimmed, query).results;
  }

  async retrieveDebug(query: string, opts: RetrieveOptions = {}): Promise<RetrievalDebugReport> {
    const ranked = await this.rank(query, opts);
    const trimmed = ranked.results.slice(0, ranked.finalK);
    const expanded = (opts.expandSymbols ?? this.search.expandSymbols ?? true) ? this.expandResults(trimmed, query) : { results: trimmed, reasons: new Map<string, string>() };
    const packed = packSearchResults(expanded.results, { maxTotalChars: this.search.maxOutputLength });
    return {
      query,
      signals: [...querySignals(query)],
      editorContext: {
        activePath: opts.activePath,
        openPaths: opts.openPaths ?? [],
        contextSignals: [...querySignals(opts.contextText ?? "")],
      },
      vectorHits: toDebugItems(ranked.vectorHits.slice(0, 12)),
      bm25Hits: toDebugItems(ranked.bm25Hits.slice(0, 12)),
      fused: toDebugItems(ranked.fused.slice(0, 12)),
      ranked: toDebugItems(ranked.results.slice(0, 12)),
      expanded: toDebugItems(expanded.results.slice(trimmed.length), expanded.reasons),
      final: toDebugItems(expanded.results, expanded.reasons),
      finalResults: expanded.results,
      packing: { ...packed, preview: packed.output.slice(0, 4000) },
    };
  }

  private async rank(query: string, opts: RetrieveOptions = {}): Promise<{ vectorHits: SearchResult[]; bm25Hits: SearchResult[]; fused: SearchResult[]; results: SearchResult[]; finalK: number }> {
    const candidateK = opts.topK != null ? Math.max(opts.topK * 4, 40) : (this.search.candidateK ?? 60);
    const finalK = opts.topK ?? this.search.topK;

    const { original, expanded } = expandQuery(query);
    const vectorQuery = expanded;

    let queryVec = this.cache.getEmbedding(vectorQuery);
    if (!queryVec) {
      queryVec = (await this.embedder.embed([vectorQuery], "query"))[0];
      this.cache.setEmbedding(vectorQuery, queryVec);
    }

    const [vectorHits, bm25Hits] = await Promise.all([
      Promise.resolve(this.store.vectorSearch(queryVec, candidateK, opts.pathPrefix)),
      Promise.resolve(this.store.bm25Search(original, candidateK, opts.pathPrefix)),
    ]);

    let fused = applyEditorContextBoost(applySymbolAwareBoost(reciprocalRankFusion(
      [
        { results: vectorHits, weight: this.search.vectorWeight ?? 1.0 },
        { results: bm25Hits, weight: this.search.bm25Weight ?? 1.0 },
      ],
      this.search.candidateK ?? 60,
    ), query), opts);

    if (this.recency) {
      fused = applyRecencyBoost(fused, this.recency, this.search.recencyWeight ?? 0.3) as SearchResult[];
    }

    let results = fused;
    if (this.reranker && (this.search.rerank ?? true) && results.length > 1) {
      try {
        const reranked = await this.reranker.rerank(query, results.map(r => r.chunk), Math.max(finalK, 15));
        if (reranked.length) {
          results = applyEditorContextBoost(applySymbolAwareBoost(reranked.map((r, i) => ({ ...r, score: 1 / (i + 1), rerankScore: r.rerankScore })), query), opts);
          if (this.recency) {
            results = applyRecencyBoost(results, this.recency, this.search.recencyWeight ?? 0.3) as SearchResult[];
          }
        }
      } catch (err) {
        // A reranker outage must not take down search — fall back to the fused
        // (vector + BM25 + boost) ordering, which is already good.
        if (process.env.OPEN_CONTEXT_DEBUG) {
          console.error(`Reranker failed; using fused results. ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { vectorHits, bm25Hits, fused, results, finalK };
  }

  private expandResults(results: SearchResult[], query: string): { results: SearchResult[]; reasons: Map<string, string> } {
    const seen = new Set(results.map(r => r.chunk.id));
    const reasons = new Map<string, string>();
    const extras: SearchResult[] = [];
    const indexedPaths = this.store.getIndexedPaths();
    const usageTerms = new Set([...querySignals(query), ...results.map(r => r.chunk.symbolName).filter(Boolean).map(s => s!)].slice(0, 12));
    const addExtra = (chunk: SearchResult["chunk"], score: number, reason: string): boolean => {
      if (seen.has(chunk.id)) return false;
      seen.add(chunk.id);
      reasons.set(chunk.id, reason);
      extras.push({ chunk, score });
      return extras.length >= 12;
    };
    for (const r of results.slice(0, 5)) {
      const related = [
        ...(r.chunk.symbolName ? this.store.getChunksBySymbol(r.chunk.symbolName, 3).map(chunk => ({ chunk, reason: `same symbol: ${r.chunk.symbolName}`, factor: 0.65 })) : []),
        ...(r.chunk.parentSymbol ? this.store.getChunksByParentSymbol(r.chunk.parentSymbol, r.chunk.path, 4).map(chunk => ({ chunk, reason: `same parent: ${r.chunk.parentSymbol}`, factor: 0.62 })) : []),
        ...this.store.getChunksNear(r.chunk.path, r.chunk.startLine, r.chunk.endLine, 3).map(chunk => ({ chunk, reason: "nearby chunk", factor: 0.55 })),
      ];
      for (const importedPath of resolveRelativeImportPaths(r.chunk.path, extractRelativeImportSpecifiers(r.chunk.contents), indexedPaths)) {
        related.push(...this.store.getChunksByPath(importedPath, 2).map(chunk => ({ chunk, reason: `local import: ${importedPath}`, factor: 0.5 })));
      }
      for (const d of related) if (addExtra(d.chunk, r.score * d.factor, d.reason)) break;
      if (extras.length >= 12) break;
      const refs = extractIdentifiers(r.chunk.contents);
      for (const ref of refs.slice(0, 6)) {
        const defs = this.store.getChunksBySymbol(ref, 1);
        for (const d of defs) {
          if (addExtra(d, r.score * 0.48, `definition: ${ref}`)) break;
        }
        if (extras.length >= 12) break;
      }
      if (extras.length >= 12) break;
    }
    for (const term of usageTerms) {
      for (const d of this.store.getChunksReferencingIdentifier(term, undefined, 3)) {
        if (addExtra(d, Math.max(0.01, results[0]?.score ?? 1) * 0.42, `usage/caller: ${term}`)) break;
      }
      if (extras.length >= 12) break;
    }
    return { results: [...results, ...extras], reasons };
  }
}

interface RankedList { results: SearchResult[]; weight: number; }

export function reciprocalRankFusion(lists: RankedList[], topK: number, k = 60): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();
  for (const { results, weight } of lists) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const rrfBoost = weight / (k + i + 1);
      const existing = scores.get(r.chunk.id);
      if (existing) {
        existing.score += rrfBoost;
        existing.result = mergeScoreFields(existing.result, r);
      } else {
        scores.set(r.chunk.id, { result: r, score: rrfBoost });
      }
    }
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ result, score }) => ({ ...result, score }));
}

function mergeScoreFields(a: SearchResult, b: SearchResult): SearchResult {
  return {
    ...a,
    vectorScore: a.vectorScore ?? b.vectorScore,
    bm25Score: a.bm25Score ?? b.bm25Score,
    rerankScore: a.rerankScore ?? b.rerankScore,
  };
}

export function applySymbolAwareBoost(results: SearchResult[], query: string): SearchResult[] {
  const signals = querySignals(query);
  if (!signals.size) return results;
  return results
    .map(r => ({ result: r, boosted: r.score * symbolBoostMultiplier(r, signals) }))
    .sort((a, b) => b.boosted - a.boosted)
    .map(({ result, boosted }) => ({ ...result, score: boosted }));
}

export function applyEditorContextBoost(results: SearchResult[], opts: RetrieveOptions): SearchResult[] {
  const activePath = normalizePath(opts.activePath);
  const openPaths = new Set((opts.openPaths ?? []).map(normalizePath).filter(Boolean) as string[]);
  const contextSignals = querySignals(opts.contextText ?? "");
  if (!activePath && !openPaths.size && !contextSignals.size) return results;
  return results
    .map(r => ({ result: r, boosted: r.score * editorContextMultiplier(r, activePath, openPaths, contextSignals) }))
    .sort((a, b) => b.boosted - a.boosted)
    .map(({ result, boosted }) => ({ ...result, score: boosted }));
}

function editorContextMultiplier(result: SearchResult, activePath: string | null, openPaths: Set<string>, contextSignals: Set<string>): number {
  const chunkPath = normalizePath(result.chunk.path) ?? "";
  let boost = 1;
  if (activePath && chunkPath === activePath) boost += 0.9;
  else if (openPaths.has(chunkPath)) boost += 0.35;
  const symbol = normalize(result.chunk.symbolName);
  const parent = normalize(result.chunk.parentSymbol);
  const contents = normalize(result.chunk.contents.slice(0, 1000));
  for (const signal of contextSignals) {
    if (symbol && (symbol === signal || symbol.includes(signal))) boost += 0.4;
    if (parent && (parent === signal || parent.includes(signal))) boost += 0.25;
    if (contents.includes(signal)) boost += 0.12;
  }
  return Math.min(boost, 2.5);
}

function normalizePath(p: string | undefined): string | null {
  if (!p) return null;
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function symbolBoostMultiplier(result: SearchResult, signals: Set<string>): number {
  const c = result.chunk;
  let boost = 1;
  const symbol = normalize(c.symbolName);
  const parent = normalize(c.parentSymbol);
  const pathName = normalize(c.path);
  const contents = normalize(c.contents.slice(0, 600));
  for (const s of signals) {
    if (symbol === s) boost += 1.4;
    else if (symbol && (symbol.includes(s) || s.includes(symbol))) boost += 0.8;
    if (parent && (parent === s || parent.includes(s))) boost += 0.5;
    if (pathName.includes(s)) boost += 0.35;
    if (contents.includes(s)) boost += 0.15;
  }
  return Math.min(boost, 4);
}

function querySignals(query: string): Set<string> {
  const raw = extractIdentifiers(query).concat(query.split(/[\s./#:_-]+/));
  return new Set(raw.map(normalize).filter(t => t.length >= 3 && !STOP.has(t)));
}

function normalize(s: string | undefined): string {
  return (s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function extractRelativeImportSpecifiers(text: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /import\s+(?:[^"']+?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g,
    /export\s+[^"']+?\s+from\s+["'](\.{1,2}\/[^"']+)["']/g,
    /require\(["'](\.{1,2}\/[^"']+)["']\)/g,
  ];
  for (const p of patterns) for (const m of text.matchAll(p)) specs.add(m[1]);
  return [...specs];
}

export function resolveRelativeImportPaths(fromPath: string, specs: string[], indexedPaths: string[]): string[] {
  const indexed = new Set(indexedPaths);
  const out: string[] = [];
  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs"];
  for (const spec of specs) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec));
    const candidates = exts.flatMap(ext => [`${base}${ext}`, `${base}/index${ext}`]);
    for (const c of candidates) if (indexed.has(c) && !out.includes(c)) { out.push(c); break; }
  }
  return out;
}

function toDebugItems(results: SearchResult[], reasons = new Map<string, string>()): RetrievalDebugItem[] {
  return results.map((r, i) => ({
    rank: i + 1,
    path: r.chunk.path,
    lines: `${r.chunk.startLine}-${r.chunk.endLine}`,
    symbolName: r.chunk.symbolName,
    parentSymbol: r.chunk.parentSymbol,
    score: Number(r.score.toFixed(6)),
    vectorScore: r.vectorScore,
    bm25Score: r.bm25Score,
    rerankScore: r.rerankScore,
    reason: reasons.get(r.chunk.id),
    preview: r.chunk.contents.slice(0, 240).replace(/\s+/g, " ").trim(),
  }));
}

const IDENT_PATTERN = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const STOP = new Set([
  "function", "class", "interface", "const", "let", "var", "return", "import", "export",
  "from", "this", "true", "false", "null", "undefined", "void", "public", "private",
  "protected", "static", "async", "await", "new", "type", "enum", "struct", "trait",
  "impl", "pub", "fn", "mod", "use", "def", "self", "None", "True", "False", "for",
  "while", "if", "else", "elif", "and", "or", "not", "break", "continue", "switch",
  "case", "default", "try", "catch", "finally", "throw", "throws", "package",
  "string", "number", "boolean", "any", "array", "object", "the", "that", "with",
  "when", "where", "what", "which", "who", "why", "how", "editor", "highlighted",
]);

function extractIdentifiers(text: string): string[] {
  const tokens = text.match(IDENT_PATTERN) ?? [];
  const counts = new Map<string, number>();
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (STOP.has(lower)) continue;
    if (t.length < 3) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}
