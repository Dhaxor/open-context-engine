import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionMemory, renderMarkdown, type MemoryEmbedder } from "./session-memory";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-mem-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Deterministic fake embedder with a tiny semantic prior: tokens from the
 *  same synonym group land on the same axis, so paraphrases score high cosine
 *  while unrelated texts score ~0 — enough for the fusion tests to be exact. */
const SEMANTIC_GROUPS = [
  ["login", "verification", "auth", "sessions", "validated", "authmiddleware", "jwt"],
  ["build", "cli", "commander", "vite", "webpack"],
  ["rate", "limiting", "bucket", "token"],
];

function fakeEmbedder(dim = 16): MemoryEmbedder & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    getDimension: () => dim,
    embed: async (input: string[]) => {
      texts.push(...input);
      return input.map(t => {
        const v = new Array(dim).fill(0);
        for (const tok of t.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
          const group = SEMANTIC_GROUPS.findIndex(g => g.includes(tok));
          const idx = group >= 0
            ? group
            : 3 + ([...tok].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % (dim - 3), 0));
          v[idx] += 1;
        }
        return v;
      });
    },
  };
}

describe("SessionMemory — supersedes", () => {
  it("marks the old entry and excludes it from retrieval", () => {
    const mem = new SessionMemory({ storePath: dir });
    const old = mem.add({ kind: "codebase_insight", content: "auth middleware lives in src/legacy/guard.ts", source: "agent", tags: ["auth"] });
    const newer = mem.add({
      kind: "codebase_insight",
      content: "auth middleware moved to src/auth/guard.ts",
      source: "agent",
      tags: ["auth"],
      supersedes: old.id,
    });
    expect(newer.supersedes).toBe(old.id);
    // By id…
    const hits = mem.retrieve("where is auth middleware");
    expect(hits.some(e => e.id === old.id)).toBe(false);
    expect(hits.some(e => e.id === newer.id)).toBe(true);
    // …and by exact content (the agent passes back what it recalled).
    const mem2 = new SessionMemory({ storePath: dir });
    const again = mem2.add({
      kind: "codebase_insight",
      content: "auth middleware moved to src/auth/guard.ts",
      source: "agent",
      tags: [],
      supersedes: "auth middleware lives in src/legacy/guard.ts",
    });
    expect(again.supersedes).toBe(old.id);
    expect(mem2.getAll().find(e => e.id === old.id)?.supersededBy).toBe(again.id);
  });

  it("recalls only the live entry in a superseded pair", async () => {
    const mem = new SessionMemory({ storePath: dir });
    const old = mem.add({ kind: "fact", content: "the project uses webpack for builds", source: "agent", tags: [] });
    mem.add({ kind: "fact", content: "the project uses vite for builds now", source: "agent", tags: [], supersedes: old.id });
    const hits = await mem.recall("what build tool does the project use");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(e => !e.content.includes("webpack"))).toBe(true);
  });
});

describe("SessionMemory — hybrid recall", () => {
  it("fuses embeddings: a paraphrase query ranks the semantic hit first", async () => {
    const embedder = fakeEmbedder();
    const mem = new SessionMemory({ storePath: dir, embedder });
    mem.add({ kind: "codebase_insight", content: "user sessions are validated in authMiddleware", source: "agent", tags: ["auth"] });
    mem.add({ kind: "codebase_insight", content: "the CLI parses arguments with commander", source: "agent", tags: ["cli"] });
    // No lexical overlap with either memory — only the embedding can find it.
    const hits = await mem.recall("how does login verification work");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("authMiddleware");
    expect(embedder.texts.length).toBeGreaterThan(0);
  });

  it("degrades to lexical recall when the embedder fails", async () => {
    const mem = new SessionMemory({
      storePath: dir,
      embedder: { getDimension: () => 8, embed: async () => { throw new Error("provider down"); } },
    });
    mem.add({ kind: "fact", content: "deployment scripts live in infra/", source: "agent", tags: [] });
    const hits = await mem.recall("deployment scripts");
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain("infra/");
    // And no entry was poisoned with a broken embedding.
    expect(mem.getAll().every(e => !e.embedding)).toBe(true);
  });

  it("embeds lazily once and persists the vectors", async () => {
    const embedder = fakeEmbedder();
    const mem = new SessionMemory({ storePath: dir, embedder });
    mem.add({ kind: "fact", content: "rate limiting uses a token bucket", source: "agent", tags: [] });
    await mem.recall("rate limiting");
    // First recall embeds the entry batch + the query.
    expect(embedder.texts.length).toBe(2);
    const afterFirst = embedder.texts.length;
    await mem.recall("rate limiting again");
    // Second recall re-embeds only the query — the entry vector was cached.
    expect(embedder.texts.length - afterFirst).toBe(1);
    // …and the vector is on disk: a fresh instance recalls without re-embedding
    // the entry (one embed call = the query alone).
    const mem2 = new SessionMemory({ storePath: dir, embedder });
    const before = embedder.texts.length;
    const hits = await mem2.recall("rate limiting");
    expect(embedder.texts.length - before).toBe(1);
    expect(hits.length).toBe(1);
    expect(mem2.getAll()[0].embedding).toBeDefined();
  });
});

describe("SessionMemory — markdown twin", () => {
  it("writes memories.md beside memories.json, grouped by kind", () => {
    const mem = new SessionMemory({ storePath: dir });
    mem.add({ kind: "preference", content: "the team prefers pnpm over npm", source: "user", tags: [] });
    mem.add({ kind: "codebase_insight", content: "search fusion lives in src/core/retriever.ts", source: "agent", tags: [] });
    const mdPath = path.join(dir, "memories.md");
    expect(fs.existsSync(mdPath)).toBe(true);
    const md = fs.readFileSync(mdPath, "utf8");
    expect(md).toContain("# Workspace Memory");
    expect(md).toContain("## preference");
    expect(md).toContain("## codebase insight");
    expect(md).toContain("the team prefers pnpm over npm");
    expect(md).toMatch(/\[\d{4}-\d{2}-\d{2} · user\]/);
  });

  it("marks superseded entries in the markdown", () => {
    const mem = new SessionMemory({ storePath: dir });
    const old = mem.add({ kind: "fact", content: "builds use webpack", source: "agent", tags: [] });
    mem.add({ kind: "fact", content: "builds use vite", source: "agent", tags: [], supersedes: old.id });
    const md = fs.readFileSync(path.join(dir, "memories.md"), "utf8");
    expect(md).toContain("builds use webpack *(superseded)*");
  });

  it("renderMarkdown stays a pure function for the CLI export", () => {
    const md = renderMarkdown([{
      id: "mem_x", kind: "fact", content: "hello world", source: "cli",
      createdAt: Date.now(), relevanceScore: 1, tags: [],
    }], 30 * 24 * 60 * 60 * 1000);
    expect(md).toContain("- hello world");
  });
});

describe("SessionMemory — user-message capture", () => {
  it("captures stated preferences as the preference kind", () => {
    const mem = new SessionMemory({ storePath: dir });
    const added = mem.extractFromUserMessage(
      "Actually, we migrated to Vitest last quarter. Don't use jest for new tests.",
      "user",
    );
    expect(added.length).toBeGreaterThan(0);
    expect(added.every(e => e.kind === "preference")).toBe(true);
    expect(added.some(e => e.content.toLowerCase().includes("vitest"))).toBe(true);
  });

  it("never stores secret-shaped content", () => {
    const mem = new SessionMemory({ storePath: dir });
    const added = mem.extractFromUserMessage(
      "We use sk-proj-abcdefabcdefabcdefabcdef1234 as the API key for now.",
      "user",
    );
    expect(added.length).toBe(0);
    expect(mem.getAll().length).toBe(0);
  });

  it("does not double-capture a paraphrase restatement", () => {
    const mem = new SessionMemory({ storePath: dir });
    mem.add({ kind: "preference", content: "we migrated to Vitest for the test suite last quarter", source: "user", tags: [] });
    // The capture ("Vitest for the test suite last quarter") restates the same
    // fact — the paraphrase guard must skip it, keeping the original createdAt.
    const added = mem.extractFromUserMessage("We migrated to Vitest for the test suite last quarter.", "user");
    expect(added.length).toBe(0);
    expect(mem.getAll().length).toBe(1);
  });
});

describe("SessionMemory — pruning stays intact", () => {
  it("drops entries beyond maxAge even when superseded history exists", () => {
    const mem = new SessionMemory({ storePath: dir, maxAge: 1000, maxEntries: 10 });
    mem.add({ kind: "fact", content: "old memory about auth caching", source: "agent", tags: [] });
    // Force it past the TTL.
    const all = mem.getAll();
    (all[0] as any).createdAt = Date.now() - 5000;
    mem.prune();
    expect(mem.getAll().length).toBe(0);
  });
});
