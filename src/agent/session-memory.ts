import * as fs from "fs";
import * as path from "path";

export type MemoryKind = "fact" | "preference" | "codebase_insight" | "conversation_summary";

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  createdAt: number;
  relevanceScore: number;
  tags: string[];
}

export interface SessionMemoryConfig {
  storePath: string;
  maxEntries?: number;
  maxAge?: number;
}

export class SessionMemory {
  private entries: MemoryEntry[] = [];
  private filePath: string;
  private maxEntries: number;
  private maxAge: number;

  constructor(config: SessionMemoryConfig) {
    this.filePath = path.join(config.storePath, "memories.json");
    this.maxEntries = config.maxEntries ?? 200;
    this.maxAge = config.maxAge ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    this.load();
  }

  add(entry: Omit<MemoryEntry, "id" | "createdAt" | "relevanceScore">): MemoryEntry {
    const full: MemoryEntry = {
      ...entry,
      id: generateId(),
      createdAt: Date.now(),
      relevanceScore: 1.0,
    };
    this.entries.push(full);
    this.prune();
    this.save();
    return full;
  }

  retrieve(query: string, topK = 5): MemoryEntry[] {
    const queryTokens = tokenize(query);
    if (!queryTokens.length) return this.entries.slice(-topK);

    const scored = this.entries.map(entry => {
      const entryTokens = tokenize(entry.content);
      const tagTokens = entry.tags.map(t => t.toLowerCase());
      let score = 0;

      for (const qt of queryTokens) {
        if (entryTokens.includes(qt)) score += 1;
        if (tagTokens.includes(qt)) score += 2;
        for (const et of entryTokens) {
          if (et.includes(qt) || qt.includes(et)) score += 0.3;
        }
      }

      const ageHours = (Date.now() - entry.createdAt) / (1000 * 60 * 60);
      const freshness = 1 / (1 + ageHours * 0.01);
      score *= freshness * entry.relevanceScore;

      return { entry, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => s.entry);
  }

  getAll(): MemoryEntry[] {
    return [...this.entries];
  }

  getByKind(kind: MemoryKind): MemoryEntry[] {
    return this.entries.filter(e => e.kind === kind);
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id);
    if (this.entries.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  updateRelevance(id: string, score: number): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry) {
      entry.relevanceScore = Math.max(0, Math.min(2, score));
      this.save();
    }
  }

  prune(): void {
    const now = Date.now();
    this.entries = this.entries.filter(e => now - e.createdAt < this.maxAge);
    if (this.entries.length > this.maxEntries) {
      this.entries.sort((a, b) => b.relevanceScore * (1 / (1 + (now - b.createdAt) / 86400000)) -
        a.relevanceScore * (1 / (1 + (now - a.createdAt) / 86400000)));
      this.entries = this.entries.slice(0, this.maxEntries);
    }
  }

  formatForSystemPrompt(query: string, maxChars = 2000): string {
    const relevant = this.retrieve(query, 8);
    if (!relevant.length) return "";

    let result = "## Remembered Context\n";
    let chars = result.length;

    for (const entry of relevant) {
      const line = `- [${entry.kind}] ${entry.content}\n`;
      if (chars + line.length > maxChars) break;
      result += line;
      chars += line.length;
    }

    return result;
  }

  extractFacts(assistantResponse: string, source: string): MemoryEntry[] {
    const added: MemoryEntry[] = [];
    const patterns = [
      { pattern: /(?:I (?:learned|found|noticed|discovered) that|key insight:)\s*(.+?)(?:\.|$)/gi, kind: "codebase_insight" as MemoryKind },
      { pattern: /(?:the (?:codebase|project|system) (?:uses|has|contains))\s*(.+?)(?:\.|$)/gi, kind: "codebase_insight" as MemoryKind },
    ];

    for (const { pattern, kind } of patterns) {
      for (const match of assistantResponse.matchAll(pattern)) {
        const content = match[1].trim();
        if (content.length > 20 && content.length < 500) {
          const existing = this.entries.find(e => e.content.toLowerCase() === content.toLowerCase());
          if (!existing) {
            added.push(this.add({ kind, content, source, tags: extractTags(content) }));
          }
        }
      }
    }

    return added;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf8");
        this.entries = JSON.parse(data);
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2));
    } catch {}
  }
}

function generateId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function extractTags(content: string): string[] {
  const words = content.match(/[A-Z][a-z]+[A-Z]\w+|[a-z_]{4,}/g) ?? [];
  return [...new Set(words.map(w => w.toLowerCase()))].slice(0, 5);
}
