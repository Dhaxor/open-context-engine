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

    // Hedged on purpose: these are unverified model observations from prior
    // sessions. Framing them as possibly-stale keeps a wrong memory from
    // outranking fresh tool results in the model's judgement.
    let result = "## Remembered Context (from prior sessions — may be stale; verify against the current code before relying on it)\n";
    let chars = result.length;

    for (const entry of relevant) {
      const line = `- [${entry.kind}] ${entry.content}\n`;
      if (chars + line.length > maxChars) break;
      result += line;
      chars += line.length;
    }

    return result;
  }

  /** Remove every entry and persist the empty store. */
  clearAll(): number {
    const n = this.entries.length;
    this.entries = [];
    this.save();
    return n;
  }

  extractFacts(assistantResponse: string, source: string): MemoryEntry[] {
    const added: MemoryEntry[] = [];
    // Code fences are full of strings that pattern-match prose ("the project
    // uses..." inside a README diff); never harvest from them.
    const text = assistantResponse.replace(/```[\s\S]*?```/g, " ");
    const patterns = [
      // The boundary lookahead stops at a sentence-ending period (followed by
      // whitespace/EOL) or a newline — NOT at the first "." inside a filename
      // or version, which used to truncate "src/core/sqlite-store.ts" to a
      // fabricated "src/core/sqlite-store".
      { pattern: /(?:I (?:learned|found|noticed|discovered) that|key insight:)\s*(.+?)(?=\.(?:\s|$)|\n|$)/gi, kind: "codebase_insight" as MemoryKind },
      { pattern: /(?:the (?:codebase|project|system) (?:uses|has|contains))\s*(.+?)(?=\.(?:\s|$)|\n|$)/gi, kind: "codebase_insight" as MemoryKind },
    ];

    const candidates: { content: string; kind: MemoryKind }[] = [];
    for (const { pattern, kind } of patterns) {
      for (const match of text.matchAll(pattern)) {
        const content = match[1].trim();
        if (content.length <= 20 || content.length >= 500) continue;
        // Negated/conditional context isn't a fact: "I doubt the codebase
        // uses X", "check whether the project uses Y".
        const before = text.slice(Math.max(0, (match.index ?? 0) - 32), match.index ?? 0);
        if (/\b(?:not|never|no|doubt|unlikely|whether|if|unless)\b[^.!?\n]*$/i.test(before)) continue;
        // Anything secret-shaped must never be persisted to disk.
        if (looksLikeSecret(content)) continue;
        candidates.push({ content, kind });
      }
    }

    // The two patterns often double-capture one sentence ("I found that the
    // project uses X" matches both); keep only the longest covering capture.
    const deduped = candidates.filter((c, i) =>
      !candidates.some((other, j) => j !== i && other.content.includes(c.content) && other.content.length > c.content.length));

    for (const { content, kind } of deduped) {
      const lower = content.toLowerCase();
      const exact = this.entries.some(e => e.content.toLowerCase() === lower);
      // Fuzzy dedupe: a paraphrase of an existing memory is NOT new knowledge.
      // Skipping (rather than re-adding) keeps the original createdAt, so a
      // restated falsehood can't roll its 30-day TTL forward indefinitely.
      const paraphrase = this.entries.some(e => tokenOverlap(e.content, content) >= 0.8);
      if (!exact && !paraphrase) {
        added.push(this.add({ kind, content, source, tags: extractTags(content) }));
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

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk|pa|ghp|gho|ghu|ghs|xox[a-z])[-_][A-Za-z0-9_\-]{16,}/,   // common API-key prefixes (OpenAI/Stripe/Voyage/GitHub/Slack)
  /\bAKIA[0-9A-Z]{16}\b/,                                                // AWS access key id
  /\bAIza[0-9A-Za-z_\-]{30,}/,                                           // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                                  // PEM material
  /\b(?:api[-_ ]?key|secret|token|password|passwd|credential)s?\b\s*[:=]\s*\S{8,}/i, // key: value assignments
];

function looksLikeSecret(s: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(s));
}

/** Overlap ratio of word tokens (against the smaller set). 1.0 = same words. */
function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
  const tb = new Set(b.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function extractTags(content: string): string[] {
  const words = content.match(/[A-Z][a-z]+[A-Z]\w+|[a-z_]{4,}/g) ?? [];
  return [...new Set(words.map(w => w.toLowerCase()))].slice(0, 5);
}
