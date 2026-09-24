# Open Context Engine

Local-first codebase indexing, and an AI agent grounded in your code.

Open Context Engine indexes your workspace into a SQLite store on your
machine: AST-aware chunks, a code graph of imports, calls and inheritance,
keyword (BM25) search, and — with an embedding provider — semantic vectors.
The chat agent searches that index as it works, so its answers come from the
code you actually have.

## Features

- **Chat grounded in your index.** A sidebar chat with streaming markdown and
  code-block copy, insert and apply, backed by ranked retrieval from your
  workspace.
- **Agent edits you can review.** Each changed file gets a native diff, undo
  and redo, and every turn gets an "undo all". The agent's shell tool is off
  by default.
- **Search from anywhere.** Quick Search (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>,
  or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> on macOS), Find Similar Code,
  and Explain with Context from the editor.
- **A live index.** Files re-index on save. The Index Health panel shows what
  is indexed, and Debug Retrieval shows why a query ranked what it did.
- **AST-aware chunking for 13 languages:** TypeScript, JavaScript, Python, Go,
  Rust, Java, C#, C, C++, Ruby, PHP, Kotlin and Swift. Other text files are
  chunked by lines.

## Getting started

1. Open a folder. The extension indexes it on startup.
2. With no embedding key, search runs on keyword ranking and works straight
   away.
3. For semantic search, run **Open Context: Set Embedding API Key** with a
   Voyage key (the default, `voyage-code-3`) or an OpenAI key. For free local
   embeddings, run `ollama pull nomic-embed-text` and set
   `openContext.embedding.provider` to `ollama`.
4. For chat, pick `openContext.llm.provider` — OpenAI, Anthropic, Google,
   Ollama, or any OpenAI-compatible endpoint via `custom` — and run
   **Open Context: Set LLM API Key**.

Keys are kept in VS Code's SecretStorage.

## Requirements

- VS Code 1.103 or newer.
- Windows x64, macOS (Intel and Apple Silicon), or Linux x64/arm64 with glibc
  2.34 or newer (Ubuntu 22.04, Debian 12, RHEL 9 and later). Remote hosts —
  SSH, WSL, Dev Containers, Codespaces — work on the same platforms. Alpine
  (musl) is not supported.

## Privacy

Indexing, the store, and keyword search run on your machine. Code leaves it
only for the embedding and LLM providers you configure; use Ollama for both
to stay fully offline. There is no telemetry.

## Settings

| Setting | Default | |
|---|---|---|
| `openContext.embedding.provider` | `voyage` | `voyage`, `openai`, or `ollama` |
| `openContext.llm.provider` | `openai` | `openai`, `anthropic`, `google`, `ollama`, or `custom` |
| `openContext.agent.allowEdits` | `true` | Lets the agent edit, create and delete files |
| `openContext.agent.shell.enabled` | `false` | Lets the agent run shell commands in the workspace |
| `openContext.autoIndex` | `true` | Re-indexes files as they change |
| `openContext.indexOnStartup` | `true` | Indexes the workspace when VS Code starts |

## The same engine elsewhere

Open Context Engine also runs as a CLI and an MCP server for Claude Code,
Cursor and other MCP clients (`npm install -g open-context-engine`), and as
Trace, an agent workspace for the terminal and the browser. See
[opencontextengine.com](https://opencontextengine.com).

## License

MIT. Paid plans add team features; see
[pricing](https://opencontextengine.com/pricing). Issues and source:
[github.com/Dhaxor/open-context-engine](https://github.com/Dhaxor/open-context-engine).
