import { describe, it, expect } from "vitest";
import { AgentMessage } from "../agent/types";
import { SearchResult } from "../core/types";
import { RetrievalTrace, RetrievedChunk } from "./protocol";
import { ContextLedger } from "./ledger";

function chunk(path: string, id: string, over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    rank: 1, chunkId: id, path, startLine: 1, endLine: 20,
    score: 0.9, via: "hybrid", preview: "…", tokens: 100, ...over,
  };
}

function result(path: string, id: string, contents = "const a = 1;"): SearchResult {
  return { chunk: { id, path, startLine: 1, endLine: 20, contents }, score: 0.9 };
}

function trace(over: Partial<RetrievalTrace> = {}): RetrievalTrace {
  return {
    id: "t1", query: "how does search degrade", toolCallId: "call-1",
    chunks: [], stages: [], durationMs: 10, searchMode: "hybrid",
    signals: [], graphAdded: 0, droppedChunks: 0, totalChars: 0, ...over,
  };
}

function ledger(over: Partial<ConstructorParameters<typeof ContextLedger>[0]> = {}) {
  return new ContextLedger({
    windowTokens: 200_000,
    systemPrompt: () => "x".repeat(400),
    toolSchemas: () => [{ name: "t" }],
    ...over,
  });
}

describe("ContextLedger accounting", () => {
  it("buckets retrieval, files, system and tools separately", () => {
    const l = ledger();
    l.noteRetrieval(
      trace({ chunks: [chunk("src/a.ts", "a1", { tokens: 300 }), chunk("src/b.ts", "b1", { tokens: 200 })] }),
      [result("src/a.ts", "a1"), result("src/b.ts", "b1")],
    );
    l.noteFileRead("call-2", "src/c.ts", "y".repeat(800));

    const snap = l.snapshot([]);
    expect(snap.buckets.retrieval).toBe(500);
    expect(snap.buckets.files).toBe(200);
    expect(snap.buckets.system).toBe(100);
    expect(snap.buckets.tools).toBeGreaterThan(0);
    expect(snap.usedTokens).toBe(
      snap.buckets.retrieval + snap.buckets.files + snap.buckets.system + snap.buckets.tools + snap.buckets.history,
    );
  });

  it("does not double-count tool results it already attributed", () => {
    const l = ledger();
    l.noteRetrieval(trace({ chunks: [chunk("src/a.ts", "a1", { tokens: 300 })] }), [result("src/a.ts", "a1")]);
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      { role: "tool", content: "z".repeat(4000), toolCallId: "call-1", toolName: "codebase-retrieval" },
    ];
    const snap = l.snapshot(messages);
    // The 4000-char tool result is retrieval, not history: counting it in both
    // would show a window fuller than it is.
    expect(snap.buckets.retrieval).toBe(300);
    expect(snap.buckets.history).toBeLessThan(20);
  });

  it("stops counting an evicted entry", () => {
    const l = ledger();
    l.noteRetrieval(trace({ chunks: [chunk("src/a.ts", "a1", { tokens: 300 })] }), [result("src/a.ts", "a1")]);
    const id = l.snapshot([]).entries[0].id;
    expect(l.snapshot([]).buckets.retrieval).toBe(300);
    l.evict(id);
    expect(l.snapshot([]).buckets.retrieval).toBe(0);
    l.restore(id);
    expect(l.snapshot([]).buckets.retrieval).toBe(300);
  });

  it("keeps pin and evict state when the same chunk is retrieved again", () => {
    const l = ledger();
    l.noteRetrieval(trace({ chunks: [chunk("src/a.ts", "a1")] }), [result("src/a.ts", "a1")]);
    const id = l.snapshot([]).entries[0].id;
    l.evict(id);
    l.setTurn(2);
    l.noteRetrieval(trace({ chunks: [chunk("src/a.ts", "a1")] }), [result("src/a.ts", "a1")]);
    expect(l.getEntry(id)?.evicted).toBe(true);
  });

  it("ranks the snapshot by recency then score", () => {
    const l = ledger();
    l.setTurn(1);
    l.noteRetrieval(trace({ toolCallId: "c1", chunks: [chunk("old.ts", "o1", { score: 0.99 })] }), [result("old.ts", "o1")]);
    l.setTurn(2);
    l.noteRetrieval(trace({
      toolCallId: "c2",
      chunks: [chunk("low.ts", "l1", { score: 0.2 }), chunk("high.ts", "h1", { score: 0.8 })],
    }), [result("low.ts", "l1"), result("high.ts", "h1")]);
    expect(l.snapshot([]).entries.map(e => e.label)).toEqual(["high.ts", "low.ts", "old.ts"]);
  });
});

describe("ContextLedger eviction rewrites history", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "why" },
    { role: "tool", content: "ORIGINAL SEARCH OUTPUT", toolCallId: "call-1", toolName: "codebase-retrieval" },
  ];

  it("re-renders the remaining chunks through the real formatter", () => {
    const l = ledger();
    l.noteRetrieval(
      trace({ chunks: [chunk("keep.ts", "k1"), chunk("drop.ts", "d1")] }),
      [result("keep.ts", "k1", "KEEP CONTENTS"), result("drop.ts", "d1", "DROP CONTENTS")],
    );
    const dropId = l.snapshot([]).entries.find(e => e.label === "drop.ts")!.id;
    l.evict(dropId);

    const out = l.rewrite(messages);
    const tool = out[1].content;
    expect(tool).toContain("KEEP CONTENTS");
    expect(tool).not.toContain("DROP CONTENTS");
    expect(tool).toContain("1 result evicted");
  });

  it("leaves untouched results byte-identical", () => {
    const l = ledger();
    l.noteRetrieval(trace({ chunks: [chunk("keep.ts", "k1")] }), [result("keep.ts", "k1")]);
    expect(l.rewrite(messages)[1].content).toBe("ORIGINAL SEARCH OUTPUT");
  });

  it("never mutates the caller's messages", () => {
    const l = ledger();
    l.noteRetrieval(trace({ chunks: [chunk("drop.ts", "d1")] }), [result("drop.ts", "d1")]);
    l.evict(l.snapshot([]).entries[0].id);
    l.rewrite(messages);
    expect(messages[1].content).toBe("ORIGINAL SEARCH OUTPUT");
  });

  it("drops the whole result when the source was not retained", () => {
    const l = ledger({ maxRetainedRetrievals: 1 });
    l.noteRetrieval(trace({ toolCallId: "call-1", chunks: [chunk("a.ts", "a1")] }), [result("a.ts", "a1")]);
    l.noteRetrieval(trace({ toolCallId: "call-2", chunks: [chunk("b.ts", "b1")] }), [result("b.ts", "b1")]);
    l.evict(l.snapshot([]).entries.find(e => e.label === "a.ts")!.id);
    // call-1's sources aged out, so an exact re-render is impossible — the
    // result must go entirely rather than leave evicted code in the window.
    expect(l.rewrite(messages)[1].content).toContain("evicted from context");
  });

  it("restoring an eviction leaves no trace of it in the history", () => {
    const l = ledger();
    l.noteRetrieval(
      trace({ chunks: [chunk("keep.ts", "k1"), chunk("drop.ts", "d1")] }),
      [result("keep.ts", "k1", "KEEP CONTENTS"), result("drop.ts", "d1", "DROP CONTENTS")],
    );
    const dropId = l.snapshot([]).entries.find(e => e.label === "drop.ts")!.id;
    l.evict(dropId);
    expect(l.rewrite(messages)[1].content).toContain("evicted");

    l.restore(dropId);
    const after = l.rewrite(messages)[1].content;
    expect(after).not.toContain("evicted");
    expect(after).toContain("DROP CONTENTS");
    expect(after).toContain("KEEP CONTENTS");
  });

  it("restoring an evicted file puts its contents back", () => {
    const l = ledger();
    l.noteFileRead("call-9", "src/c.ts", "FILE BODY");
    const id = l.snapshot([]).entries[0].id;
    const history: AgentMessage[] = [{ role: "tool", content: "FILE BODY", toolCallId: "call-9", toolName: "read-file" }];
    l.evict(id);
    expect(l.rewrite(history)[0].content).toContain("evicted");
    l.restore(id);
    expect(l.rewrite(history)[0].content).toBe("FILE BODY");
  });

  it("evicts a file read as a whole", () => {
    const l = ledger();
    l.noteFileRead("call-9", "src/c.ts", "FILE BODY");
    l.evict(l.snapshot([]).entries[0].id);
    const out = l.rewrite([{ role: "tool", content: "FILE BODY", toolCallId: "call-9", toolName: "read-file" }]);
    expect(out[0].content).toBe("[file contents evicted from context by the user]");
  });
});

describe("ContextLedger pinning", () => {
  it("renders pinned contents for the system prompt", () => {
    const l = ledger();
    l.noteRetrieval(trace({ chunks: [chunk("src/a.ts", "a1")] }), [result("src/a.ts", "a1", "PINNED BODY")]);
    expect(l.pinnedBlock()).toBeNull();
    l.pin(l.snapshot([]).entries[0].id);
    const block = l.pinnedBlock()!;
    expect(block).toContain("Pinned context");
    expect(block).toContain("src/a.ts:1-20");
    expect(block).toContain("PINNED BODY");
  });

  it("pinning an evicted entry brings it back", () => {
    const l = ledger();
    l.noteRetrieval(trace({ chunks: [chunk("src/a.ts", "a1")] }), [result("src/a.ts", "a1")]);
    const id = l.snapshot([]).entries[0].id;
    l.evict(id);
    l.pin(id);
    expect(l.getEntry(id)).toMatchObject({ pinned: true, evicted: false });
  });

  it("clear() forgets everything", () => {
    const l = ledger();
    l.noteRetrieval(trace({ chunks: [chunk("src/a.ts", "a1")] }), [result("src/a.ts", "a1")]);
    l.clear();
    expect(l.snapshot([]).entries).toEqual([]);
    expect(l.pinnedBlock()).toBeNull();
  });
});
