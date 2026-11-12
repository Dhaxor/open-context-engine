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
  /** When set, this entry replaces the referenced memory: the old one is kept
   *  on disk (audit trail) but excluded from recall. */
  supersedes?: string;
  /** Set on the entry a newer memory replaced. Superseded entries never come
   *  back from recall — they read as "(superseded)" in listings/markdown. */
  supersededBy?: string;
  /** Content embedding (rounded to 5 decimals), filled lazily when an embedder
   *  is configured. Absent → the entry still recalls via the lexical path. */
  embedding?: number[];
}

export interface MemoryEmbedder {
  embed(texts: string[]): Promise<number[][]>;
  getDimension(): number;
}

export interface SessionMemoryConfig {
  storePath: string;
  maxEntries?: number;
  maxAge?: number;
  /** When set, memory recall fuses cosine similarity with the lexical score —
   *  the same hybrid conviction the code index holds, applied to memories.
   *  Embeddings are stored in memories.json and filled in lazily. */
  embedder?: MemoryEmbedder;
}

export class SessionMemory {
  private entries: MemoryEntry[] = [];
  private filePath: string;
  private markdownPath: string;
  private maxEntries: number;
  private maxAge: number;
  private embedder?: MemoryEmbedder;
  /** In-flight ensureEmbeddings() call, so concurrent recalls share one batch. */
  private embeddingPromise?: Promise<void>;

  constructor(config: SessionMemoryConfig) {
    this.filePath = path.join(config.storePath, "memories.json");
    this.markdownPath = path.join(config.storePath, "memories.md");
    this.maxEntries = config.maxEntries ?? 200;
    this.maxAge = config.maxAge ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    this.embedder = config.embedder;
    this.load();
  }

  add(entry: Omit<MemoryEntry, "id" | "createdAt" | "relevanceScore"> & { supersedes?: string }): MemoryEntry {
    const full: MemoryEntry = {
      ...entry,
      id: generateId(),
      createdAt: Date.now(),
      relevanceScore: 1.0,
    };
    if (entry.supersedes) {
      const old = this.entries.find(e => e.id === entry.supersedes || e.content.toLowerCase() === entry.supersedes!.toLowerCase());
      if (old) {
        old.supersededBy = full.id;
        full.supersedes = old.id;
      }
    }
    this.entries.push(full);
    this.prune();
    this.save();
    return full;
  }

  /** Lexical-only retrieval, kept for compatibility. Superseded entries never
   *  surface: a replaced memory is dead knowledge, not low-ranked knowledge. */
  retrieve(query: string, topK = 5): MemoryEntry[] {
    const live = this.entries.filter(e => !e.supersededBy);
    const queryTokens = tokenize(query);
    if (!queryTokens.length) return live.slice(-topK);

    const scored = live.map(entry => {
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

  /** Hybrid recall: lexical + cosine when embeddings exist, fused 50/50 after
   *  per-signal normalization, then freshness × relevance. Entries without an
   *  embedding still compete on the lexical path — recall degrades, never dies. */
  async recall(query: string, topK = 5): Promise<MemoryEntry[]> {
    await this.ensureEmbeddings();
    const live = this.entries.filter(e => !e.supersededBy);
    if (!live.length) return [];

    const queryTokens = tokenize(query);
    const queryVec = this.embedder && queryTokens.length ? await this.embedOne(query) : null;

    const rawToken = new Map<MemoryEntry, number>();
    for (const entry of live) {
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
      rawToken.set(entry, score);
    }
    const maxToken = Math.max(1e-9, ...rawToken.values());

    const scored = live.map(entry => {
      const tokenNorm = (rawToken.get(entry) ?? 0) / maxToken;
      let fused = tokenNorm;
      if (queryVec && entry.embedding && entry.embedding.length === queryVec.length) {
        const cos = (cosine(queryVec, entry.embedding) + 1) / 2; // → [0,1]
        fused = 0.5 * tokenNorm + 0.5 * cos;
      }
      const ageHours = (Date.now() - entry.createdAt) / (1000 * 60 * 60);
      const freshness = 1 / (1 + ageHours * 0.01);
      return { entry, score: fused * freshness * entry.relevanceScore };
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

  /** Alias with intent: forgetting is an operation the agent and CLI both
   *  expose, and it reads better than `remove` at call sites. */
  forget(id: string): boolean {
    return this.remove(id);
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

  /** Sync, lexical-only system-prompt block — compatibility path for callers
   *  that cannot await. New callers should use recallForPrompt(). */
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

  /** Hybrid recall formatted for the system prompt. Returns the entries too,
   *  so the evidence rail can show exactly what the model was reminded of. */
  async recallForPrompt(query: string, maxChars = 2000): Promise<{ text: string; entries: MemoryEntry[] }> {
    const relevant = await this.recall(query, 8);
    if (!relevant.length) return { text: "", entries: [] };

    let result = "## Remembered Context (from prior sessions — may be stale; verify against the current code before relying on it)\n";
    let chars = result.length;
    const kept: MemoryEntry[] = [];

    for (const entry of relevant) {
      const line = `- [${entry.kind}] ${entry.content}\n`;
      if (chars + line.length > maxChars) break;
      result += line;
      chars += line.length;
      kept.push(entry);
    }

    return { text: result, entries: kept };
  }

  /** Embed every entry (and only then persist) so hybrid recall has vectors to
   *  fuse with. Failures are swallowed — lexical recall still works, and the
   *  next recall retries. One batch, deduplicated across concurrent callers. */
  private async ensureEmbeddings(): Promise<void> {
    if (!this.embedder) return;
    if (this.embeddingPromise) return this.embeddingPromise;
    this.embeddingPromise = (async () => {
      try {
        const missing = this.entries.filter(e => !e.embedding);
        if (!missing.length) return;
        const vectors = await this.embedder!.embed(missing.map(e => e.content));
        missing.forEach((e, i) => {
          const v = vectors[i];
          if (v && v.length === this.embedder!.getDimension()) {
            e.embedding = v.map(x => Math.round(x * 1e5) / 1e5);
          }
        });
        this.save();
      } catch {
        // Embeddings are an upgrade, not a requirement — lexical recall covers.
      } finally {
        this.embeddingPromise = undefined;
      }
    })();
    return this.embeddingPromise;
  }

  private async embedOne(text: string): Promise<number[] | null> {
    try {
      const [v] = await this.embedder!.embed([text]);
      return v ?? null;
    } catch {
      return null;
    }
  }

  /** Remove every entry and persist the empty store. */
  clearAll(): number {
    const n = this.entries.length;
    this.entries = [];
    this.save();
    return n;
  }

  extractFacts(assistantResponse: string, source: string): MemoryEntry[] {
    return this.harvest(assistantResponse, source, ASSISTANT_PATTERNS);
  }

  /** Capture preferences/corrections from the *user's* words — "actually, we
   *  migrated off X", "don't use Y here", "prefer Z". These outrank anything
   *  the model inferred, because the human said them. */
  extractFromUserMessage(userMessage: string, source: string): MemoryEntry[] {
    return this.harvest(userMessage, source, USER_PATTERNS, "preference");
  }

  private harvest(text: string, source: string, patterns: { pattern: RegExp; kind: MemoryKind }[], forcedKind?: MemoryKind): MemoryEntry[] {
    const added: MemoryEntry[] = [];
    // Code fences are full of strings that pattern-match prose ("the project
    // uses..." inside a README diff); never harvest from them.
    const clean = text.replace(/```[\s\S]*?```/g, " ");
    const candidates: { content: string; kind: MemoryKind }[] = [];
    for (const { pattern, kind } of patterns) {
      for (const match of clean.matchAll(pattern)) {
        const content = match[1].trim();
        if (content.length <= 20 || content.length >= 500) continue;
        // Negated/conditional context isn't a fact: "I doubt the codebase
        // uses X", "check whether the project uses Y".
        const before = clean.slice(Math.max(0, (match.index ?? 0) - 32), match.index ?? 0);
        if (/\b(?:not|never|no|doubt|unlikely|whether|if|unless)\b[^.!?\n]*$/i.test(before)) continue;
        // Anything secret-shaped must never be persisted to disk.
        if (looksLikeSecret(content)) continue;
        candidates.push({ content, kind: forcedKind ?? kind });
      }
    }

    // Patterns often double-capture one sentence; keep only the longest
    // covering capture.
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
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) this.entries = parsed;
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
      // Markdown twin: the human-inspectable, harness-portable rendering of the
      // same store (MEMORY.md convention). JSON stays the source of truth.
      fs.writeFileSync(this.markdownPath, renderMarkdown(this.entries, this.maxAge));
    } catch {}
  }
}

/** Render the store as Markdown, grouped by kind, newest first. Superseded
 *  entries stay visible but marked — history you can read beats history you
 *  can't. */
export function renderMarkdown(entries: MemoryEntry[], maxAgeMs: number): string {
  const kinds: MemoryKind[] = ["preference", "codebase_insight", "fact", "conversation_summary"];
  const now = Date.now();
  const lines: string[] = [
    "# Workspace Memory",
    "",
    "<!-- Maintained by Open Context Engine (memories.json is the source of truth).",
    `     Loaded into the agent's system prompt as prior-session context. Entries`,
     `     expire after ${Math.round(maxAgeMs / 86400000)} days. -->`,
    "",
  ];
  for (const kind of kinds) {
    const group = entries
      .filter(e => e.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt);
    if (!group.length) continue;
    lines.push(`## ${kind.replace("_", " ")}`);
    lines.push("");
    for (const e of group) {
      const date = new Date(e.createdAt).toISOString().slice(0, 10);
      const stale = now - e.createdAt >= maxAgeMs;
      const flag = e.supersededBy ? " *(superseded)*" : stale ? " *(expired)*" : "";
      lines.push(`- ${e.content}${flag} \`[${date}${e.source ? ` · ${e.source}` : ""}]\``);
    }
    lines.push("");
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
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

export function looksLikeSecret(s: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(s));
}

const ASSISTANT_PATTERNS = [
  // The boundary lookahead stops at a sentence-ending period (followed by
  // whitespace/EOL) or a newline — NOT at the first "." inside a filename
  // or version, which used to truncate "src/core/sqlite-store.ts" to a
  // fabricated "src/core/sqlite-store".
  { pattern: /(?:I (?:learned|found|noticed|discovered) that|key insight:)\s*(.+?)(?=\.(?:\s|$)|\n|$)/gi, kind: "codebase_insight" as MemoryKind },
  { pattern: /(?:the (?:codebase|project|system) (?:uses|has|contains))\s*(.+?)(?=\.(?:\s|$)|\n|$)/gi, kind: "codebase_insight" as MemoryKind },
];

// User-stated preferences/corrections. Captured from the human's own words —
// the highest-trust memory kind — so the same guards apply but the framing
// differs ("we use", "don't", "prefer", "actually").
const USER_PATTERNS = [
  { pattern: /(?:actually[,:]?\s*|we (?:now )?(?:use|used|migrated (?:to|off)|switched to)|don'?t use|do not use|prefer|always|never)\s+(.+?)(?=\.(?:\s|$)|\n|$)/gi, kind: "preference" as MemoryKind },
];

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

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
