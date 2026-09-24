// Print one Trace TUI frame with realistic data, without taking over the
// terminal. Useful for reviewing layout and colour in a diff-able way:
//
//   npm run build && node scripts/tui-preview.js [columns] [rows]
//
// Requires `npm run build` first (it loads from dist/).

const { renderFrame } = require("../dist/trace/tui/frame");
const { Theme } = require("../dist/trace/tui/theme");
const { reduce, initialState } = require("../dist/trace/view-model");

const columns = Number(process.argv[2]) || Math.min(process.stdout.columns || 120, 120);
const rows = Number(process.argv[3]) || 34;

let seq = 0;
const events = [];
const push = (event) => events.push({ seq: ++seq, ts: "", sessionId: "demo", event });

push({
  type: "session",
  meta: {
    id: "demo", title: "demo", workspace: "/home/dev/open-context-engine",
    provider: "anthropic", model: "claude-opus-5", mode: "suggest",
    windowTokens: 200_000, indexedChunks: 4812, searchMode: "hybrid",
    indexFresh: true, auditing: true, turn: 1, startedAt: "",
  },
});
push({
  type: "plan",
  steps: [
    { step: "Find where search decides to degrade", status: "completed" },
    { step: "Check how the binding failure is classified", status: "in_progress" },
    { step: "Propose a diagnostic that names the reason", status: "pending" },
  ],
});
push({ type: "turn_start", turn: 1, prompt: "why does hybrid search fall back to keyword-only on this box?" });
push({
  type: "retrieval",
  trace: {
    id: "r1", query: "hybrid search fallback", durationMs: 251, searchMode: "hybrid",
    signals: [], graphAdded: 2, droppedChunks: 3, totalChars: 18_400, stages: [],
    chunks: [{ rank: 1, path: "src/core/retriever.ts", startLine: 118, endLine: 160, score: 0.94, via: "hybrid", preview: "", tokens: 900 }],
  },
});
push({ type: "tool_call", call: { id: "c1", name: "read-file", arguments: { path: "src/core/retriever.ts" } } });
push({ type: "tool_result", id: "c1", name: "read-file", ok: true, ms: 221, chars: 17_000 });
push({
  type: "text",
  text: `Because **sqlite-vec** failed to load its native binding, and the retriever degrades instead of throwing.

The decision happens in \`src/core/retriever.ts:118\` — vector search is skipped entirely when the extension is unavailable:

\`\`\`ts src/core/retriever.ts
let vectorHits: SearchResult[] = [];
if (this.store.isVectorAvailable()) {
  vectorHits = this.store.vectorSearch(queryVec, candidateK);
}
\`\`\`

- \`src/core/sqlite-store.ts:64\` decides availability at open time
- \`src/core/native-binding-error.ts:9\` classifies why the load failed`,
});
push({
  type: "context",
  snapshot: {
    windowTokens: 200_000,
    usedTokens: 46_800,
    buckets: { retrieval: 21_000, files: 12_400, history: 8_000, system: 5_400, tools: 0 },
    entries: [
      { id: "a", bucket: "retrieval", label: "src/core/retriever.ts", lines: "118-160", score: 0.94, tokens: 900, pinned: true, evicted: false, turn: 1, edges: [{ kind: "called-by", label: "src/core/search.ts" }] },
      { id: "b", bucket: "retrieval", label: "src/core/sqlite-store.ts", lines: "64-102", score: 0.91, tokens: 760, pinned: false, evicted: false, turn: 1 },
      { id: "c", bucket: "retrieval", label: "src/core/native-binding-error.ts", lines: "9-44", score: 0.77, tokens: 540, pinned: false, evicted: false, turn: 1 },
      { id: "d", bucket: "retrieval", label: "src/core/diagnostics.ts", lines: "41-60", score: 0.62, tokens: 320, pinned: false, evicted: false, turn: 1 },
      { id: "e", bucket: "retrieval", label: "src/core/embedder.ts", lines: "203-240", score: 0.38, tokens: 280, pinned: false, evicted: true, turn: 1 },
    ],
  },
});
push({ type: "usage", usage: { inputTokens: 18_240, outputTokens: 1_412 } });
push({
  type: "turn_end",
  turn: 1,
  stats: { steps: 3, llmCalls: 3, toolCalls: 2, toolErrors: 0, usage: { inputTokens: 18_240, outputTokens: 1_412 }, durationMs: 4_100 },
});
push({
  type: "checkpoint",
  checkpoint: { seq: 1, hash: "9b02" + "0".repeat(60), prev: "", short: "9b02", ts: "", label: "why", turn: 1, filesTouched: 1, restorable: true },
});
push({
  type: "approval_request",
  request: {
    id: "ap-1",
    call: { id: "e1", name: "str-replace", arguments: {} },
    title: "edit src/core/native-binding-error.ts",
    preview: [
      "--- a/src/core/native-binding-error.ts",
      "+++ b/src/core/native-binding-error.ts",
      "@@ -9,4 +9,5 @@",
      "   if (!vecLoaded) {",
      '-    log.warn("vec unavailable");',
      "+    log.warn(`vec unavailable: ${reason}`);",
      '+    diagnostics.record("degraded", reason);',
      "   }",
    ].join("\n"),
    kind: "edit",
    risk: 0.34,
    callers: 3,
  },
});

let state = events.reduce((s, envelope) => reduce(s, { type: "event", envelope }), initialState);
state = reduce(state, { type: "connection", connected: true });

// Piping into `head` closes stdout early; that is expected, not a crash.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  throw err;
});

const theme = new Theme({ truecolor: process.env.NO_COLOR ? undefined : true, mono: !!process.env.NO_COLOR });
for (const line of renderFrame(state, { columns, rows }, theme, { railOpen: true })) {
  process.stdout.write(line + "\n");
}
