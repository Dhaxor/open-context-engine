// Studio demo harness — runs Trace against a scripted stub agent.
//
// Lets the UI be developed and reviewed without an API key, an index, or a
// paid round-trip, and gives a stable scene for screenshots. It drives the
// REAL TraceSession and the REAL server, so what you see is what ships; only
// the model is faked.
//
//   npm run build && node scripts/studio-demo.js
//
// Requires `npm run build` first (it loads from dist/).

const path = require("path");

const { TraceSession } = require("../dist/trace/session");
const { ContextLedger } = require("../dist/trace/ledger");
const { CheckpointStore } = require("../dist/trace/checkpoints");
const { startTraceServer } = require("../dist/trace/server");
const { AgentPlan } = require("../dist/agent/plan");
const { PermissionManager } = require("../dist/agent/permissions");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const files = new Map([
  ["src/core/retriever.ts", "const vecLoaded = false;"],
  ["src/core/native-binding-error.ts", "export function classify() {}"],
]);

const applier = {
  async readFile(p) { return files.has(p) ? files.get(p) : null; },
  async writeFile(p, c) { files.set(p, c); },
  async removeFile(p) { return files.delete(p); },
  async fileExists(p) { return files.has(p); },
};

/** Realistic retrieval report — the shape ContextEngine.searchTraced returns. */
function report(query, rows) {
  return {
    query,
    signals: ["hybrid", "search", "degrade"],
    vectorHits: rows.slice(0, 3).map(toItem),
    bm25Hits: rows.slice(0, 2).map(toItem),
    fused: rows.map(toItem),
    ranked: rows.map(toItem),
    expanded: rows.filter((r) => r.reason).map(toItem),
    final: rows.map(toItem),
    finalResults: rows.map((r) => ({
      chunk: {
        id: `${r.path}:${r.start}`, path: r.path, startLine: r.start, endLine: r.end,
        contents: `// ${r.path}\n`.repeat(30), language: "ts",
      },
      score: r.score,
    })),
    packing: { includedFiles: rows.length, includedChunks: rows.length, droppedChunks: 3, totalChars: 18_400, decisions: [], preview: "" },
  };
}

let rank = 0;
function toItem(r) {
  return {
    rank: ++rank % 100, path: r.path, lines: `${r.start}-${r.end}`, score: r.score,
    vectorScore: r.score * 0.9, bm25Score: r.score * 4,
    symbolName: r.symbol, reason: r.reason, preview: `// ${r.path}`,
  };
}

const ROWS = [
  { path: "src/core/retriever.ts", start: 118, end: 160, score: 0.94, symbol: "retrieve" },
  { path: "src/core/sqlite-store.ts", start: 64, end: 102, score: 0.91, symbol: "isVectorAvailable" },
  { path: "src/core/native-binding-error.ts", start: 9, end: 44, score: 0.77, symbol: "classifyNativeBindingError" },
  { path: "src/core/diagnostics.ts", start: 41, end: 60, score: 0.62, reason: "src/core/search.ts:hybridSearch calls this" },
  { path: "src/core/embedder.ts", start: 203, end: 240, score: 0.38, reason: "imports src/core/types.ts:EmbeddingConfig" },
];

const ANSWER = `Because **sqlite-vec** failed to load its native binding, and the retriever degrades instead of throwing.

The decision happens in \`src/core/retriever.ts:118\` — the vector search is skipped entirely when the extension is unavailable, so ranking falls back to BM25 alone:

\`\`\`ts src/core/retriever.ts
let vectorHits: SearchResult[] = [];
if (this.store.isVectorAvailable()) {
  vectorHits = this.store.vectorSearch(queryVec, candidateK, opts.pathPrefix);
}
\`\`\`

The short-circuit sits *before* the query embed on purpose — an empty vectorSearch would still spend an embedding call with nothing to consume it.

- \`src/core/sqlite-store.ts:64\` decides availability at open time
- \`src/core/native-binding-error.ts:9\` classifies why the load failed
- the mode is surfaced on every search result, so nothing silently degrades`;

class ScriptedAgent {
  constructor() { this.messages = []; }
  getMessages() { return this.messages; }
  loadMessages(m) { this.messages = [...m]; }
  exportSession() { return JSON.stringify({ version: 1, messages: this.messages }); }
  reset() { this.messages = []; }
  async compact() { return { dropped: 4, summarized: true }; }

  async run(query, opts = {}) {
    const emit = (e) => opts.onStream && opts.onStream(e);
    this.messages.push({ role: "user", content: query });

    emit({ type: "tool_call", toolCall: { id: "call-1", name: "codebase-retrieval", arguments: { information_request: query } } });
    await sleep(400);
    this.onRetrieval && this.onRetrieval({
      query,
      report: report(query, ROWS),
      durationMs: 251,
      stages: [
        { stage: "bm25", ms: 3, count: 40 },
        { stage: "vector", ms: 180, count: 40 },
        { stage: "fused", ms: 190, count: 60 },
        { stage: "reranked", ms: 248, count: 15 },
      ],
    });
    emit({ type: "tool_result", toolResult: { id: "call-1", name: "codebase-retrieval", result: "x".repeat(31_000) } });
    this.messages.push({ role: "tool", content: "x".repeat(31_000), toolCallId: "call-1", toolName: "codebase-retrieval" });

    await sleep(200);
    emit({ type: "tool_call", toolCall: { id: "call-2", name: "read-file", arguments: { path: "src/core/retriever.ts" } } });
    await sleep(220);
    emit({ type: "tool_result", toolResult: { id: "call-2", name: "read-file", result: "y".repeat(17_000) } });

    // A delegation, streamed the way the real observer republishes one.
    if (this.onDelegation) {
      const d = this.onDelegation;
      d.start("sub-1", "map every caller of isVectorAvailable and how they handle false");
      await sleep(300);
      d.event("sub-1", { type: "tool_call", toolCall: { id: "s1", name: "find-symbol-references", arguments: {} } });
      await sleep(260);
      d.event("sub-1", { type: "tool_result", toolResult: { id: "s1", name: "find-symbol-references", result: "z".repeat(4200) } });
      await sleep(200);
      d.event("sub-1", { type: "text", text: "Three callers. Two treat false as fatal; sqlite-store.ts degrades." });
      await sleep(200);
      d.end("sub-1", { ok: true, chars: 820, ms: 1160 });
    }

    // Stream the answer the way a provider does.
    for (const word of ANSWER.split(/(\s+)/)) {
      if (opts.signal && opts.signal.aborted) throw new Error("aborted");
      emit({ type: "text", text: word });
      await sleep(6);
    }

    emit({ type: "usage", usage: { inputTokens: 18_240, outputTokens: 1_412 } });
    emit({
      type: "run_end",
      stats: { steps: 3, llmCalls: 3, toolCalls: 2, toolErrors: 0, usage: { inputTokens: 18_240, outputTokens: 1_412 }, durationMs: 4_100 },
    });
    return "done";
  }
}

async function main() {
  const agent = new ScriptedAgent();
  const plan = new AgentPlan();
  const permissions = new PermissionManager({ mode: "suggest" });
  // Without this the manager treats str-replace as read-only and never asks,
  // so the approval card would silently never appear.
  permissions.registerMutatingTools(["str-replace", "create-file", "remove-file", "run-command"]);
  const ledger = new ContextLedger({
    windowTokens: 200_000,
    // Roughly the real system prompt plus environment facts, so the budget
    // meter shows a believable composition rather than one giant bucket.
    systemPrompt: () => "s".repeat(9_600),
    toolSchemas: () => [{ name: "codebase-retrieval" }, { name: "read-file" }, { name: "str-replace" }],
  });
  const checkpoints = new CheckpointStore({ applier });

  const session = new TraceSession({
    id: "demo",
    agent,
    plan,
    permissions,
    ledger,
    checkpoints,
    meta: {
      id: "demo", title: "demo", workspace: process.cwd(),
      provider: "anthropic", model: "claude-opus-5",
      windowTokens: 200_000, indexedChunks: 4_812,
      searchMode: "hybrid", indexFresh: true, auditing: true,
    },
    callersOf: () => 3,
    listFiles: () => [
      "src/core/retriever.ts", "src/core/sqlite-store.ts", "src/core/native-binding-error.ts",
      "src/core/diagnostics.ts", "src/core/embedder.ts", "src/trace/session.ts",
      "src/trace/server.ts", "src/cli/index.ts", "README.md",
    ],
    readFile: async (p) => (files.has(p) ? files.get(p) : `// ${p}\nexport const demo = true;\n`),
    runCommand: async (command) => `$ ${command}\n\n  ✓ 828 tests passed\n`,
  });
  agent.onRetrieval = session.observeRetrieval;
  agent.onDelegation = session.delegateObserver;

  // A registry with sibling sessions, so the switcher has something to show.
  const { SessionRegistry } = require("../dist/trace/registry");
  let siblings = 0;
  const registry = new SessionRegistry({
    build: async ({ id }) => {
      siblings++;
      const sib = new TraceSession({
        id, agent: new ScriptedAgent(), plan: new AgentPlan(),
        permissions: new PermissionManager({ mode: "suggest" }),
        ledger: new ContextLedger({ windowTokens: 200_000, systemPrompt: () => "", toolSchemas: () => [] }),
        checkpoints: new CheckpointStore({ applier }),
        meta: { ...session.meta(), id, title: `sibling ${siblings}` },
      });
      return { session: sib, close: async () => {} };
    },
    worktrees: {
      isRepo: async () => true,
      list: async () => [{ path: process.cwd(), branch: "main", main: true }],
      create: async (branch) => ({ ok: true, worktree: { path: `/tmp/wt/${branch.replace(/\//g, "-")}`, branch, main: false } }),
      remove: async () => ({ ok: true }),
      changedFiles: async () => ["src/core/retriever.ts"],
      prune: async () => {},
      currentBranch: async () => "main",
      review: async () => ({
        files: ["src/core/retriever.ts"],
        untracked: ["src/core/degraded-mode.ts"],
        diff: [
          "--- a/src/core/retriever.ts",
          "+++ b/src/core/retriever.ts",
          "@@ -116,6 +116,9 @@",
          "   let vectorHits: SearchResult[] = [];",
          "   if (this.store.isVectorAvailable()) {",
          "-    vectorHits = this.store.vectorSearch(queryVec, candidateK);",
          "+    vectorHits = this.store.vectorSearch(queryVec, candidateK, opts.pathPrefix);",
          "+  } else {",
          "+    diagnostics.record(\"degraded\", this.store.getVectorDiagnosis());",
          "   }",
        ].join("\n"),
        stat: { files: 1, added: 3, removed: 1 },
      }),
      land: async () => ({ ok: true }),
    },
  });
  registry.adopt("demo", { session, close: async () => {} }, {
    title: "main", workspace: process.cwd(), branch: "main",
  });

  const server = await startTraceServer({
    session,
    registry,
    port: Number(process.env.PORT || 4319),
    token: process.env.TOKEN || "demo-token",
    staticDir: path.join(__dirname, "..", "dist", "trace", "studio"),
    onLog: (m) => console.log(m),
  });

  console.log(`\n  Trace demo  ${server.url}\n`);

  if (process.env.AUTORUN !== "0") {
    // Two sibling sessions so the switcher is populated on first paint.
    await registry.create("fix the auth flow");
    await registry.create("upgrade tree-sitter");
    registry.setActive("demo");

    plan.set([
      { step: "Find where search decides to degrade", status: "completed" },
      { step: "Check how the native binding failure is classified", status: "in_progress" },
      { step: "Propose a diagnostic that names the reason", status: "pending" },
    ]);
    await session.prompt("why does hybrid search fall back to keyword-only on this box?");

    // A pending approval, so the patch card is on screen for review.
    await sleep(300);
    void permissions.check({
      id: "edit-1",
      name: "str-replace",
      arguments: {
        path: "src/core/native-binding-error.ts",
        old_str: 'log.warn("vec unavailable");',
        new_str: 'log.warn(`vec unavailable: ${reason}`);\n  diagnostics.record("degraded", reason);',
      },
    });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
