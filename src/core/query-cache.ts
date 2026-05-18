import { SearchResult } from "./types";

interface CacheEntry<T> {
  value: T;
  version: number;
  accessedAt: number;
}

export class QueryCache {
  private embeddings = new Map<string, CacheEntry<number[]>>();
  private results = new Map<string, CacheEntry<SearchResult[]>>();
  private version = 0;
  private maxSize: number;

  constructor(maxSize = 128) {
    this.maxSize = maxSize;
  }

  invalidate(): void {
    this.version++;
    this.embeddings.clear();
    this.results.clear();
  }

  getEmbedding(query: string): number[] | null {
    const entry = this.embeddings.get(query);
    if (!entry || entry.version !== this.version) return null;
    entry.accessedAt = Date.now();
    return entry.value;
  }

  setEmbedding(query: string, vec: number[]): void {
    this.evictIfFull(this.embeddings);
    this.embeddings.set(query, { value: vec, version: this.version, accessedAt: Date.now() });
  }

  getResults(key: string): SearchResult[] | null {
    const entry = this.results.get(key);
    if (!entry || entry.version !== this.version) return null;
    entry.accessedAt = Date.now();
    return entry.value;
  }

  setResults(key: string, results: SearchResult[]): void {
    this.evictIfFull(this.results);
    this.results.set(key, { value: results, version: this.version, accessedAt: Date.now() });
  }

  getVersion(): number {
    return this.version;
  }

  private evictIfFull<T>(map: Map<string, CacheEntry<T>>): void {
    if (map.size < this.maxSize) return;
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of map) {
      if (entry.accessedAt < oldestTime) {
        oldestTime = entry.accessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) map.delete(oldestKey);
  }
}
