# Changelog

## 0.4.0 — first public release

The first version published to npm. Earlier version numbers were internal.

### Trace — the agent workspace

- **`oce trace`** opens the workspace in your browser; bare **`oce`** opens it
  full-screen in the terminal. Both render one event stream from one session,
  so they cannot disagree.
- **Evidence rail** — what is in the model's context window right now: ranked
  retrieved chunks with fusion scores, the graph edge that pulled each one in,
  and a token budget split into retrieval / files / history / system. Pinned
  chunks survive compaction; evicted chunks are removed from the next request
  by re-rendering the original tool result without them.
- **Checkpoints and rewind** — one checkpoint per turn on the audit hash chain.
  Rewinding restores both the conversation and the files the agent changed,
  and refuses to overwrite a file you edited by hand since.
- **Approvals** show the diff, a blast-radius score, and indexed caller count.
- **Sub-agent visibility** — delegated work streams into its own block.
- **Parallel sessions** — in a git repository each session runs in its own
  worktree and branch. Review a session's changes and land it (commit, then
  `--no-ff` merge); closing a session never discards uncommitted work.
- **Composer** — `@path` pins a file into context, `!command` runs a shell
  command through the approval flow, `/command` for the rest.
- **Reconnect-safe** — the event stream replays from a cursor, so a dropped
  connection or a second window never loses the session.
- **Desktop shell** (`desktop/`, build from source) — Electron wrapper with
  attention-only notifications, a menu, and `trace://` deep links.

### Getting started without paying

- **`oce setup`** lists every way to get a working model and records your
  choice. Presets for free providers: Ollama (local), Google Gemini, Groq,
  Cerebras, OpenRouter free models — `oce trace -p groq` just works with a key.
- **No embedding key required.** With no embedding provider configured, the
  engine runs keyword (BM25) search instead of failing. This fallback refuses
  to run if it would discard an existing vector index.
- A missing key now names the free options instead of dead-ending.

### Fixes

- `oce status` no longer wipes the index when run with a different embedding
  provider than the index was built with; it reports the mismatch instead.
- Retrieval explanations (`retrieveDebug`) now describe the pipeline production
  actually runs — they previously skipped the score floor and the AST graph
  expander.
- Configuration errors print one readable line instead of a stack trace
  (`OCE_DEBUG=1` restores it).
- Running outside a git repository no longer prints git's "not a repository"
  error on every command.
- `oce --version` and the MCP handshake report the real version instead of
  `0.1.0`.
