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
| 🧠 **AST-Aware Chunking** | Uses Tree-sitter to split code along semantic boundaries (functions, classes, methods) rather than naive line counts. Understands TypeScript, JavaScript, Python, Go, Rust, Java, and C#. |
| 🔍 **Hybrid Search** | Fuses **dense vector similarity** (cosine) with **BM25 keyword search** via Reciprocal Rank Fusion for results that are both semantically relevant and lexically precise. |
| ⚡ **Local SQLite + Vectors** | Stores everything in a local SQLite database with `sqlite-vec`—no external vector DB, no network latency, no subscription fees. |
| 🔗 **Symbol Expansion** | Automatically resolves identifiers in search results, pulling in definitions of functions, classes, and types referenced in snippets. |
| 🎯 **Optional Re-ranking** | Plug in Voyage or Cohere re-rankers to boost result quality for complex queries. |
| 🤖 **Built-in Agent** | Includes a full tool-use agent with codebase retrieval, file editing, shell execution, and web search—ready to run interactively or headless. |
| 🔌 **MCP Native** | Exposes all retrieval tools through the Model Context Protocol. Works with Claude Desktop, Cursor, and any MCP-compatible client. |

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
oce agent --workspace ./my-project --allow-edits
> how does the auth middleware work?
> refactor the user service to use dependency injection
```

The agent is **read-only by default** (codebase retrieval + file reads). Grant write/exec access explicitly: `--allow-edits` enables the file-editing tools and `--allow-shell` enables the `run-command` tool. The same applies to the programmatic API — `defaultAgentTools({ context })` returns read-only tools unless you pass `includeEdits: true` and/or `shell: true`.

### 6. Connect to Claude / Cursor via MCP

```bash
oce mcp --workspace ./my-project
```

The MCP server indexes the workspace on startup and then **watches for changes**, so the index stays live without a manual re-index. Pass `--no-watch` to disable the watcher. (The MCP handshake is established before indexing begins, so the first index of a large repo won't block your client from connecting.)

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

## 📖 Usage Guide

### CLI Reference

```bash
oce <command> [options]

Commands:
  index <workspace>      Index a codebase
  search <query>         Search the indexed codebase
  watch                  Index, then keep the index live as files change
  mcp                    Start MCP server (indexes + watches by default)
  agent                  Start interactive agent (auto-indexes on startup)
  eval                   Score retrieval quality against a labeled query set

Options:
  -w, --workspace <path>   Project root (default: cwd)
  -p, --provider <name>    Embedding provider: voyage | openai | ollama
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
});

const answer = await agent.run("How does the auth middleware work?");
console.log(answer);

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

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Open Context Engine                   │
├─────────────────────────────────────────────────────────────┤
│  CLI / API / MCP / Agent                                     │
├─────────────────────────────────────────────────────────────┤
│  HybridRetriever                                             │
│  ├── Vector Search (sqlite-vec)                              │
│  ├── BM25 Search (SQLite FTS5)                               │
│  ├── Reciprocal Rank Fusion                                  │
│  └── Optional Re-ranking (Voyage / Cohere)                   │
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
│  ├── chunks_vec (vector index)                               │
│  ├── chunks_fts (full-text index)                            │
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
| Ollama | `nomic-embed-text` | 768 | 100% local, free |

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

## 🛠️ Development

```bash
git clone https://github.com/yourusername/open-context-engine.git
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
│   ├── retriever.ts        # Hybrid search + RRF
│   ├── reranker.ts         # Re-ranking providers
│   ├── sqlite-store.ts     # SQLite persistence
│   ├── search.ts           # Output formatting
│   ├── file-filter.ts      # Gitignore-aware file collection
│   └── file-watcher.ts     # Watch for changes
├── agent/
│   ├── agent.ts            # ContextAgent + tools
│   ├── providers.ts        # LLM callers (OpenAI, Anthropic)
│   ├── edit-tools.ts       # File editing tools
│   └── extra-tools.ts      # Shell + web search
├── mcp/
│   └── server.ts           # MCP server implementation
└── cli/
    └── index.ts            # oce CLI entrypoint
```

## 🧪 How Search Works

1. **Chunking**: Your code is parsed by Tree-sitter into semantic units (functions, classes, methods). Unsupported files fall back to boundary-aware line chunking.
2. **Embedding**: Each chunk is embedded using your chosen provider. Voyage Code-3 is optimized for code and gives the best retrieval quality.
3. **Indexing**: Vectors go into `sqlite-vec`, text into FTS5, metadata into SQLite tables. All local.
4. **Query**: Your natural language query is embedded and searched simultaneously via vector similarity and BM25.
5. **Fusion**: Results are fused with Reciprocal Rank Fusion, balancing semantic and lexical signals.
6. **Re-ranking** (optional): Top candidates are re-scored by a dedicated re-ranker for higher precision.
7. **Symbol Expansion**: Identifiers in top results are resolved, pulling in definitions so the LLM sees the full picture.

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

A case file is a JSON array (or `{ cases: [...] }`):

```json
{ "id": "rrf-fusion", "query": "where is reciprocal rank fusion implemented", "expectedPaths": ["src/core/retriever.ts"] }
```

Keep your eval sets out of the index by listing their directory in `.contextignore` — a gold set maps queries to answers, so indexing it contaminates the rankings it measures.

## 📦 Requirements

- Node.js 18+
- For local embeddings: [Ollama](https://ollama.com) running locally
- For cloud embeddings: API key for Voyage or OpenAI

## 📄 License

MIT © [Gain](https://github.com/dhaxor)

---

<p align="center">
  Built for developers who want their AI to <i>actually understand</i> their code.
</p>
