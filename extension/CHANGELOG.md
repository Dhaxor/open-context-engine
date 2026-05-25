# Change Log

## Unreleased

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
