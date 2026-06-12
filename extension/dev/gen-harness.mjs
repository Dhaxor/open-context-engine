// Generate dev/harness.html — the REAL webview bundle (dist/webview.js/.css)
// running in a plain browser with a mocked acquireVsCodeApi and a scripted
// conversation, so UI work can be screenshotted and iterated outside VS Code.
//
//   node dev/gen-harness.mjs && python3 -m http.server 8765 --directory dev
//   open http://localhost:8765/harness.html?scene=convo   (also: welcome, stream)
import { buildSync } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");

// chatBody lives in a TS module — bundle it to CJS and require it.
buildSync({
  entryPoints: [path.join(ext, "src/chat/chat-html.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: path.join(here, "_chat-html.cjs"),
  logLevel: "silent",
});
const { chatBody } = createRequire(import.meta.url)(path.join(here, "_chat-html.cjs"));

const css = fs.readFileSync(path.join(ext, "dist/webview.css"), "utf8");
const js = fs.readFileSync(path.join(ext, "dist/webview.js"), "utf8");

// VS Code "Dark Modern" variable set — every --vscode-* var styles.css consumes.
const THEME_DARK = `
  --vscode-font-family: "Segoe WPC","Segoe UI",sans-serif;
  --vscode-editor-font-family: Consolas,"Courier New",monospace;
  --vscode-sideBar-background: #181818;
  --vscode-editor-background: #1f1f1f;
  --vscode-foreground: #cccccc;
  --vscode-editor-foreground: #d4d4d4;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-icon-foreground: #c5c5c5;
  --vscode-panel-border: #2b2b2b;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #989898;
  --vscode-focusBorder: #0078d4;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-textLink-foreground: #4daafc;
  --vscode-textCodeBlock-background: #1f1f1f;
  --vscode-errorForeground: #f85149;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-green: #2ea043;
  --vscode-charts-yellow: #d7a31a;
  --vscode-terminal-ansiBlue: #569cd6;
  --vscode-terminal-ansiGreen: #6a9955;
  --vscode-terminal-ansiCyan: #4ec9b0;
  --vscode-terminal-ansiMagenta: #c586c0;
  --vscode-terminal-ansiRed: #ce9178;
  --vscode-terminal-ansiYellow: #dcdcaa;
`;

const SCENARIO = `
const send = (m) => window.postMessage(m, "*");
const scene = new URLSearchParams(location.search).get("scene") || "convo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamText(text, step = 24) {
  for (let i = 0; i < text.length; i += step) { send({ type: "chunk", text: text.slice(i, i + step) }); await sleep(4); }
}

const MD_ANSWER = [
  "Hybrid retrieval in this codebase fuses two independent rankers over the same chunk store:",
  "",
  "1. **Vector search** — \`chunks_vec\` (sqlite-vec, cosine) finds semantically similar chunks even when the wording differs.",
  "2. **BM25** — \`chunks_fts\` (FTS5, porter stemming) catches exact identifiers like \`reciprocalRankFusion\` that embeddings can miss.",
  "",
  "The two lists are merged with **Reciprocal Rank Fusion** in src/core/retriever.ts:130, then boosted by symbol matches, editor context and git recency:",
  "",
  "\\\`\\\`\\\`ts src/core/retriever.ts",
  "const fused = reciprocalRankFusion([",
  "  { results: vectorHits, weight: search.vectorWeight ?? 1.0 },",
  "  { results: bm25Hits, weight: search.bm25Weight ?? 1.0 },",
  "], candidateK);",
  "\\\`\\\`\\\`",
  "",
  "Finally the top results are *graph-expanded* — callers and callees pulled in via \`graph_edges\` — and packed into the context window.",
].join("\\n");

async function run() {
  send({ type: "model", provider: "anthropic", model: "claude-sonnet-4-6" });
  send({ type: "license", status: { plan: "free", valid: false } });
  send({ type: "context", activeFile: "src/core/retriever.ts", hasSelection: true });
  if (scene === "welcome") return;

  send({ type: "addUserMessage", text: "How does hybrid retrieval work in this codebase?" });
  await sleep(60);
  send({ type: "tool_update", id: "t1", name: "codebase-retrieval", status: "running", label: "Searching codebase: hybrid retrieval rrf fusion" });
  await sleep(350);
  send({ type: "tool_update", id: "t1", name: "codebase-retrieval", status: "complete", label: "Searched codebase · 8 chunks from 4 files", args: { query: "hybrid retrieval rrf fusion", topK: 8 } });
  await streamText(MD_ANSWER);
  send({ type: "sources", files: [
    { path: "src/core/retriever.ts", lines: "112-161" },
    { path: "src/core/sqlite-store.ts", lines: "345-387" },
    { path: "src/core/graph-expander.ts", lines: "25-70" },
  ]});
  send({ type: "done" });
  await sleep(80);

  send({ type: "addUserMessage", text: "Rename candidateK to poolSize in the retriever" });
  await sleep(60);
  send({ type: "edit", edit: { id: "e1", kind: "str-replace", path: "src/core/retriever.ts", replacedOccurrences: 4,
    diff: "@@ -110,7 +110,7 @@\\n-  const candidateK = opts.topK != null ? Math.max(opts.topK * 4, 40) : 60;\\n+  const poolSize = opts.topK != null ? Math.max(opts.topK * 4, 40) : 60;\\n   const finalK = opts.topK ?? this.search.topK;" } });
  await sleep(60);
  send({ type: "edit_summary", ids: ["e1"] });
  await streamText("Renamed \`candidateK\` to \`poolSize\` across the retriever — 4 occurrences in src/core/retriever.ts. The eval suite still passes (278/278).");
  if (scene === "stream") return; // leave the last bubble streaming with cursor
  send({ type: "done" });
}
window.addEventListener("load", () => { setTimeout(run, 30); });
`;

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>OCE webview harness</title>
<style>
  :root { ${THEME_DARK} }
  html, body { margin: 0; padding: 0; }
  /* Mimic the sidebar: fixed width column like a real VS Code side panel. */
  body { width: 400px; height: 100vh; margin: 0 auto; outline: 1px solid #000; }
</style>
<style>${css}</style>
</head>
<body>
${chatBody}
<script>
  window.acquireVsCodeApi = () => ({ postMessage: (m) => console.log("[webview->host]", m) });
</script>
<script>${js}</script>
<script>${SCENARIO}</script>
</body>
</html>`;

fs.writeFileSync(path.join(here, "harness.html"), html);
fs.rmSync(path.join(here, "_chat-html.cjs"), { force: true });
console.log("wrote dev/harness.html (" + Math.round(html.length / 1024) + " KB)");
