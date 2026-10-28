#!/usr/bin/env node
// Render the REAL agent webview bundles (dist/agent.js, dist/trace-studio.js)
// in a plain browser, against a scripted fake extension host — for screenshots
// and UI iteration without an Extension Development Host or an API key.
//
//   node build.js && node dev/agent-harness.mjs
//   serve extension/dev/ and open:
//     agent-harness.html?scene=welcome|running|done|parallel|setup[&theme=light]
//     studio-harness.html?scene=done
//
// The fake host speaks the same postMessage protocol as TraceBridge
// (src/trace/protocol.ts), so what renders here is what VS Code renders.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");

// A subset of VS Code's Dark Modern / Light Modern theme variables — enough for
// every token the agent UI reads.
const THEMES = {
  dark: {
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-editor-font-family": "Consolas, 'Courier New', monospace",
    "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-sideBar-background": "#181818",
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-editorWidget-background": "#202020",
    "--vscode-widget-border": "#313131",
    "--vscode-focusBorder": "#0078d4",
    "--vscode-textLink-foreground": "#4daafc",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#026ec1",
    "--vscode-button-secondaryBackground": "#313131",
    "--vscode-button-secondaryForeground": "#cccccc",
    "--vscode-button-secondaryHoverBackground": "#3c3c3c",
    "--vscode-input-background": "#313131",
    "--vscode-input-border": "#3c3c3c",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-placeholderForeground": "#989898",
    "--vscode-badge-background": "#616161",
    "--vscode-badge-foreground": "#f8f8f8",
    "--vscode-toolbar-hoverBackground": "rgba(90,93,94,0.31)",
    "--vscode-textCodeBlock-background": "#2b2b2b",
    "--vscode-textPreformat-foreground": "#d0d0d0",
    "--vscode-progressBar-background": "#0078d4",
    "--vscode-editorWarning-foreground": "#cca700",
    "--vscode-errorForeground": "#f85149",
    "--vscode-inputValidation-warningBorder": "#b89500",
    "--vscode-inputValidation-errorBorder": "#be1100",
    "--vscode-testing-iconPassed": "#73c991",
    "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
    "--vscode-gitDecoration-deletedResourceForeground": "#c74e39",
    "--vscode-diffEditor-insertedLineBackground": "rgba(155,185,85,0.2)",
    "--vscode-diffEditor-removedLineBackground": "rgba(255,0,0,0.2)",
    "--vscode-charts-blue": "#3794ff",
    "--vscode-charts-purple": "#b180d7",
    "--vscode-charts-foreground": "#cccccc",
    "--vscode-editorSuggestWidget-background": "#202020",
    "--vscode-editorSuggestWidget-border": "#454545",
    "--vscode-editorSuggestWidget-selectedBackground": "#04395e",
    "--vscode-dropdown-background": "#313131",
    "--vscode-dropdown-foreground": "#cccccc",
    "--vscode-scrollbarSlider-background": "rgba(121,121,121,0.4)",
  },
  light: {
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-editor-font-family": "Consolas, 'Courier New', monospace",
    "--vscode-foreground": "#3b3b3b",
    "--vscode-descriptionForeground": "#717171",
    "--vscode-sideBar-background": "#f8f8f8",
    "--vscode-editor-background": "#ffffff",
    "--vscode-editorWidget-background": "#ffffff",
    "--vscode-widget-border": "#e5e5e5",
    "--vscode-focusBorder": "#005fb8",
    "--vscode-textLink-foreground": "#005fb8",
    "--vscode-button-background": "#005fb8",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#0258a8",
    "--vscode-button-secondaryBackground": "#e5e5e5",
    "--vscode-button-secondaryForeground": "#3b3b3b",
    "--vscode-button-secondaryHoverBackground": "#cccccc",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-border": "#cecece",
    "--vscode-input-foreground": "#3b3b3b",
    "--vscode-input-placeholderForeground": "#767676",
    "--vscode-badge-background": "#cccccc",
    "--vscode-badge-foreground": "#3b3b3b",
    "--vscode-toolbar-hoverBackground": "rgba(184,184,184,0.31)",
    "--vscode-textCodeBlock-background": "#f2f2f2",
    "--vscode-progressBar-background": "#005fb8",
    "--vscode-editorWarning-foreground": "#bf8803",
    "--vscode-errorForeground": "#f85149",
    "--vscode-inputValidation-warningBorder": "#b89500",
    "--vscode-testing-iconPassed": "#388a34",
    "--vscode-gitDecoration-addedResourceForeground": "#587c0c",
    "--vscode-gitDecoration-deletedResourceForeground": "#ad0707",
    "--vscode-diffEditor-insertedLineBackground": "rgba(155,185,85,0.2)",
    "--vscode-diffEditor-removedLineBackground": "rgba(255,0,0,0.2)",
    "--vscode-charts-blue": "#1a85ff",
    "--vscode-charts-purple": "#652d90",
    "--vscode-charts-foreground": "#616161",
    "--vscode-editorSuggestWidget-background": "#f8f8f8",
    "--vscode-editorSuggestWidget-selectedBackground": "#e8e8e8",
    "--vscode-dropdown-background": "#ffffff",
    "--vscode-scrollbarSlider-background": "rgba(100,100,100,0.4)",
  },
};

// The fake host: scenes are scripted TraceEvent streams.
const HOST = String.raw`
(() => {
  const params = new URLSearchParams(location.search);
  const scene = params.get("scene") || "running";
  const now = Date.now();
  const ts = (s = 0) => new Date(now - s * 1000).toISOString();
  const meta = (over = {}) => ({ id: "s1", title: "", workspace: "/home/dev/acme-api", branch: "main", provider: "anthropic",
    model: "claude-opus-5-5", mode: "auto-edit", windowTokens: 200000, indexedChunks: 18432, searchMode: "hybrid",
    indexFresh: true, auditing: false, turn: 2, startedAt: ts(300), ...over });
  const chunk = (path, a, b, score, via, extra = {}) => ({ rank: 1, path, startLine: a, endLine: b, score, via, preview: "", tokens: 420, ...extra });
  const retrieval = (id, query, chunks, ms = 140) => ({ type: "retrieval", trace: { id, toolCallId: id, query, chunks, stages: [], durationMs: ms,
    searchMode: "hybrid", signals: [], graphAdded: 1, droppedChunks: 0, totalChars: 9000 } });
  const context = (used) => ({ type: "context", snapshot: { windowTokens: 200000, usedTokens: used,
    buckets: { retrieval: Math.round(used * 0.46), files: Math.round(used * 0.24), history: Math.round(used * 0.18), system: Math.round(used * 0.08), tools: Math.round(used * 0.04) },
    entries: [
      { id: "e1", bucket: "retrieval", label: "src/auth/session.ts", lines: "40-118", score: 0.91, via: "hybrid", tokens: 1900, pinned: true, evicted: false, turn: 1 },
      { id: "e2", bucket: "retrieval", label: "src/auth/token.ts", lines: "5-22", score: 0.74, via: "graph", edges: [{ kind: "called-by", label: "src/auth/session.ts" }], tokens: 640, pinned: false, evicted: false, turn: 1 },
      { id: "e3", bucket: "retrieval", label: "src/api/client.ts", lines: "12-30", score: 0.61, via: "bm25", tokens: 520, pinned: false, evicted: false, turn: 2 },
      { id: "e4", bucket: "files", label: "src/auth/session.test.ts", score: undefined, tokens: 2100, pinned: false, evicted: true, turn: 2 },
    ] } });
  const diff1 = "--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -58,7 +58,9 @@ export class Session {\n   private schedule(token: Token) {\n-    const exp = token.issuedAt + token.ttl * 1000;\n+    // ttl is in seconds; issuedAt is ms. Refresh a minute early.\n+    const exp = token.issuedAt + token.ttl * 1000 - REFRESH_SKEW_MS;\n     this.timer = setTimeout(() => this.refresh(), exp - Date.now());\n   }";
  const diff2 = "--- a/src/auth/session.test.ts\n+++ b/src/auth/session.test.ts\n@@ -40,3 +40,9 @@\n+  it(\"refreshes before expiry\", () => {\n+    const s = new Session(clock);\n+    s.start(token({ ttl: 3600 }));\n+    clock.advance(3540_000);\n+    expect(s.refreshed).toBe(true);\n+  });";

  const turn1 = [
    { type: "turn_start", turn: 1, prompt: "Where is token refresh scheduled?" },
    { type: "phase", phase: "retrieving", detail: "token refresh schedule" },
    { type: "tool_call", call: { id: "c1", name: "codebase-retrieval", arguments: { information_request: "token refresh schedule" } } },
    retrieval("c1", "token refresh schedule", [chunk("src/auth/session.ts", 40, 118, 0.91, "hybrid"), chunk("src/auth/token.ts", 5, 22, 0.74, "graph"), chunk("src/api/client.ts", 12, 30, 0.61, "bm25")]),
    { type: "tool_result", id: "c1", name: "codebase-retrieval", ok: true, ms: 140, chars: 9000 },
    { type: "tool_call", call: { id: "c2", name: "read-file", arguments: { path: "src/auth/session.ts", start_line: 40, end_line: 118 } } },
    { type: "tool_result", id: "c2", name: "read-file", ok: true, ms: 12, chars: 3100 },
    { type: "text", text: "Refresh is scheduled in \`src/auth/session.ts:61\` by \`Session.schedule()\`, which sets a timer for the token's expiry. **The expiry mixes units**: \`issuedAt\` is milliseconds but the comparison treats \`ttl\` as if it were already milliseconds in one branch.\n\nCallers:\n- \`src/auth/token.ts:12\` — \`refreshToken()\`\n- \`src/api/client.ts:18\` — retries on 401" },
    context(52000),
    { type: "turn_end", turn: 1, stats: { steps: 3, llmCalls: 3, toolCalls: 2, toolErrors: 0, usage: { inputTokens: 14200, outputTokens: 610 }, durationMs: 9400 } },
    { type: "checkpoint", checkpoint: { seq: 1, hash: "9c1fa3b2", prev: "", short: "9c1f", ts: ts(200), label: "Where is token refresh scheduled?", turn: 1, filesTouched: 0, restorable: true } },
    { type: "phase", phase: "idle" },
  ];
  const turn2Start = [
    { type: "turn_start", turn: 2, prompt: "Fix it and add a regression test." },
    { type: "phase", phase: "thinking" },
    { type: "tool_call", call: { id: "p1", name: "update-plan", arguments: {} } },
    { type: "plan", steps: [
      { step: "Confirm the unit mismatch in Session.schedule()", status: "completed" },
      { step: "Fix the expiry math with a refresh skew", status: "in_progress" },
      { step: "Add a regression test for early refresh", status: "pending" },
      { step: "Run the auth tests", status: "pending" },
    ] },
    { type: "tool_result", id: "p1", name: "update-plan", ok: true, ms: 1, chars: 120 },
    { type: "tool_call", call: { id: "c3", name: "find-symbol-references", arguments: { symbol: "REFRESH_SKEW_MS" } } },
    { type: "tool_result", id: "c3", name: "find-symbol-references", ok: true, ms: 30, chars: 400 },
    { type: "tool_call", call: { id: "d1", name: "delegate", arguments: { task: "Map every caller of refreshToken()" } } },
    { type: "subagent_start", id: "d1", task: "Map every caller of refreshToken() and how each handles failure" },
  ];
  const sub = [
    { type: "tool_call", call: { id: "x1", name: "find-symbol-references", arguments: { symbol: "refreshToken" } } },
    { type: "tool_result", id: "x1", name: "find-symbol-references", ok: true, ms: 22, chars: 600 },
    { type: "tool_call", call: { id: "x2", name: "read-file", arguments: { path: "src/api/client.ts", start_line: 10, end_line: 40 } } },
  ];
  const subDone = [
    { type: "tool_result", id: "x2", name: "read-file", ok: true, ms: 9, chars: 1300 },
    { type: "text", text: "Two callers: token.ts:12 (no retry) and client.ts:18 (retries once on 401)." },
  ];
  const turn2Approval = [
    context(76000),
    { type: "phase", phase: "awaiting-approval", detail: "str-replace src/auth/session.ts" },
    { type: "approval_request", request: { id: "ap-1", call: { id: "c4", name: "str-replace", arguments: { path: "src/auth/session.ts" } },
      title: "str-replace src/auth/session.ts", preview: diff1, kind: "edit", risk: 0.42, callers: 4 } },
  ];
  const turn2Rest = [
    { type: "approval_resolved", id: "ap-1", decision: "allow" },
    { type: "tool_call", call: { id: "c4", name: "str-replace", arguments: { path: "src/auth/session.ts" } } },
    { type: "edit", edit: { id: "e-1", kind: "str-replace", path: "src/auth/session.ts", diff: diff1 } },
    { type: "tool_result", id: "c4", name: "str-replace", ok: true, ms: 40, chars: 80 },
    { type: "tool_call", call: { id: "c5", name: "str-replace", arguments: { path: "src/auth/session.test.ts" } } },
    { type: "edit", edit: { id: "e-2", kind: "str-replace", path: "src/auth/session.test.ts", diff: diff2 } },
    { type: "tool_result", id: "c5", name: "str-replace", ok: true, ms: 35, chars: 80 },
    { type: "tool_call", call: { id: "c6", name: "run-command", arguments: { command: "npm test -- src/auth" } } },
    { type: "tool_result", id: "c6", name: "run-command", ok: true, ms: 6200, chars: 900 },
    { type: "plan", steps: [
      { step: "Confirm the unit mismatch in Session.schedule()", status: "completed" },
      { step: "Fix the expiry math with a refresh skew", status: "completed" },
      { step: "Add a regression test for early refresh", status: "completed" },
      { step: "Run the auth tests", status: "completed" },
    ] },
    { type: "text", text: "Fixed. \`Session.schedule()\` now subtracts \`REFRESH_SKEW_MS\` (60s), so the refresh fires before the token dies rather than after. All 4 callers of \`refreshToken()\` go through it, so none needed changes.\n\nThe new test in \`src/auth/session.test.ts:43\` advances a fake clock to 59 minutes and asserts a refresh happened. \`npm test -- src/auth\`: 23 passed." },
    { type: "turn_end", turn: 2, stats: { steps: 7, llmCalls: 8, toolCalls: 9, toolErrors: 0, usage: { inputTokens: 38100, outputTokens: 1840 }, durationMs: 41800 } },
    { type: "checkpoint", checkpoint: { seq: 2, hash: "a3f9e0c1", prev: "9c1fa3b2", short: "a3f9", ts: ts(5), label: "Fix it and add a regression test.", turn: 2, filesTouched: 2, restorable: true } },
    { type: "phase", phase: "idle" },
  ];

  const scenes = {
    welcome: { meta: meta({ turn: 0, branch: "main" }), events: [] },
    setup: { meta: null, events: [], setup: { kind: "llm-key", message: "Add your Anthropic API key (or set ANTHROPIC_API_KEY) to start the agent." } },
    running: { meta: meta(), events: [...turn1, ...turn2Start, ...sub, ...turn2Approval] },
    done: { meta: meta(), events: [...turn1, ...turn2Start, ...sub, ...subDone, { type: "subagent_end", id: "d1", ok: true, chars: 900, ms: 8400 },
      { type: "tool_result", id: "d1", name: "delegate", ok: true, ms: 8400, chars: 900 }, ...turn2Approval.slice(0, 2), ...turn2Rest] },
  };
  scenes.parallel = { ...scenes.done, sessions: true };
  const s = scenes[scene] || scenes.running;
  // The sub-agent's own events travel tagged with its delegation id.
  const nested = new Set(sub.concat(subDone));

  const sessions = s.sessions
    ? [
      { id: "s1", title: "main", status: "ready", workspace: "/home/dev/acme-api", branch: "main", changedFiles: 0, running: false, turn: 2, active: true },
      { id: "s2", title: "Rate-limit the login route", status: "ready", workspace: "/tmp/oce-worktrees/acme-api/trace-rate-limit-the-login-route", branch: "trace/rate-limit-the-login-route", changedFiles: 3, running: true, turn: 1, active: false },
    ]
    : [{ id: "s1", title: "main", status: "ready", workspace: "/home/dev/acme-api", branch: "main", changedFiles: 0, running: scene === "running", turn: 2, active: true }];

  const post = (m) => window.postMessage(m, "*");
  let seq = 0;
  const envelope = (event, agentId) => ({ seq: ++seq, ts: ts(), sessionId: "s1", ...(agentId ? { agentId } : {}), event });

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      setTimeout(() => handle(msg), 0);
    },
    getState() { return undefined; }, setState() {},
  });

  function handle(msg) {
    if (msg.kind === "ready") {
      post({ kind: "state", state: { setup: s.setup || null, provider: "anthropic", model: "claude-opus-5-5", plan: "pro",
        activeFile: "src/auth/session.ts", hasSelection: scene === "welcome", parallel: true, shellEnabled: true } });
      post({ kind: "sessions", sessions: s.setup ? [] : sessions, parallel: true });
    } else if (msg.kind === "subscribe") {
      if (!s.meta) { post({ kind: "connection", connected: false }); return; }
      seq = 0;
      post({ kind: "trace", envelope: { seq: 0, ts: ts(), sessionId: "s1", event: { type: "session", meta: s.meta } } });
      for (const e of s.events) post({ kind: "trace", envelope: envelope(e, nested.has(e) ? "d1" : undefined) });
      post({ kind: "connection", connected: true });
    } else if (msg.kind === "rpc") {
      const reply = (value) => post({ kind: "rpc-result", id: msg.id, ok: true, value });
      switch (msg.method) {
        case "files": reply(["src/auth/session.ts", "src/auth/token.ts", "src/api/client.ts"].filter(f => f.includes(msg.params.query || ""))); break;
        case "history": reply([{ id: "h1", title: "Where is token refresh scheduled?", turns: 2, updatedAt: ts(60) }, { id: "h2", title: "Explain the billing module", turns: 5, updatedAt: ts(86400 * 2) }]); break;
        case "undoEdit": reply({ status: "undone" }); break;
        case "redoEdit": reply({ status: "applied" }); break;
        case "reviewSession": reply({ files: ["src/routes/login.ts"], untracked: ["src/middleware/rate-limit.ts"], diff: diff1, stat: { files: 2, added: 41, removed: 3 } }); break;
        case "confirm": reply(true); break;
        default: reply(null);
      }
    }
  }
})();
`;

function page(bundle, title, theme) {
  const js = fs.readFileSync(path.join(dist, `${bundle}.js`), "utf8").replace(/<\/script/gi, "<\\/script");
  const css = fs.readFileSync(path.join(dist, `${bundle}.css`), "utf8");
  const vars = (t) => Object.entries(THEMES[t]).map(([k, v]) => `${k}:${v};`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
html { ${vars("dark")} }
html.light { ${vars("light")} }
</style>
<script>
  if (new URLSearchParams(location.search).get("theme") === "light") document.documentElement.classList.add("light");
</script>
<style>${css}</style>
</head>
<body class="vscode-dark">
<div id="root"></div>
<script>
  if (document.documentElement.classList.contains("light")) document.body.className = "vscode-light";
</script>
<script>${HOST}</script>
<script>${js}</script>
</body>
</html>`;
}

fs.writeFileSync(path.join(here, "agent-harness.html"), page("agent", "Agent harness"));
fs.writeFileSync(path.join(here, "studio-harness.html"), page("trace-studio", "Studio harness"));
console.log("wrote dev/agent-harness.html and dev/studio-harness.html");
