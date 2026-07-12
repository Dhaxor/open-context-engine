# Change Log

## Unreleased

- **⚠ Security: the agent's shell tool now defaults to OFF.** `openContext.agent.shell.enabled` shipped as `true` with an empty allowlist, meaning a fresh install let the model run arbitrary commands. It is now opt-in; when enabling it, consider also pinning `openContext.agent.shell.allowlist`.
- **Workspace/org policy enforcement.** A committed `.open-context/policy.json` (or an org-signed `policy.lock`) can disable the agent's shell/edit/web-search tools, pin shell allowlists, force local-only embeddings, and exclude paths from indexing. Policies always win over settings; the extension shows one warning when a capability was stripped.
- **Tamper-evident audit log (opt-in, Enterprise).** `openContext.agent.audit.enabled` appends every agent run and tool call to a hash-chained `.open-context/audit/audit.jsonl`; verify with `oce audit --verify`. A policy with `"audit": { "required": true }` forces it on.
- **Fully-local in-process embeddings.** New `local` embedding provider (`jina-embeddings-v2-base-code` or `all-MiniLM-L6-v2`) — no API key and no Ollama server; needs the optional `@huggingface/transformers` package. Models cache under `~/.open-context/models`.
- **Six new indexed languages.** C, C++, Ruby, PHP, Kotlin, and Swift now get AST-aware chunking and code-graph edges (imports/exports/inheritance) instead of line-based fallback.
- **Faster agent turns.** Read-only tool calls within a turn now execute in parallel; turns containing edits or shell commands stay strictly ordered. Provider-reported token usage is tracked per run.
- **Embedding cache (on by default).** Vectors are cached by content hash in `~/.open-context/embed-cache.db`, shared across repos and branches — identical code never embeds (or bills) twice. Disable with `openContext.embedding.cache.enabled`.
- **Team index sync (Team license, CLI).** `oce push-index` publishes the index as an artifact; `oce pull-index` installs it and re-embeds only the local diff. Pairs with the embedding cache for a one-embedding-bill-per-team story.

- **Electron 42 (ABI 146) is now bundled.** VS Code 1.122+ / current Cursor builds that report the Electron ABI can load `better-sqlite3` again. Requires `better-sqlite3@^12.11.1` (V8 14 / Electron 42 compile fixes).

- **Linux arm64 is now a supported platform.** The release matrix gained a native `ubuntu-22.04-arm` leg (same glibc 2.35 floor as x64) — no cross-compiling, and `sqlite-vec-linux-arm64` ships in the VSIX. Raspberry Pi 5 / Graviton / Ampere dev boxes and arm64 devcontainers get first-class support.

## 0.2.0

**One VSIX now covers VS Code 1.103 → current.** Each platform package bundles a `better_sqlite3.node` per supported Electron ABI (37.x / 39.x / 42.x); at activation the extension selects the one matching your VS Code's runtime. The `engines.vscode` floor drops from `^1.124.0` back to `^1.103.0` — the 0.1.1 restriction existed only because a single binary can't span Electron ABIs, and that constraint is gone. When VS Code ships a new Electron, a target is appended and republished; no floor bump, no stranded users.

If your VS Code's ABI isn't in the shipped set, activation now stops with an error naming your ABI and the shipped ones (instead of a cryptic `NODE_MODULE_VERSION` crash mid-index).

## 0.1.1

**This release fixes the `NODE_MODULE_VERSION 127` first-index crash that paying users hit on the `0.1.0` VSIX.**

The published `.vsix` is now built for VS Code's Electron runtime (Electron 42.3.0 / Node 24) and shipped as a separate package per `(os, arch)`. See `PUBLISHING.md` for the supported matrix and the runtime guard that now gives users a clear error message if their environment ends up incompatible after all.

**Breaking — minimum VS Code version is now 1.124.0.** Older VS Code uses an older Electron / Node ABI; a single rebuilt `better-sqlite3` binary can't span both. Users on VS Code < 1.124 will stay on the previous `0.1.0` release until v0.2 ships multi-ABI bundling.

**Currently unsupported (file an issue if this affects you):** `win32-arm64`, `linux-arm64`, Alpine/musl Linux.

Smaller things:

- **Real error messages instead of silent indexing failures.** The startup-index catch site now opens a notification + Output channel entry instead of swallowing to `console.error` where no user could see it. The same classifier covers NMV mismatch, glibc skew, musl/Alpine, wrong-arch binaries, and missing sqlite-vec platform packages.
- New "Open Context Engine" Output channel containing the raw load error and timestamps for support tickets.

## Unreleased

- **Session memory (on by default)** — the agent now remembers codebase insights across chat sessions, stored locally in `.open-context/memories.json`. Relevant memories ride along in the agent's context per query. Disable with `openContext.agent.memory.enabled`.
- **Model routing (opt-in)** — `openContext.agent.routing.enabled` routes each query to a cost-appropriate tier: quick lookups go to a fast model (e.g. Haiku), multi-file/analytical work to the strongest (e.g. Opus), everything else to your configured model. Tier models are overridable; the chat shows which tier each turn used.

- **Smooth streaming render** — agent responses no longer flicker. The chat bubble keeps a stable rendered prefix (the *committed* markdown) and a live plain-text *tail* that grows by single text-node append per token, with a dedicated cursor element anchored to the end. Full markdown-it + highlight.js only re-runs when a paragraph or code fence closes — not every animation frame.
- **Auto-scroll respects the user** — if you scroll up to read, the chat stops yanking you back down. A floating "Latest" pill reattaches with one click. Sending a new message snaps to the bottom regardless.
- **Review & undo agent edits** — every file the agent changes now shows *Open diff* (native side-by-side), *Undo*, and *Redo*, with a per-turn "N files changed · Undo all" summary. Undo/redo apply exact inverses and keep the index in sync.
- **Undo Last Agent Edit** command (also in the chat title bar).
- **Resilient chat** — the conversation no longer disappears when the panel is hidden or moved (`retainContextWhenHidden`), and the last active conversation is restored after a window reload.

## 0.1.0

Initial release of Open Context Engine:

- Semantic codebase search powered by local embeddings
- AI chat with codebase context (OpenAI, Anthropic, Google)
- Sidebar tree view of indexed files
- Quick search (Ctrl+Shift+K)
- Editor context menu: "Explain with Context", "Find Similar Code"
- Auto-indexing with file watcher
- Supports OpenAI, Voyage AI, and Ollama embeddings
- Full MCP server mode for Claude Code / Cursor integration
