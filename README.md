# Open Context Engine

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.6+-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/SQLite-vec0-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/MCP-Compatible-1a1a1a?logo=protocols&logoColor=white" alt="MCP" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License" />
</p>

<p align="center">
  <b>Local. Semantic. Instant.</b><br/>
  Turn any codebase into a searchable knowledge base for AI.
</p>

---

Open Context Engine (OCE) is a **local-first, high-performance retrieval engine** that indexes your entire codebase, embeds it into vectors, and serves it up to LLMs via semantic search, keyword search, and the Model Context Protocol (MCP). No cloud required. No code leaves your machine.

Whether you're building a coding assistant, automating PR reviews, or just want to ask natural-language questions about your own code—OCE gives your AI **ground truth**.

## ✨ What Makes It Special

| Feature | Description |
|---------|-------------|
| 🧠 **AST-Aware Chunking** | Uses Tree-sitter to split code along semantic boundaries (functions, classes, methods) rather than naive line counts. Understands TypeScript, JavaScript, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, Kotlin, and Swift. |
| 🔍 **Hybrid Search** | Fuses **dense vector similarity** (cosine) with **BM25 keyword search** via Reciprocal Rank Fusion for results that are both semantically relevant and lexically precise. |
| ⚡ **Local SQLite + Vectors** | Stores everything in a local SQLite database with `sqlite-vec`—no external vector DB, no network latency, no subscription fees. |
| 🏠 **Fully-Local Embeddings** | Optional in-process ONNX embeddings (`--provider local`) — zero API keys, zero servers, models cached on disk. Ollama also supported. |
| 🔗 **Symbol Expansion** | Automatically resolves identifiers in search results, pulling in definitions of functions, classes, and types referenced in snippets. |
| 🎯 **Optional Re-ranking** | Plug in Voyage or Cohere re-rankers to boost result quality for complex queries. |
| 🕸️ **Code Graph** | A tree-sitter AST pass extracts import/call/definition edges into a queryable graph; top search results are graph-expanded so callers and callees ride along. |
| 🤖 **Agent Harness** | A full tool-use agent with codebase retrieval, file editing, shell execution, and web search — plus parallel read-only tool execution, pre/post tool-call hooks, token-usage accounting, session export/import, model routing, and cross-session memory. |
| 🔌 **MCP Native** | Exposes retrieval, file, and symbol tools through the Model Context Protocol over stdio or **Streamable HTTP** (shared endpoint with bearer auth). Works with Claude Desktop, Cursor, and any MCP-compatible client. |
| 🧰 **VS Code Extension** | Sidebar chat grounded in the index, agent edits with per-file diff/undo/redo, live re-indexing on save, and an index-health panel. Ships per-platform with multi-ABI native bindings. |
| 🛡️ **Policy Controls** | Pin what the engine may do per workspace or org: disable shell/edits/web-search, pin command allowlists, force local-only embeddings, exclude paths. Org-signed policy locks cannot be loosened locally. |
| 🧾 **Tamper-Evident Audit Log** | Hash-chained JSONL of every agent run, tool call, and MCP invocation. `oce audit --verify` detects any alteration, deletion, or reordering. |
| 👥 **Team Index Sync** | Build the index once in CI, publish it as an artifact (S3/HTTP/shared drive), and teammates `oce pull-index` it — only their local diff re-embeds. A content-hash embedding cache means identical code never bills twice. |
| 🚀 **Parallel Indexing** | Worker-thread parse/chunk pool kicks in automatically on large repos; `oce bench` measures throughput on yours. |
| 🛟 **Degrades, Never Dies** | No sqlite-vec build for your platform? The engine runs keyword-only (BM25) instead of crashing — indexing and search keep working, and every surface tells you which mode you're in. |
| 📏 **Measured, Not Guessed** | Retrieval quality is scored against a committed 44-case gold set: **recall@10 0.977 · nDCG@10 0.812 · ctx-recall 0.943** on this repo. Ranking changes ship with before/after deltas. |

## 🚀 Quick Start

### 1. Install

```bash
npm install -g open-context-engine
# or locally
npm install open-context-engine
```

### 2. Set your API key

```bash
# Recommended: Voyage Code-3 (best for code)
export VOYAGE_API_KEY="your-key"

# Or OpenAI
export OPENAI_API_KEY="your-key"

# Or run entirely local with Ollama
export OLLAMA_BASE_URL="http://localhost:11434"

# Or fully local, in-process — no key, no server (models cached in ~/.open-context/models)
npm install @huggingface/transformers   # optional dep, one time
oce index --provider local
```

### 3. Index your codebase

```bash
# Full index
oce index --workspace ./my-project

# Incremental (only changed files)
oce index --workspace ./my-project --incremental
```

### 4. Search

```bash
oce search "how does the auth middleware work?"
```

### 5. Run the interactive agent

```bash
oce                       # bare `oce` starts the agent in the current directory
oce agent -w ./my-project # or target a workspace explicitly
```

```
Open Context · code-native agent
model      openai/gpt-5.4
workspace  /home/you/my-project
index      12,481 chunks · hybrid
approvals  suggest
type a request, or /help for commands · Ctrl+C interrupts

› refactor the user service to use dependency injection
```

The REPL streams styled output, shows each tool call with a live spinner and timing, and — before any file edit or shell command — prints a **diff/command preview and asks for approval** (`y` / `a`lways / `n`). Ctrl+C interrupts the current run without quitting the session.

**Approval modes** (as in the other leading coding CLIs):

- default (`suggest`) — every edit and shell command asks first
- `--auto-edit` — file edits apply automatically; shell still asks
- `--full-auto` — nothing asks (for containers / CI)

Switch mid-session with `/mode`. Interactive sessions have the edit and shell tools available behind approvals; the non-interactive `--print` path keeps them opt-in via `--allow-edits` / `--allow-shell`.

**Slash commands:** `/help` `/reset` `/compact` `/plan` `/diff` `/usage` `/tools` `/mode` `/sessions` `/resume` `/exit`.

**Sessions persist automatically** to `.open-context/sessions/`. `oce --continue` resumes the last conversation in the workspace; `oce --resume <id>` restores a specific one (list them with `/sessions`).

**Harness features:**

- **Plan tracking** — the agent maintains a live step checklist for multi-step work, rendered as you watch.
- **Sub-agent delegation** — broad explorations run in a scoped read-only child agent, so their large intermediate output never floods the main context.
- **Summarizing compaction** — when history gets long, older turns are condensed into a context note *by the model* rather than dropped, so decisions and file paths survive; force it with `/compact`.
- **Environment awareness** — platform, git branch/status, date, and index stats are injected into the system prompt.
- **Cost + parallelism** — every turn ends with a stats line (steps, tool calls, token usage, wall time); read-only tool calls in a turn run in parallel, while any turn with an edit or shell call stays strictly ordered.
- `--route` sends each query to a cost-appropriate model tier; `--memory` remembers codebase insights across sessions; `--audit` logs runs to the tamper-evident audit log.

Non-interactive use for scripts and CI:

```bash
oce --print "where is the auth middleware defined?"           # one answer, then exit
oce --print "list the exported symbols in src/core" --json     # {answer, stats, toolCalls}
```

The programmatic API mirrors all of this: `defaultAgentTools({ context })` stays read-only unless you pass `includeEdits`/`shell`/`plan`/`delegate`, and `ContextAgent` accepts `hooks` (a `PermissionManager` composes in here), `compaction`, and `environmentProvider`.

### 6. Connect to Claude / Cursor via MCP

```bash
oce mcp --workspace ./my-project

# Or serve a shared HTTP endpoint (e.g. one index for the whole team):
oce mcp --workspace ./my-project --http --port 8940 --auth-token "$TOKEN"
```

The MCP server indexes the workspace on startup and then **watches for changes**, so the index stays live without a manual re-index. Pass `--no-watch` to disable the watcher. (The MCP handshake is established before indexing begins, so the first index of a large repo won't block your client from connecting.)

In HTTP mode the server speaks MCP's Streamable HTTP transport, binds to loopback by default, answers `GET /health`, and — when `--auth-token` (or `OCE_MCP_AUTH_TOKEN`) is set — requires `Authorization: Bearer <token>` on every request.

Then add to your MCP config:

```json
{
  "mcpServers": {
    "open-context": {
      "command": "oce",
      "args": ["mcp", "--workspace", "/path/to/project"]
    }
  }
}
```

### 7. Or use the VS Code extension

The `extension/` folder ships a full VS Code experience on top of the same
engine: a sidebar **chat** grounded in your index (streaming, markdown,
code-block copy/insert/apply), **agent edits** with per-file diff /
undo / redo and a per-turn "undo all", **quick search**
(<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>), auto-indexing on save, and an
**index health panel** for debugging retrieval. Platform packages bundle
native bindings for every supported VS Code runtime ABI — see
[`extension/PUBLISHING.md`](extension/PUBLISHING.md) for the support matrix,
or build your own VSIX:

```bash
cd extension && npm ci
npm run rebuild        # downloads native bindings for all supported ABIs
npx vsce package --target linux-x64
```

## 📖 Usage Guide

### CLI Reference

```bash
oce <command> [options]

Commands:
  index <workspace>      Index a codebase
  search <query>         Search the indexed codebase
  watch                  Index, then keep the index live as files change
  mcp                    Start MCP server (stdio, or --http for a shared endpoint)
  agent                  Start interactive agent (auto-indexes on startup)
  eval                   Score retrieval quality against a labeled query set
  push-index <dest>      Publish the index as a team artifact (Team)
  pull-index <src>       Install a team index, re-embed only local changes (Team)
  bench                  Benchmark parse/chunk throughput on this workspace
  policy                 Show the effective policy (user + workspace + org lock)
  audit                  Inspect / verify the tamper-evident audit log
  activate <key>         Activate a Team/Enterprise license
  license / deactivate   Show or remove the active license

Options:
  -w, --workspace <path>   Project root (default: cwd)
  -p, --provider <name>    Embedding provider: voyage | openai | ollama | local
  -m, --model <model>      Embedding model name
  --api-key <key>          API key (falls back to env vars)
  --store-path <path>      Custom store directory (default: .open-context/)
  --max-file-size <bytes>  Skip files larger than this
  --chunk-size <lines>     Lines per chunk (default: 80)
  --chunk-overlap <lines>  Overlap between chunks (default: 15)
```

### Programmatic API

```typescript
import { OpenContext, ContextAgent, defaultAgentTools } from "open-context-engine";

// 1. Create and index
const ctx = await OpenContext.create({
  workspaceRoot: "./my-project",
  embedding: {
    provider: "voyage",
    model: "voyage-code-3",
    dimension: 1024,
    apiKey: process.env.VOYAGE_API_KEY,
    batchSize: 32,
  },
});

await ctx.indexWorkspace();

// 2. Search
const results = await ctx.search("authentication middleware flow");
console.log(results);

// 3. Agent with tools
const agent = new ContextAgent({
  provider: "openai",
  model: "gpt-4o",
  apiKey: process.env.OPENAI_API_KEY,
  tools: defaultAgentTools({ context: ctx, includeEdits: true }),
  // Optional harness features:
  maxParallelTools: 4,                       // read-only tool calls fan out concurrently
  hooks: {
    preToolCall: (tc) => tc.name === "remove-file"
      ? { behavior: "deny", reason: "deletions are reviewed manually" }
      : { behavior: "allow" },
    postToolCall: (_tc, result) => result.replaceAll(process.env.HOME!, "~"),
  },
});

const answer = await agent.run("How does the auth middleware work?");
console.log(answer);
console.log(agent.getLastRunStats());        // steps, tool calls, token usage, duration
const saved = agent.exportSession();          // persist; importSession(saved) restores

// 4. Cleanup
ctx.close();
```

### MCP Server Integration

```typescript
import { runMCPServer } from "open-context-engine";

await runMCPServer({
  workspaceRoot: "./my-project",
  embedding: { provider: "voyage", model: "voyage-code-3", dimension: 1024, batchSize: 32 },
});
```

Exposed MCP tools:
- `codebase-retrieval` — Natural language search over code
- `list-files` — Browse indexed files with filters
- `read-file` — Read file contents with optional line ranges
- `find-symbol-definition` — Exact-name lookup of where a function/class/type is defined
- `find-symbol-references` — Every indexed usage site of an identifier
- `index-status` — Chunk count, file count, search mode, embedding model

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Open Context Engine                   │
├─────────────────────────────────────────────────────────────┤
│  CLI / API / MCP / Agent                                     │
├─────────────────────────────────────────────────────────────┤
│  HybridRetriever                                             │
│  ├── Vector Search (sqlite-vec)                              │
│  ├── BM25 Search (SQLite FTS5, porter-stemmed)               │
│  ├── Reciprocal Rank Fusion + symbol/editor/recency boosts   │
│  ├── Optional Re-ranking (Voyage / Cohere)                   │
│  └── Graph Expansion (callers/callees via code graph)        │
├─────────────────────────────────────────────────────────────┤
│  AstChunker + CodeChunker                                    │
│  ├── Tree-sitter parsers (TS, JS, Py, Go, Rust, Java, C#)   │
│  └── Boundary-aware fallback chunking                        │
├─────────────────────────────────────────────────────────────┤
│  Embedding Providers                                         │
│  ├── Voyage Code-3 (recommended)                             │
│  ├── OpenAI text-embedding-3-*                               │
│  └── Ollama (local, nomic-embed-text)                        │
├─────────────────────────────────────────────────────────────┤
│  SqliteStore                                                 │
│  ├── chunks (metadata)                                       │
│  ├── chunks_vec (vector index — skipped in keyword-only)     │
│  ├── chunks_fts (full-text index)                            │
│  ├── graph_edges (import/call/definition graph)              │
│  └── files (index state)                                     │
└─────────────────────────────────────────────────────────────┘
```

## ⚙️ Configuration

### Embedding Models

| Provider | Model | Dimension | Best For |
|----------|-------|-----------|----------|
| **Voyage** | `voyage-code-3` | 1024 | ⭐ Code retrieval (recommended) |
| OpenAI | `text-embedding-3-large` | 3072 | General purpose |
| OpenAI | `text-embedding-3-small` | 1536 | Speed + cost |
| Ollama | `nomic-embed-text` | 768 | 100% local via an Ollama server |
| Local | `jina-embeddings-v2-base-code` | 768 | 100% local, in-process, code-tuned — no key, no server |
| Local | `all-MiniLM-L6-v2` | 384 | 100% local, in-process, smallest/fastest |

The `local` provider needs the optional `@huggingface/transformers` package; models download once into `~/.open-context/models` (override with `OCE_MODEL_DIR`) and run offline afterwards.

### Agent LLMs

`openai`, `anthropic`, `google` (Gemini, streaming + tools), `ollama` (fully local — `oce -p ollama --llm-model qwen2.5-coder:7b` needs no API key), and `custom` (any OpenAI-compatible endpoint via `--llm-base-url`). With `-p ollama` for the LLM, `--embedding-provider local` for embeddings, and `reranker: { provider: "local" }`, the **entire stack runs offline** — index, search, rerank, and agent.

### Config file

Persistent settings live in `~/.open-context/config.json` (user) and `<workspace>/.open-context/config.json` (project — commit it). Flags and env vars always win. API keys are deliberately rejected in config files; use env vars.

```jsonc
{
  "embedding": { "provider": "local", "model": "jina-embeddings-v2-base-code" },
  "llm": { "provider": "ollama", "model": "qwen2.5-coder:7b" },
  "search": { "topK": 20, "minScore": 0.15 },
  "chunkSize": 80
}
```

### Search Configuration

```typescript
{
  search: {
    topK: 15,              // Final results returned
    candidateK: 60,        // Candidates before fusion/rerank
    maxOutputLength: 80000,// Max chars in formatted output
    minScore: 0.0,         // Score floor
    bm25Weight: 1.0,       // Keyword search weight
    vectorWeight: 1.0,     // Semantic search weight
    rerank: true,          // Enable reranking if configured
    expandSymbols: true,   // Pull in referenced definitions
  }
}
```

### Re-ranking

```typescript
{
  reranker: {
    provider: "voyage",    // or "cohere"
    model: "rerank-2",     // optional
    apiKey: "your-key",
  }
}
```

## 👥 Team Index Sync (Team)

Index once — in CI or on a lead's machine — and let the whole team pull the result instead of each paying to embed the same monorepo:

```bash
# CI / lead machine: refresh the index and publish it (any file path or
# HTTP(S) PUT endpoint — S3/GCS presigned URLs work as-is)
oce push-index https://artifacts.example.com/oce/main.db.gz --token "$TOKEN"

# Each teammate: install it, then only their local diff gets embedded
oce pull-index https://artifacts.example.com/oce/main.db.gz --token "$TOKEN"
# → Installed team index: 12,481 chunks, 1,904 files, built ... at commit ab12cd34
# → Reconciled: 3 file(s) re-embedded locally, 1,901 reused from the artifact
```

The artifact is the store itself (vectors + FTS + code graph + file hashes) gzipped, so reconciliation is a plain incremental index: only files whose hashes differ from the artifact re-embed. No OCE cloud service is involved — artifacts go to storage **you** control.

On top of that, a machine-wide **embedding cache** (`~/.open-context/embed-cache.db`, on by default in the CLI and extension) keys vectors by content hash: identical code never embeds twice, across repos, branches, and store rebuilds. Disable with `--no-embed-cache` or `openContext.embedding.cache.enabled`.

## 🛡️ Policy Controls

Commit a policy file and every OCE surface (CLI, extension, library) enforces it — a `--allow-shell` flag can't override it, and the merge is always most-restrictive-wins:

```jsonc
// <workspace>/.open-context/policy.json (or ~/.open-context/policy.json for user-wide)
{
  "agent": {
    "shell": { "enabled": false },                  // or pin: { "allowlist": ["git", "npm"] }
    "edits": { "enabled": true },
    "webSearch": { "enabled": false }
  },
  "embedding": { "localOnly": true },               // only ollama/local providers may run
  "ignore": ["secrets/**", "*.pem"],                // never indexed, on top of .contextignore
  "audit": { "required": true }                     // force audit logging on
}
```

`oce policy` prints the effective merge and where each rule came from. Orgs on a Team+ plan can additionally ship an **Ed25519-signed `policy.lock`** (issued with `scripts/license-tool.mjs sign-policy`) that developers cannot loosen or delete their way out of.

## 🧾 Audit Log

`oce agent --audit` (or the `openContext.agent.audit.enabled` setting) appends every run, tool call, and MCP invocation to `.open-context/audit/audit.jsonl`. Each record is SHA-256 hash-chained to the previous one, so edits, deletions, and reordering are detectable:

```bash
oce audit                 # recent events
oce audit --type tool-call --since 2026-07-01
oce audit --verify        # ✓ chain intact — or exactly where it was tampered
```

Audit logging is an Enterprise feature; a workspace/org policy with `"audit": { "required": true }` also switches it on.

## 🛠️ Development

```bash
git clone https://github.com/Dhaxor/open-context-engine.git
cd open-context-engine
npm install
npm run build
npm test
```

### Project Structure

```
src/
├── core/
│   ├── context.ts          # Main OpenContext class
│   ├── ast-chunker.ts      # Tree-sitter chunking
│   ├── chunker.ts          # Fallback line chunking
│   ├── embedder.ts         # Embedding providers
│   ├── retriever.ts        # Hybrid search + RRF + boosts
│   ├── reranker.ts         # Re-ranking providers
│   ├── sqlite-store.ts     # SQLite persistence (vec + FTS5 + graph)
│   ├── code-graph.ts       # Import/call/definition edge queries
│   ├── ast-graph-extractor.ts # Single-DFS AST edge extraction
│   ├── graph-expander.ts   # Graph-aware result expansion
│   ├── chunk-pool.ts       # Worker-thread parse/chunk pool (auto on big repos)
│   ├── policy.ts           # Workspace/org policy loading + enforcement
│   ├── audit.ts            # Tamper-evident (hash-chained) audit log
│   ├── license.ts          # Offline Ed25519 license gate
│   ├── search.ts           # Output formatting
│   ├── file-filter.ts      # Gitignore-aware file collection
│   └── file-watcher.ts     # Watch for changes
├── agent/
│   ├── agent.ts            # ContextAgent + tools
│   ├── providers.ts        # LLM callers (OpenAI, Anthropic)
│   ├── model-router.ts     # Cost-appropriate tier per query
│   ├── session-memory.ts   # Cross-session insight memory
│   ├── edit-tools.ts       # File editing tools
│   └── extra-tools.ts      # Shell + web search
├── eval/
│   └── runner.ts           # Retrieval-quality scoring (oce eval)
├── mcp/
│   └── server.ts           # MCP server implementation
└── cli/
    └── index.ts            # oce CLI entrypoint
extension/                  # VS Code extension (chat, edit review, health)
```

## 🧪 How Search Works

1. **Chunking**: Your code is parsed by Tree-sitter into semantic units (functions, classes, methods). Unsupported files fall back to boundary-aware line chunking.
2. **Embedding**: Each chunk is embedded using your chosen provider. Voyage Code-3 is optimized for code and gives the best retrieval quality.
3. **Indexing**: Vectors go into `sqlite-vec`, text into FTS5, metadata into SQLite tables. All local.
4. **Query**: Your natural language query is embedded and searched simultaneously via vector similarity and BM25.
5. **Fusion**: Results are fused with Reciprocal Rank Fusion, then boosted by symbol-name matches, your editor context (active file, open tabs), and git recency.
6. **Re-ranking** (optional): Top candidates are re-scored by a dedicated re-ranker for higher precision.
7. **Graph Expansion**: Top results are expanded along the code graph — callers, callees, and referenced definitions ride along so the LLM sees the full picture.

If the `sqlite-vec` extension can't load on your platform, steps 2 and 4's vector half are skipped automatically and the engine runs **keyword-only (BM25)** — slower to find conceptual matches, but everything keeps working and `getStatus()` / the CLI / the extension all surface the mode.

## 📏 Measuring Retrieval Quality

`oce eval` scores the engine against a labeled query set — so ranking changes are measured, not guessed:

```bash
# Score the engine against the bundled gold set for this repo
oce eval --cases eval/oce.eval.json

# Save a baseline, change a ranking knob, then compare
oce eval --cases eval/oce.eval.json --out baseline.json
# ...tweak weights / expansion / reranker...
oce eval --cases eval/oce.eval.json --baseline baseline.json

# Measure what symbol/graph expansion contributes
oce eval --cases eval/oce.eval.json --no-expand --baseline baseline.json
```

Reports **recall@k**, **MRR**, **nDCG@k**, **hit-rate**, and per-query latency, plus per-case deltas (improved / regressed) against a saved baseline. Metrics are file-granular: a case passes when the gold file ranks in the top-k unique files returned.

Current numbers on this repo's committed 44-case gold set ([`eval/oce.eval.json`](eval/oce.eval.json), baseline at [`eval/baseline.json`](eval/baseline.json)):

| recall@10 | MRR | nDCG@10 | hit-rate | ctx-recall | mean latency |
|---|---|---|---|---|---|
| **0.977** | 0.768 | 0.812 | 0.977 | 0.943 | 251 ms |

Reports record which search mode produced them (`hybrid` vs `keyword-only`), and baseline comparisons warn loudly on a mode mismatch.

A case file is a JSON array (or `{ cases: [...] }`):

```json
{ "id": "rrf-fusion", "query": "where is reciprocal rank fusion implemented", "expectedPaths": ["src/core/retriever.ts"] }
```

Keep your eval sets out of the index by listing their directory in `.contextignore` — a gold set maps queries to answers, so indexing it contaminates the rankings it measures.

## 📦 Requirements

- Node.js 18+
- For fully-local embeddings: the optional `@huggingface/transformers` package (`--provider local`), or [Ollama](https://ollama.com) running locally
- For cloud embeddings: API key for Voyage or OpenAI
- Platforms without a [sqlite-vec](https://github.com/asg017/sqlite-vec) build (e.g. win32-arm64, Alpine) run keyword-only — no API key needed at all in that mode

## 📄 License

MIT © [Gain](https://github.com/dhaxor)

---

<p align="center">
  Built for developers who want their AI to <i>actually understand</i> their code.
</p>
