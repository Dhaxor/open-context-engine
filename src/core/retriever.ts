import { SqliteStore } from "./sqlite-store";
import { SearchResult, SearchConfig } from "./types";
import { EmbeddingProvider } from "./embedder";
import { Reranker } from "./reranker";

export interface RetrieveOptions {
  pathPrefix?: string;
  expandSymbols?: boolean;
  topK?: number;
}

export class HybridRetriever {
  constructor(
    private store: SqliteStore,
    private embedder: EmbeddingProvider,
    private search: SearchConfig,
    private reranker?: Reranker,
  ) {}

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<SearchResult[]> {
    const candidateK = opts.topK != null ? Math.max(opts.topK * 4, 40) : (this.search.candidateK ?? 60);
    const finalK = opts.topK ?? this.search.topK;

    const queryVec = (await this.embedder.embed([query], "query"))[0];
    const [vectorHits, bm25Hits] = await Promise.all([
      Promise.resolve(this.store.vectorSearch(queryVec, candidateK, opts.pathPrefix)),
      Promise.resolve(this.store.bm25Search(query, candidateK, opts.pathPrefix)),
    ]);

    const fused = reciprocalRankFusion(
      [
        { results: vectorHits, weight: this.search.vectorWeight ?? 1.0 },
        { results: bm25Hits, weight: this.search.bm25Weight ?? 1.0 },
      ],
      this.search.candidateK ?? 60,
    );

    let results = fused;
    if (this.reranker && (this.search.rerank ?? true) && results.length > 1) {
      const reranked = await this.reranker.rerank(query, results.map(r => r.chunk), Math.max(finalK, 15));
      results = reranked.map((r, i) => ({ ...r, score: 1 / (i + 1), rerankScore: r.rerankScore }));
    }

    const trimmed = results.slice(0, finalK);
    if (opts.expandSymbols ?? this.search.expandSymbols ?? true) {
      return this.expandWithSymbols(trimmed);
    }
    return trimmed;
  }

  private expandWithSymbols(results: SearchResult[]): SearchResult[] {
    const seen = new Set(results.map(r => r.chunk.id));
    const extras: SearchResult[] = [];
    for (const r of results.slice(0, 5)) {
      const refs = extractIdentifiers(r.chunk.contents);
      for (const ref of refs.slice(0, 6)) {
        const defs = this.store.getChunksBySymbol(ref, 1);
        for (const d of defs) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          extras.push({ chunk: d, score: r.score * 0.5 });
          if (extras.length >= 5) break;
        }
        if (extras.length >= 5) break;
      }
      if (extras.length >= 5) break;
    }
    return [...results, ...extras];
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

const IDENT_PATTERN = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const STOP = new Set([
  "function", "class", "interface", "const", "let", "var", "return", "import", "export",
  "from", "this", "true", "false", "null", "undefined", "void", "public", "private",
  "protected", "static", "async", "await", "new", "type", "enum", "struct", "trait",
  "impl", "pub", "fn", "mod", "use", "def", "self", "None", "True", "False", "for",
  "while", "if", "else", "elif", "and", "or", "not", "break", "continue", "switch",
  "case", "default", "try", "catch", "finally", "throw", "throws", "package",
  "string", "number", "boolean", "any", "array", "object",
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
