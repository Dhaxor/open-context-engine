# Change Log

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
