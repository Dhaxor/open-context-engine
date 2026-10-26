# Changelog

## 0.4.7

- Re-release: 0.4.5 and 0.4.6 never reached the registry. 0.4.5's publish
  failed in CI (fixed in 0.4.6), and 0.4.6's tokenless OIDC publish was
  refused by the registry (E404) — npm's Trusted Publishing record needs a
  2FA-verified re-save that only the package owner can do. This version ships
  the same content as 0.4.6 through the standing granular token; everything
  below is new on npm since 0.4.4.

## 0.4.6

- The 0.4.5 tag's test gate failed on Linux: agent-task path validation used
  `path.isAbsolute`, which calls `C:bs.js` relative on POSIX — so the escape
  check passed a Windows dev machine and failed every CI leg. Validation now
  refuses Windows drive paths, leading separators, and `..` on all platforms,
  with a dedicated cross-platform test.

## 0.4.5 — operate it: tokenless npm publishing, agent evals, honest numbers, checkout

- **npm publishes without a token now.** Trusted Publishing (OIDC): the
  registry trusts this exact repository + workflow — `id-token: write` is the
  credential. No NPM_TOKEN to rotate, leak, or lose to npm's Jan-2027 removal
  of granular-token direct publishing.
- **`oce eval-agent`** — end-to-end agent tasks (fix a failing test, create a
  module, rename a symbol, delete dead code, add an endpoint) in throwaway
  workspaces, graded by verification scripts. The first harness that can catch
  a prompt, tool, or provider regression in the agent itself.
- **Dual-mode retrieval baselines, measured fresh.** This repo: keyword 0.886
  / hybrid 0.943. Flask (external): keyword 0.926 / hybrid 0.889. The honest
  finding, committed with the numbers: fusion demotes confident BM25 hits on
  definition-shaped queries — tuning it is tracked open work, and the
  baselines are the harness. (June's 0.977 no longer reproduces.)
- **Fixed: OpenAI embeddings rejected chunks over 8192 tokens**, silently
  dropping their whole file from the index. Oversized chunks now embed their
  head; full contents stay stored.
- **The Team plan is purchasable** — pricing's button goes through Polar.

## 0.4.4 — npm package is `@dhaxor/open-context`

npm's typosquat guard rejects the unscoped name `open-context` as too similar
to the existing `opencontext`, and suggests the scoped form — which also can
never be taken or impersonated. Install:

```bash
npm install -g @dhaxor/open-context
```

Same CLI (`oce`), same code. The 0.4.2/0.4.3 tags taught us the two things
that had to be fixed for any name to ship: the publish gate and the token.

## 0.4.3 — republish of 0.4.2

The 0.4.2 tag's `npm publish` failed before reaching the registry: the
package's `prepublishOnly` gate ran the extension's typecheck, which needs
`extension/node_modules` that the publish workflow never installs. The gate
now verifies what the npm package actually ships (core typecheck + tests);
the extension is gated by its own release workflow, which installs its deps.

## 0.4.2 — npm package renamed to `open-context`

The name `open-context-engine` on npm is owned by a different account, so no
release from this repository could ever publish under it (0.4.0's changelog
claimed an npm release that never happened — the publish was failing on the
name all along). The package now ships as **`open-context`**: same CLI (`oce`),
same code, versioned forward. The VS Code extension's Marketplace identity
(`open-context.open-context-engine`) is unchanged.

```bash
npm install -g open-context
```

## 0.4.1

### Fixes

- **The file watcher no longer strands stale chunks.** A file rejected during
  a debounced flush — replaced with binary bytes, or unreadable at that
  instant — was parked for removal with no timer armed, so its old chunks
  stayed in the index until the next unrelated edit. The watcher now re-arms
  itself and completes the eviction.
- **`oce watch` reports removals honestly.** When additions and deletions
  landed in one debounce window, the `[reindex]` line always said `0 removed`
  because it relayed the add-result verbatim. Removals from the same window
  are folded into the report.
- **`oce index` closes its store before exit.** Process teardown masked it,
  but the open handle kept the database locked against `oce clean` on Windows
  and left WAL files behind.
- **`release-check.sh` runs on Windows dev machines.** It assumed npm's POSIX
  `$PREFIX/bin/oce` layout; Windows npm puts the shim at the prefix root.

### Internal

- All pending dependency majors landed: TypeScript 7, vitest 5 (with an
  explicit vite 8 devDependency — vitest 5 takes vite as a required peer),
  openai 7, chokidar 6, ignore 7, markdown-it 15, @types/node 26, vsce 4.
- The 1,025-line `src/cli/index.ts` is now `io`/`config`/six command modules
  plus a thin entry point, with 33 tests running the real commands in-process
  (keyword-only path, no keys needed).
- New regression suites: the file watcher (real-store create/edit/delete,
  binary eviction, error survival, mid-flush queuing), `MultiContext` and
  `packWithDependencies` (previously exported-but-untested), and a Studio
  guard that fails the build if a raw-HTML sink ever appears next to
  model-derived strings.
- The shared design tokens between the marketing site and Trace are enforced
  by test instead of by hand.
- `eval/external/` — a Flask 3.1.2 gold set (27 cases, recall@10 0.926
  keyword-only) with a committed baseline, so ranking changes are validated
  against a codebase this repo has never seen.

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
  to run if it would discard an existing vector index — one that actually
  holds chunks; an empty one left by a failed first index is rebuilt.
- A missing key now names the free options instead of dead-ending.

### Fixes

- `oce status` no longer wipes the index when run with a different embedding
  provider than the index was built with; it reports the mismatch instead.
- Switching to another embedding model of the same dimension (for example two
  768-dimension Ollama models) now rebuilds the index. Before, the old
  model's vectors stayed and queries from the new model ranked against them
  at random. The index records which model built it.
- Retrieval explanations (`retrieveDebug`) now describe the pipeline production
  actually runs — they previously skipped the score floor and the AST graph
  expander.
- Configuration errors print one readable line instead of a stack trace
  (`OCE_DEBUG=1` restores it).
- Running outside a git repository no longer prints git's "not a repository"
  error on every command.
- `oce --version` and the MCP handshake report the real version instead of
  `0.1.0`.
