import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextAgent } from "./agent";
import { ModelRouter, defaultRoutingConfig } from "./model-router";
import { SessionMemory } from "./session-memory";
import { AgentMessage, StreamEvent, ToolDefinition } from "./types";
import { LLMCaller, LLMResponse } from "./providers";

function stubCaller(text: string, capture?: { systems: string[] }): LLMCaller {
  return {
    call: async (_messages: AgentMessage[], _tools: ToolDefinition[], system: string): Promise<LLMResponse> => {
      capture?.systems.push(system);
      return { text, toolCalls: [], stopReason: "stop" };
    },
  };
}

describe("ModelRouter classification", () => {
  const config = defaultRoutingConfig("anthropic", { apiKey: "k" });
  const router = new ModelRouter(config);

  it("routes short lookups to the fast tier", () => {
    expect(router.classify("where is the auth code?").name).toBe("fast");
  });
  it("routes refactors to the reasoning tier", () => {
    expect(router.classify("refactor the retrieval pipeline to support streaming responses end to end").name).toBe("reasoning");
  });
  it("routes deep conversations to the reasoning tier", () => {
    const history: AgentMessage[] = Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `q${i}` }));
    expect(router.classify("and one more tweak somewhere in the codebase please, this one is mid-length", history).name).toBe("reasoning");
  });
  it("keeps trivial follow-ups on the fast tier even deep into a conversation", () => {
    // Query shape outranks depth — turn 12's "which file has X" must not bill
    // at the reasoning tier just because the chat is long.
    const history: AgentMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `q${i}` }));
    expect(router.classify("which file has the reranker?", history).name).toBe("fast");
  });
  it("defaults middling queries to standard", () => {
    expect(router.classify("update the README section about embeddings with the new defaults").name).toBe("standard");
  });

  it("defaultRoutingConfig honors model overrides", () => {
    const cfg = defaultRoutingConfig("anthropic", { apiKey: "k", standardModel: "my-main", fastModel: "my-fast" });
    expect(cfg.standard.model).toBe("my-main");
    expect(cfg.fast.model).toBe("my-fast");
    expect(cfg.reasoning.model).toBe("claude-opus-4-7");
    expect(() => defaultRoutingConfig("google" as any)).toThrow(/No default routing tiers/);
  });

  it("registerCaller pre-seeds the cache so no real caller is constructed", () => {
    const r = new ModelRouter(defaultRoutingConfig("anthropic", { apiKey: "k" }));
    const stub = stubCaller("hi");
    r.registerCaller("anthropic", "claude-haiku-4-5", stub);
    expect(r.getCaller(config.fast)).toBe(stub);
  });
});

describe("ContextAgent with router + memory", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-agent-")); });
  afterEach(async () => { try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {} });

  function routedAgent(opts: { memory?: SessionMemory; text?: string; capture?: { systems: string[] } }) {
    const router = new ModelRouter(defaultRoutingConfig("anthropic", { apiKey: "k" }));
    const stub = stubCaller(opts.text ?? "All done.", opts.capture);
    for (const m of ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]) {
      router.registerCaller("anthropic", m, stub);
    }
    // No apiKey needed: with a router the fixed caller is never constructed.
    return new ContextAgent({ provider: "anthropic", model: "unused", tools: [], router, memory: opts.memory, memorySource: "test" });
  }

  it("emits model_selected with the routed tier and completes without a fixed caller", async () => {
    const agent = routedAgent({});
    const events: StreamEvent[] = [];
    const answer = await agent.run("where is the auth code?", { onStream: (e) => events.push(e) });
    expect(answer).toBe("All done.");
    const selected = events.find(e => e.type === "model_selected");
    expect(selected?.tier?.name).toBe("fast");
    expect(selected?.tier?.model).toBe("claude-haiku-4-5");
  });

  it("injects remembered facts into the system prompt and extracts new ones from answers", async () => {
    const memory = new SessionMemory({ storePath: dir });
    memory.add({ kind: "codebase_insight", content: "Retrieval fuses vector and bm25 scores with reciprocal rank fusion", source: "test", tags: ["retrieval", "fusion"] });

    const capture = { systems: [] as string[] };
    const agent = routedAgent({
      memory,
      capture,
      text: "I found that the codebase uses sqlite-vec for vector storage in the retrieval layer.",
    });
    await agent.run("how does retrieval fusion work?", { onStream: () => {} });

    // Inbound: the relevant memory rode along in the system prompt.
    expect(capture.systems[0]).toContain("Remembered Context");
    expect(capture.systems[0]).toContain("reciprocal rank fusion");

    // Outbound: the answer's insight was harvested into memory.
    const insights = memory.getByKind("codebase_insight").map(m => m.content);
    expect(insights.some(c => c.includes("sqlite-vec"))).toBe(true);
  });

  it("works without router or memory exactly as before (fixed caller path requires a key)", () => {
    // Stash the env key so this asserts the code path, not the CI machine's env.
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new ContextAgent({ provider: "anthropic", model: "m", tools: [] })).toThrow(/Missing API key/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe("SessionMemory", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-mem-")); });
  afterEach(async () => { try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {} });

  it("persists across instances", () => {
    const a = new SessionMemory({ storePath: dir });
    a.add({ kind: "fact", content: "The CLI binary is called oce", source: "test", tags: ["cli"] });
    const b = new SessionMemory({ storePath: dir });
    expect(b.getAll()).toHaveLength(1);
    expect(b.retrieve("what is the cli binary?")[0]?.content).toContain("oce");
  });

  it("formatForSystemPrompt stays within budget and returns empty when nothing matches", () => {
    const m = new SessionMemory({ storePath: dir });
    expect(m.formatForSystemPrompt("anything")).toBe("");
    m.add({ kind: "fact", content: "Indexing uses bounded windows of fortyeight files", source: "t", tags: ["indexing"] });
    const out = m.formatForSystemPrompt("how does indexing batch files?");
    expect(out).toContain("Remembered Context");
    expect(out.length).toBeLessThanOrEqual(2000);
  });

  it("extractFacts dedupes repeated insights", () => {
    const m = new SessionMemory({ storePath: dir });
    const text = "I found that the project uses tree-sitter for chunking code into symbols.";
    const first = m.extractFacts(text, "t");
    const second = m.extractFacts(text, "t");
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
  });

  it("does not truncate filenames at the dot (the fabricated-path bug)", () => {
    const m = new SessionMemory({ storePath: dir });
    const added = m.extractFacts("I found that the embedding logic lives in src/core/embedder.ts and batches by character budget.", "t");
    expect(added).toHaveLength(1);
    expect(added[0].content).toContain("embedder.ts");
    expect(added[0].content).toContain("character budget");
  });

  it("skips negated/conditional statements", () => {
    const m = new SessionMemory({ storePath: dir });
    const added = m.extractFacts("You should check whether the codebase uses websockets for live updates somewhere.", "t");
    expect(added).toHaveLength(0);
  });

  it("never persists secret-shaped content", () => {
    const m = new SessionMemory({ storePath: dir });
    // Fixtures are deliberately fake-prefixed (GitHub push protection rejects
    // real vendor key shapes even in tests) but still match our filter.
    const keyish = m.extractFacts("I found that the project uses billing with key pa_FAKEFAKEFAKEFAKEFAKE1234 in the checkout flow.", "t");
    expect(keyish).toHaveLength(0);
    const assignish = m.extractFacts("I found that the project uses a config where api_key = supersecretvalue123 for the embedder.", "t");
    expect(assignish).toHaveLength(0);
    expect(m.getAll()).toHaveLength(0);
  });

  it("treats paraphrases as duplicates without renewing the original's TTL", () => {
    const m = new SessionMemory({ storePath: dir });
    const first = m.extractFacts("I found that the project uses tree-sitter for chunking code into symbols.", "t");
    expect(first).toHaveLength(1);
    const originalCreatedAt = first[0].createdAt;
    const again = m.extractFacts("I noticed that the project uses tree-sitter for chunking the code into symbols cleanly.", "t");
    expect(again).toHaveLength(0);
    expect(m.getAll()).toHaveLength(1);
    expect(m.getAll()[0].createdAt).toBe(originalCreatedAt);
  });

  it("does not harvest from code fences", () => {
    const m = new SessionMemory({ storePath: dir });
    const added = m.extractFacts("Here is the diff:\n```md\nI found that the project uses something entirely fabricated here.\n```\nDone.", "t");
    expect(added).toHaveLength(0);
  });

  it("clearAll wipes entries and persists", () => {
    const m = new SessionMemory({ storePath: dir });
    m.add({ kind: "fact", content: "The CLI binary is called oce and ships via npm", source: "t", tags: [] });
    expect(m.clearAll()).toBe(1);
    expect(new SessionMemory({ storePath: dir }).getAll()).toHaveLength(0);
  });

  it("hedges the remembered-context header", () => {
    const m = new SessionMemory({ storePath: dir });
    m.add({ kind: "fact", content: "Indexing uses bounded windows of fortyeight files", source: "t", tags: ["indexing"] });
    expect(m.formatForSystemPrompt("how does indexing batch files?")).toMatch(/may be stale/);
  });
});
