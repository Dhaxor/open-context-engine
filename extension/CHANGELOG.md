# Change Log

## 0.1.1

**This release fixes the `NODE_MODULE_VERSION 127` first-index crash that paying users hit on the `0.1.0` VSIX.**

The published `.vsix` is now built for VS Code's Electron runtime (Electron 42.3.0 / Node 24) and shipped as a separate package per `(os, arch)`. See `PUBLISHING.md` for the supported matrix and the runtime guard that now gives users a clear error message if their environment ends up incompatible after all.

**Breaking — minimum VS Code version is now 1.124.0.** Older VS Code uses an older Electron / Node ABI; a single rebuilt `better-sqlite3` binary can't span both. Users on VS Code < 1.124 will stay on the previous `0.1.0` release until v0.2 ships multi-ABI bundling.

**Currently unsupported (file an issue if this affects you):** `win32-arm64`, `linux-arm64`, Alpine/musl Linux.

Smaller things:

- **Real error messages instead of silent indexing failures.** The startup-index catch site now opens a notification + Output channel entry instead of swallowing to `console.error` where no user could see it. The same classifier covers NMV mismatch, glibc skew, musl/Alpine, wrong-arch binaries, and missing sqlite-vec platform packages.
- New "Open Context Engine" Output channel containing the raw load error and timestamps for support tickets.

## Unreleased

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
