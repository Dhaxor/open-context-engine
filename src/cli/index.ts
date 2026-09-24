#!/usr/bin/env node
import { Command } from "commander";
import { OpenContext } from "../core/context";
import { SqliteStore } from "../core/sqlite-store";
import { OpenContextConfig, EMBEDDING_MODELS, DEFAULT_MODEL_FOR_PROVIDER } from "../core/types";
import { runMCPServer } from "../mcp/server";
import { runRepl } from "./repl";
import { buildSession, keywordOnlyWarning } from "./session";
import { packageVersion } from "../version";
import { getLicense, verifyLicenseToken, saveLicenseToken, clearLicense, loadEnterpriseEdition, isEntitled, checkOrgDomainBinding } from "../core/license";

/** Best-effort local identity for SSO-lite activation checks. */
function resolveActivationEmail(): string | null {
  if (process.env.OCE_ACTIVATION_EMAIL) return process.env.OCE_ACTIVATION_EMAIL;
  try {
    const { execSync } = require("child_process");
    const email = execSync("git config user.email", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return email || null;
  } catch { return null; }
}
import { loadPolicy, describePolicy, policyRequiresAudit } from "../core/policy";
import { AuditLogger, defaultAuditDir, readAuditEvents, verifyAuditChain } from "../core/audit";
import { loadFileConfig } from "./config-file";
import { createCliHumanDiagnostics, createCliJsonDiagnostics, Diagnostics } from "../core/diagnostics";

const program = new Command();
const humanDiagnostics = createCliHumanDiagnostics();
const jsonDiagnostics = createCliJsonDiagnostics();
const outputJson = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const outputText = (message: string) => humanDiagnostics.progress(message.endsWith("\n") ? message : message + "\n");
const diagnosticsFor = (opts: { json?: boolean }): Diagnostics => opts.json ? jsonDiagnostics : humanDiagnostics;
/** Report a misconfiguration and stop. Passed to buildSession so wiring code
 *  stays free of CLI exit policy. */
// Explicitly typed so TypeScript treats a call as terminating control flow and
// narrows afterwards; an inferred `never` return does not qualify.
const cliFatal: (message: string) => never = (message) => {
  humanDiagnostics.error(message);
  process.exit(1);
};

function validateConfig(config: OpenContextConfig): void {
  const { provider, apiKey, baseUrl } = config.embedding;
  // On platforms with no sqlite-vec build the engine runs keyword-only and
  // never embeds — demanding an API key there would block the only mode that
  // works. The probe is resolution-only (no dlopen): if the package resolves
  // but fails to load, the engine throws its own clearer error later.
  const embedsAreUsable = SqliteStore.sqliteVecResolvable();
  if (provider === "openai" && !apiKey && embedsAreUsable) {
    throw new Error("OPENAI_API_KEY is required for OpenAI embeddings. Set it via --api-key, OPENAI_API_KEY env var, or OCE_EMBEDDING_API_KEY env var.");
  }
  if (provider === "voyage" && !apiKey && embedsAreUsable) {
    throw new Error("VOYAGE_API_KEY is required for Voyage embeddings. Set it via --api-key, VOYAGE_API_KEY env var, or OCE_EMBEDDING_API_KEY env var.");
  }
  if (provider === "ollama" && !baseUrl) {
    throw new Error("OLLAMA_BASE_URL is required for Ollama. Set it via --base-url, OLLAMA_BASE_URL env var, or OCE_EMBEDDING_BASE_URL env var.");
  }
  // provider "local" needs nothing: no key, no server.
}

function resolveConfig(opts: any, o: { requireCreds?: boolean } = {}): OpenContextConfig {
  const workspace = opts.workspace || process.cwd();
  // File config: user (~/.open-context/config.json) then workspace
  // (.open-context/config.json). Flags and env vars always win over files.
  const { config: file, warnings } = loadFileConfig(workspace);
  for (const w of warnings) diagnosticsFor(opts).warn(`⚠ config: ${w}`);
  // Whether anyone actually CHOSE an embedding provider, as opposed to getting
  // the default. The difference decides between a clear error and a working
  // keyword-only fallback below.
  const chosenProvider = opts.provider || process.env.OCE_EMBEDDING_PROVIDER || file.embedding?.provider;
  const provider = (chosenProvider || "voyage") as OpenContextConfig["embedding"]["provider"];
  const modelKey = opts.model || file.embedding?.model || DEFAULT_MODEL_FOR_PROVIDER[provider] || "voyage-code-3";
  const modelInfo = EMBEDDING_MODELS[modelKey];
  // The registry may map a short key to a fully-qualified model id (e.g.
  // "all-MiniLM-L6-v2" → "Xenova/all-MiniLM-L6-v2"); unknown keys pass through.
  const model = modelInfo?.model ?? modelKey;
  let apiKey: string | undefined, baseUrl: string | undefined, dimension = modelInfo?.dimension ?? 1024;
  const batchSize = modelInfo?.batchSize ?? 32;
  if (provider === "openai") { apiKey = opts.apiKey || process.env.OPENAI_API_KEY; baseUrl = opts.baseUrl || file.embedding?.baseUrl; }
  else if (provider === "voyage") { apiKey = opts.apiKey || process.env.VOYAGE_API_KEY; }
  else if (provider === "ollama") { baseUrl = opts.baseUrl || process.env.OLLAMA_BASE_URL || file.embedding?.baseUrl || "http://localhost:11434"; }
  const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const config: OpenContextConfig = {
    workspaceRoot: workspace,
    embedding: { provider, model, apiKey, baseUrl, dimension, batchSize },
    storePath: opts.storePath ?? file.storePath,
    maxFileSize: num(opts.maxFileSize) ?? file.maxFileSize,
    chunkSize: num(opts.chunkSize) ?? file.chunkSize,
    chunkOverlap: num(opts.chunkOverlap) ?? file.chunkOverlap,
    ...(file.search && (file.search.topK !== undefined || file.search.minScore !== undefined)
      ? { search: { ...(file.search.topK !== undefined ? { topK: file.search.topK } : {}), ...(file.search.minScore !== undefined ? { minScore: file.search.minScore } : {}) } }
      : {}),
    // Cache is on for the CLI (commander's --no-embed-cache sets false).
    embedCache: opts.embedCache !== false && (file.embedCache ?? true),
  };
  if (provider === "none") {
    config.keywordOnly = "explicit";
  } else if (!chosenProvider && !config.embedding.apiKey && SqliteStore.sqliteVecResolvable()) {
    // Nothing chosen and no key for the default provider. This is where every
    // new user starts — including everyone following `oce setup` with a free
    // LLM key — and crashing here meant the product did not work at all until
    // they paid for embeddings. Keyword-only (BM25) search works right now;
    // semantic ranking is one `oce setup` away. The store refuses this
    // fallback if it would cost an existing vector index (see keywordOnly).
    config.keywordOnly = "fallback";
    if (!keywordNoticeShown) {
      keywordNoticeShown = true;
      diagnosticsFor(opts).warn("ⓘ No embedding provider configured — using keyword search. Run 'oce setup' to enable semantic search (free options available).");
    }
  }
  // requireCreds false = the command won't embed (e.g. exporting an existing
  // index) — don't demand API keys it will never use.
  if (o.requireCreds !== false && !config.keywordOnly) validateConfig(config);
  return config;
}

/** The fallback notice is printed once per process, not once per resolve. */
let keywordNoticeShown = false;

/** The flags every store-touching command shares. */
function withStoreOptions(cmd: import("commander").Command): import("commander").Command {
  return cmd
    .option("--store-path <path>", "Custom store directory (default: .open-context/)")
    .option("--chunk-size <lines>", "Lines per chunk for non-AST files (default 80)")
    .option("--chunk-overlap <lines>", "Overlap between chunks (default 15)")
    .option("--max-file-size <bytes>", "Skip files larger than this (default 1 MiB)");
}

/** Embedder stand-in for commands that must open a store but never embed. */
function staticEmbedder(embedding: OpenContextConfig["embedding"]): NonNullable<OpenContextConfig["embedder"]> {
  return {
    embed: async () => { throw new Error("This command does not embed; re-run without --no-index / --no-reconcile to index."); },
    getDimension: () => embedding.dimension,
    getModel: () => embedding.model,
  };
}

/** Gate a CLI command on the team-index entitlement with a clear upsell. */
function requireTeamIndex(command: string): void {
  const license = getLicense();
  if (!isEntitled(license, "team-index")) {
    humanDiagnostics.error(`'oce ${command}' is a Team feature. Activate a license with 'oce activate <key>' (status: 'oce license').`);
    process.exit(1);
  }
}

program.name("oce").description("Open Context Engine").version(packageVersion());

withStoreOptions(program.command("index").description("Index workspace").option("-w, --workspace <path>", "Workspace root", process.cwd()).option("-p, --provider <provider>", "Embedding provider").option("-m, --model <model>", "Embedding model").option("--api-key <key>", "API key").option("--incremental", "Incremental").option("--no-embed-cache", "Disable the shared embedding cache")).action(async (opts) => {
  const ctx = await OpenContext.create(resolveConfig(opts));
  outputText("Indexing..."); const r = opts.incremental ? await ctx.incrementalIndex((s,c,t) => t > 0 && humanDiagnostics.progress(`\r[${s}] ${c}/${t}`)) : await ctx.indexWorkspace((s,c,t) => t > 0 && humanDiagnostics.progress(`\r[${s}] ${c}/${t}`));
  outputText(`\nDone in ${r.duration}ms | New: ${r.newlyIndexed.length} | Existing: ${r.alreadyIndexed.length} | Removed: ${r.removed.length} | Chunks: ${ctx.getChunkCount()}`);
  const degraded = keywordOnlyWarning(ctx.getStatus());
  if (degraded) humanDiagnostics.error(degraded);
  if (r.failed?.length) {
    humanDiagnostics.error(`\n⚠ ${r.failed.length} file(s) failed to embed and will be retried on the next index run.`);
    if (r.failedReason) humanDiagnostics.error(`  Reason: ${r.failedReason}`);
    process.exitCode = 1;
  }
});

withStoreOptions(program.command("search <query>").description("Search codebase").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").option("-k, --top-k <n>", "Max results").option("--json", "Emit results as JSON (path, lines, score, snippet)")).action(async (query, opts) => {
  const ctx = await OpenContext.create(resolveConfig(opts));
  try {
    if (opts.json) {
      const results = await ctx.searchRaw(query, opts.topK ? Number(opts.topK) : undefined);
      outputJson(results.map(r => ({
        path: r.chunk.path,
        startLine: r.chunk.startLine,
        endLine: r.chunk.endLine,
        score: r.score,
        vectorScore: r.vectorScore,
        rerankScore: r.rerankScore,
        symbol: r.chunk.symbolName,
        snippet: r.chunk.contents.slice(0, 400),
      })));
    } else {
      outputText(await ctx.search(query));
    }
  } finally {
    ctx.close();
  }
});

withStoreOptions(program.command("mcp").description("Run MCP server (stdio by default; --http for a shared Streamable HTTP endpoint). Indexes on startup and watches for changes.")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("-p, --provider <provider>", "Provider")
  .option("-m, --model <model>", "Model")
  .option("--api-key <key>", "API key"))
  .option("--no-watch", "Do not keep the index live (no file watching)")
  .option("--http", "Serve over Streamable HTTP instead of stdio")
  .option("--port <n>", "HTTP port (with --http)", "8940")
  .option("--host <host>", "HTTP bind host (with --http; default loopback-only)", "127.0.0.1")
  .option("--auth-token <token>", "Require 'Authorization: Bearer <token>' on HTTP requests (or set OCE_MCP_AUTH_TOKEN)")
  .option("--audit", "Append every MCP tool invocation to the workspace audit log")
  .option("--no-embed-cache", "Disable the shared embedding cache")
  .action(async (opts) => {
    const config = resolveConfig(opts);
    let audit: AuditLogger | undefined;
    const policy = loadPolicy(config.workspaceRoot);
    if (opts.audit || policyRequiresAudit(policy)) {
      audit = new AuditLogger({ dir: defaultAuditDir(config.workspaceRoot, config.storePath) });
    }
    await runMCPServer(config, {
      watch: opts.watch,
      audit,
      ...(opts.http ? { http: { port: Number(opts.port), host: opts.host, authToken: opts.authToken || process.env.OCE_MCP_AUTH_TOKEN || undefined } } : {}),
    });
  });

withStoreOptions(program.command("watch").description("Index the workspace and keep it live as files change").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").option("--no-embed-cache", "Disable the shared embedding cache")).action(async (opts) => {
  const config = resolveConfig(opts);
  const { createLiveContext } = await import("../core/live-index");
  outputText(`Indexing ${config.workspaceRoot} ...`);
  const handle = await createLiveContext(config, {
    onProgress: (s, c, t) => t > 0 && humanDiagnostics.progress(`\r[${s}] ${c}/${t}   `),
    onReindex: (r) => outputText(`\n[reindex] +${r.newlyIndexed.length} new, ${r.removed.length} removed (${r.duration}ms) | ${handle.context.getChunkCount()} chunks${r.failed?.length ? ` | ⚠ ${r.failed.length} failed (will retry)` : ""}`),
    onError: (e) => humanDiagnostics.error(`\n[watch error] ${e.message}`),
  });
  const degraded = keywordOnlyWarning(handle.context.getStatus());
  if (degraded) humanDiagnostics.error(degraded);
  outputText(`\nWatching for changes — ${handle.context.getChunkCount()} chunks indexed. Press Ctrl+C to stop.`);
  const stop = async () => { await handle.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});

withStoreOptions(program.command("agent", { isDefault: true }).description("Interactive coding agent (default command — bare `oce` starts it)")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("-p, --provider <provider>", "LLM provider: openai | anthropic | google | ollama | custom")
  .option("--llm-model <model>", "LLM model (default: provider-appropriate)")
  .option("--llm-base-url <url>", "LLM endpoint override (custom/ollama — e.g. an LM Studio or remote Ollama URL)")
  .option("--embedding-provider <provider>", "Embedding provider (defaults to config file / voyage — separate from the LLM provider)")
  .option("--embedding-model <model>", "Embedding model")
  .option("--api-key <key>", "LLM API key"))
  .option("--print <query>", "Non-interactive: answer one query and exit")
  .option("--json", "With --print: emit {answer, stats, toolCalls} as JSON")
  .option("--allow-edits", "(--print only) enable file-edit tools; interactive sessions have them behind approvals")
  .option("--allow-shell", "(--print only) enable the run-command tool; interactive sessions have it behind approvals")
  .option("--auto-edit", "Approval mode: file edits run without asking, shell still asks")
  .option("--full-auto", "Approval mode: nothing asks (containers/CI)")
  .option("--continue", "Resume the most recent session in this workspace")
  .option("--resume <id>", "Resume a specific saved session (see /sessions)")
  .option("--no-plan", "Disable the agent's update-plan tool")
  .option("--no-delegate", "Disable the sub-agent delegate tool")
  .option("--no-env", "Do not inject platform/git/index facts into the system prompt")
  .option("--no-index", "Skip the startup index (use the existing index as-is)")
  .option("--watch", "Keep the index live as files change during the session")
  .option("--route", "Route each query to a cost-appropriate model tier (fast/standard/reasoning)")
  .option("--memory", "Remember codebase insights across sessions (.open-context/memories.json)")
  .option("--audit", "Append runs and tool calls to the tamper-evident audit log (.open-context/audit/)")
  .option("--no-embed-cache", "Disable the shared embedding cache")
  .option("--classic", "Use the line-printer REPL instead of the full-screen Trace interface")
  .action(async (opts) => {
  const interactive = !opts.print;
  const diag = diagnosticsFor(opts);
  // The full-screen interface needs a real terminal and the retrieval
  // telemetry; --print, a pipe, or a dumb terminal falls back to the REPL,
  // which stays a first-class path rather than a legacy one.
  const useTui = interactive && !opts.classic && !!process.stdout.isTTY && process.env.TERM !== "dumb";
  const built = await buildSession({
    opts, diag, interactive, traced: useTui,
    resolveConfig: (o) => resolveConfig(o),
    fatal: cliFatal,
  });
  const { ctx, config, agent, plan, permissions, sessionStore, sessionId, editLog, audit, memory, model, provider, close } = built;

  if (opts.print) {
    const toolCallLog: { name: string; ok: boolean }[] = [];
    const stream = (ev: any) => {
      if (opts.json) {
        if (ev.type === "tool_result") toolCallLog.push({ name: ev.toolResult.name, ok: !ev.toolResult.error });
        return; // JSON mode: stdout carries exactly one JSON document
      }
      if (ev.type === "text") process.stdout.write(ev.text);
      else if (ev.type === "model_selected") humanDiagnostics.progress(`[routed: ${ev.tier.name} → ${ev.tier.model}]\n`);
      else if (ev.type === "tool_call") humanDiagnostics.progress(`[tool ${ev.toolCall.name}] ${JSON.stringify(ev.toolCall.arguments)}\n`);
      else if (ev.type === "tool_result") humanDiagnostics.progress(`[tool ${ev.toolResult.name} result: ${ev.toolResult.result.length} chars]\n`);
      else if (ev.type === "retry") humanDiagnostics.progress(`[retry attempt ${ev.retryAttempt} in ${ev.retryDelayMs}ms: ${ev.retryReason}]\n`);
      else if (ev.type === "history_compacted") humanDiagnostics.progress(`[compacted ${ev.droppedMessages} messages]\n`);
      else if (ev.type === "run_end" && ev.stats) {
        const s = ev.stats;
        const tokens = s.usage.inputTokens || s.usage.outputTokens ? `, ${s.usage.inputTokens} in / ${s.usage.outputTokens} out tokens` : "";
        humanDiagnostics.progress(`\n[${s.steps} step${s.steps === 1 ? "" : "s"}, ${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}${s.toolErrors ? ` (${s.toolErrors} errored)` : ""}${tokens}, ${(s.durationMs / 1000).toFixed(1)}s]\n`);
      }
    };
    const answer = await agent.run(opts.print, { onStream: stream });
    if (opts.json) {
      outputJson({ answer, stats: agent.getLastRunStats(), toolCalls: toolCallLog });
    } else {
      process.stdout.write("\n");
    }
    try { sessionStore.save(sessionId, opts.print, agent.exportSession(), 1); } catch {}
    await close();
    return;
  }

  if (useTui && built.trace) {
    // Lazy: `oce index`, `search`, and `mcp` never load the renderer.
    const { runTui } = await import("../trace/tui");
    await runTui({ session: built.trace });
    await close();
    return;
  }

  await runRepl({
    agent,
    plan,
    permissions,
    sessionStore,
    sessionId,
    editLog,
    banner: {
      model,
      provider,
      workspace: config.workspaceRoot,
      index: `${ctx.getChunkCount().toLocaleString()} chunks · ${ctx.getStatus().searchMode}`,
      mode: permissions.getMode(),
      extras: [
        ...(opts.route ? ["model routing on"] : []),
        ...(memory ? [`memory on (${memory.getAll().length} entries)`] : []),
        ...(audit ? ["audit on"] : []),
      ],
    },
  });
  await close();
});

withStoreOptions(program.command("trace").description("Open Trace — the agent workspace: watch retrieval, inspect the context window, review and rewind")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("-p, --provider <provider>", "LLM provider: openai | anthropic | google | ollama | custom")
  .option("--llm-model <model>", "LLM model (default: provider-appropriate)")
  .option("--llm-base-url <url>", "LLM endpoint override (custom/ollama)")
  .option("--embedding-provider <provider>", "Embedding provider (separate from the LLM provider)")
  .option("--embedding-model <model>", "Embedding model")
  .option("--api-key <key>", "LLM API key"))
  .option("--port <n>", "Port to listen on (default: an open one)")
  .option("--host <host>", "Interface to bind (default 127.0.0.1 — loopback only)")
  .option("--no-open", "Do not open a browser")
  .option("--headless", "Serve the API only; do not serve Studio or open a browser")
  .option("--no-parallel", "Single session only; do not offer git-worktree-isolated parallel sessions")
  .option("--auto-edit", "Approval mode: file edits run without asking, shell still asks")
  .option("--full-auto", "Approval mode: nothing asks (containers/CI)")
  .option("--continue", "Resume the most recent session in this workspace")
  .option("--resume <id>", "Resume a specific saved session")
  .option("--no-plan", "Disable the agent's update-plan tool")
  .option("--no-delegate", "Disable the sub-agent delegate tool")
  .option("--no-env", "Do not inject platform/git/index facts into the system prompt")
  .option("--no-index", "Skip the startup index (use the existing index as-is)")
  .option("--watch", "Keep the index live as files change during the session")
  .option("--route", "Route each query to a cost-appropriate model tier")
  .option("--memory", "Remember codebase insights across sessions")
  .option("--audit", "Append runs and tool calls to the tamper-evident audit log")
  .option("--no-embed-cache", "Disable the shared embedding cache")
  .action(async (opts) => {
  const diag = diagnosticsFor(opts);

  // Resolve the branch BEFORE building, so the primary session reports which
  // checkout it is on. Once siblings exist, "which one am I looking at" is the
  // first question, and an unlabelled main session is the confusing one.
  const { WorktreeManager } = await import("../trace/worktree");
  const worktrees = new WorktreeManager({ repoRoot: opts.workspace || process.cwd() });
  const parallel = opts.parallel !== false && await worktrees.isRepo();
  const mainBranch = parallel ? (await worktrees.list()).find(w => w.main)?.branch : undefined;

  const built = await buildSession({
    opts: { ...opts, branch: mainBranch },
    diag, interactive: true, traced: true,
    resolveConfig: (o) => resolveConfig(o),
    fatal: cliFatal,
  });
  if (!built.trace) cliFatal("Trace session could not be built.");

  const { startTraceServer } = await import("../trace/server");
  const pathMod = await import("path");

  // Parallel sessions need git worktrees for isolation: two agents editing one
  // checkout see each other's half-finished edits. Without a repository the
  // harness runs one session, which is the pre-existing behaviour.
  const { SessionRegistry } = await import("../trace/registry");
  if (!parallel && opts.parallel !== false) {
    diag.progress("Not a git repository — running a single session.\n");
  }

  const registry = new SessionRegistry({
    ...(parallel ? { worktrees } : {}),
    build: async ({ workspace, title, branch }) => {
      // A sibling session is the same stack rooted at its own worktree.
      const child = await buildSession({
        opts: { ...opts, workspace: workspace || opts.workspace, branch, index: opts.index },
        diag, interactive: true, traced: true,
        resolveConfig: (o) => resolveConfig(o),
        fatal: (message) => { throw new Error(message); },
      });
      if (!child.trace) throw new Error(`Could not start a session for ${title}.`);
      return { session: child.trace, close: child.close };
    },
  });
  registry.adopt(built.sessionId, { session: built.trace, close: built.close }, {
    title: mainBranch ?? "main",
    workspace: built.config.workspaceRoot,
    branch: mainBranch,
  });

  // Assets sit beside the compiled server (dist/trace/studio). Absent until
  // `npm run build:studio` has run — the API still serves, and the static
  // handler says so rather than 404ing blankly.
  const staticDir = pathMod.join(__dirname, "..", "trace", "studio");
  const server = await startTraceServer({
    session: built.trace,
    ...(parallel ? { registry } : {}),
    port: opts.port ? Number(opts.port) : 0,
    host: opts.host,
    ...(opts.headless ? {} : { staticDir }),
    onLog: (m) => diag.progress(m + "\n"),
  });

  outputText(`\n  Trace  ${server.url}\n  ${built.provider}/${built.model} · ${built.ctx.getChunkCount().toLocaleString()} chunks · ${built.permissions.getMode()}\n  Ctrl+C to stop.\n`);
  if (opts.open !== false && !opts.headless) await openBrowser(server.url, diag);

  // The server owns the process from here; Ctrl+C unwinds both it and the index.
  await new Promise<void>(resolve => {
    const stop = () => { process.off("SIGINT", stop); resolve(); };
    process.on("SIGINT", stop);
  });
  await server.close();
  await registry.closeAll();
});

/** Best-effort browser launch. A failure is a hint, not an error — the URL is
 *  already on screen and remains usable. */
async function openBrowser(url: string, diag: Diagnostics): Promise<void> {
  const { spawn } = await import("child_process");
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    diag.progress("Could not open a browser — copy the URL above.\n");
  }
}

program.command("eval").description("Score retrieval quality against a labeled query set (recall@k, MRR, nDCG)")
  .requiredOption("--cases <file>", "JSON file of eval cases: [{ id, query, expectedPaths: [..] }]")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("-p, --provider <provider>", "Embedding provider")
  .option("-m, --model <model>", "Embedding model")
  .option("--api-key <key>", "API key")
  .option("-k, --top-k <n>", "Metric cutoff: gold files must rank in the top k unique files", "10")
  .option("--retrieve-k <n>", "Chunks requested per query before files are deduped (default 3x top-k)")
  .option("--no-expand", "Disable symbol/graph expansion — measures what expansion contributes")
  .option("--no-packed", "Skip the packed-context check (one extra search per case)")
  .option("--no-index", "Skip the incremental index before evaluating (use the index as-is)")
  .option("--out <file>", "Write the full report JSON to this file")
  .option("--baseline <file>", "Compare against a previously saved report and print deltas")
  .option("--json", "Print the report as JSON to stdout (suppresses the table)")
  .action(async (opts: any) => {
    const fs = await import("fs");
    const diag = diagnosticsFor(opts);
    const { runEval, parseEvalCases, compareReports } = await import("../eval/runner");
    const cases = parseEvalCases(JSON.parse(await fs.promises.readFile(opts.cases, "utf8")));
    const k = Math.max(1, Number(opts.topK));
    const retrieveK = opts.retrieveK ? Math.max(k, Number(opts.retrieveK)) : k * 3;
    const ctx = await OpenContext.create(resolveConfig(opts));
    try {
      if (opts.index !== false) {
        diag.info("Refreshing index...");
        await ctx.incrementalIndex((s, c, t) => t > 0 && diag.progress(`\r[${s}] ${c}/${t}   `));
        diag.progress("\n");
      }
      if (!ctx.getChunkCount()) {
        humanDiagnostics.error("Index is empty — run 'oce index' first or drop --no-index.");
        process.exit(1);
      }
      const expand = opts.expand !== false;
      const report = await runEval(
        (query) => ctx.searchRaw(query, retrieveK, { expandSymbols: expand }),
        cases,
        {
          k,
          // The packed check runs the REAL search() pipeline (default topK +
          // packing budget) — gold presence in it is what the LLM actually sees.
          packedSearch: opts.packed !== false ? (query) => ctx.search(query, undefined, { expandSymbols: expand }) : undefined,
          onCase: (r, i, total) => {
            if (opts.json) return;
            const mark = r.error ? "✗ ERR" : r.metrics.hit ? `✓ @${r.metrics.firstHitRank}` : "✗ miss";
            const ctxMark = r.metrics.contextRecall === undefined ? "" : ` ctx=${r.metrics.contextRecall > 0 ? "✓" : "✗"}`;
            outputText(`[${String(i + 1).padStart(2)}/${total}] ${mark.padEnd(7)} ndcg=${r.metrics.ndcg.toFixed(3)}${ctxMark} ${r.id}${r.error ? ` (${r.error})` : ""}`);
          },
        },
      );
      const mode = ctx.getStatus().searchMode;
      report.searchMode = mode; // persisted into --out/--json so saved baselines carry their mode
      if (opts.out) await fs.promises.writeFile(opts.out, JSON.stringify(report, null, 2));
      if (opts.json) { outputJson(report); return; }
      const a = report.aggregate;
      outputText(`\nk=${k} retrieveK=${retrieveK} expand=${expand} | cases: ${a.cases}${mode === "keyword-only" ? " | ⚠ KEYWORD-ONLY MODE — not comparable to hybrid baselines" : ""}`);
      const ctxLine = a.contextRecall !== undefined ? `  ctx-recall=${a.contextRecall.toFixed(3)}  ctx-hit-rate=${(a.contextHitRate ?? 0).toFixed(3)}` : "";
      outputText(`recall@k=${a.recallAtK.toFixed(3)}  MRR=${a.mrr.toFixed(3)}  nDCG@k=${a.ndcgAtK.toFixed(3)}  hit-rate=${a.hitRate.toFixed(3)}${ctxLine}  mean-latency=${report.meanLatencyMs.toFixed(0)}ms`);
      const misses = report.results.filter(r => !r.metrics.hit);
      if (misses.length) {
        outputText(`\nMisses (${misses.length}):`);
        for (const m of misses) outputText(`  ${m.id}: expected ${m.expectedPaths.join(", ")} — got [${m.retrievedFiles.slice(0, 3).join(", ")}${m.retrievedFiles.length > 3 ? ", …" : ""}]`);
      }
      if (opts.baseline) {
        const baseline = JSON.parse(await fs.promises.readFile(opts.baseline, "utf8"));
        if (baseline.searchMode && baseline.searchMode !== mode) {
          outputText(`\n⚠ baseline was ${baseline.searchMode}, this run is ${mode} — deltas reflect the mode change, not retrieval quality.`);
        } else if (!baseline.searchMode && mode === "keyword-only") {
          outputText(`\n⚠ baseline has no search-mode marker (likely hybrid); this run is keyword-only — deltas are not meaningful.`);
        }
        const cmp = compareReports(baseline, report);
        const sign = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
        const ctxDelta = cmp.aggregate.contextRecall !== undefined ? ` Δctx-recall=${sign(cmp.aggregate.contextRecall)} Δctx-hit=${sign(cmp.aggregate.contextHitRate ?? 0)}` : "";
        outputText(`\nvs baseline (${cmp.perCase.length} shared cases): ΔnDCG=${sign(cmp.aggregate.ndcgAtK)} ΔMRR=${sign(cmp.aggregate.mrr)} Δrecall=${sign(cmp.aggregate.recallAtK)} Δhit-rate=${sign(cmp.aggregate.hitRate)}${ctxDelta}`);
        outputText(`improved: ${cmp.improved}  regressed: ${cmp.regressed}  unchanged: ${cmp.unchanged}`);
        for (const d of cmp.perCase.filter(d => d.direction === "regressed")) outputText(`  ▼ ${d.id} ΔnDCG=${sign(d.ndcg)}`);
        if (cmp.onlyInBaseline.length || cmp.onlyInCurrent.length) {
          outputText(`(cases only in baseline: ${cmp.onlyInBaseline.length}; only in current: ${cmp.onlyInCurrent.length} — excluded from deltas)`);
        }
      }
    } finally {
      ctx.close();
    }
  });

program.command("multi-search <query>").description("Search across multiple repositories at once (Team license required)")
  .option("--repos <paths>", "Comma-separated repo paths to search")
  .option("-p, --provider <provider>", "Embedding provider")
  .option("-m, --model <model>", "Embedding model")
  .option("--api-key <key>", "API key")
  .option("-k, --top-k <n>", "Max results", "15")
  .option("--no-index", "Skip indexing; query the existing per-repo indexes")
  .action(async (query: string, opts: any) => {
    const ee = await loadEnterpriseEdition(getLicense());
    if (!ee) {
      humanDiagnostics.error("Multi-repo search is a Team feature. Activate a license with 'oce activate <key>' (check 'oce license').");
      process.exit(1);
    }
    const repoPaths = String(opts.repos || "").split(",").map((s: string) => s.trim()).filter(Boolean);
    if (!repoPaths.length) { humanDiagnostics.error("Specify repos with --repos <path1,path2,...>."); process.exit(1); }
    const base = resolveConfig(opts);
    const mr = await ee.createMultiRepoContext({ repos: repoPaths.map((p: string) => ({ path: p })), base });
    if (opts.index !== false) {
      humanDiagnostics.progress(`Indexing ${mr.repoNames().length} repo(s): ${mr.repoNames().join(", ")} ...\n`);
      const counts = await mr.indexAll((repo: string, s: string, c: number, t: number) => t > 0 && humanDiagnostics.progress(`\r[${repo}] ${s} ${c}/${t}     `));
      humanDiagnostics.progress("\n" + counts.map((c: any) => `${c.repo}: ${c.chunks} chunks`).join(" | ") + "\n\n");
    }
    outputText(await mr.searchFormatted(query, Number(opts.topK)));
    mr.close();
  });

program.command("setup").description("Get a working model — shows the free options and writes the config")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("-p, --provider <name>", "Configure this provider directly instead of listing options")
  .option("--llm-model <model>", "Model to record (default: the provider's)")
  .option("--embeddings <provider>", "Record the embedding provider for semantic search: ollama | voyage | openai | local | none")
  .option("--json", "Emit the detected state as JSON")
  .action(async (opts: any) => {
    const { PROVIDER_PRESETS, findPreset, freePresets, keyFor, probeOllama } = await import("../agent/presets");
    const fsMod = await import("fs");
    const pathMod = await import("path");

    if (opts.embeddings) {
      const choice = String(opts.embeddings).toLowerCase();
      const allowed = ["ollama", "voyage", "openai", "local", "none"];
      if (!allowed.includes(choice)) {
        humanDiagnostics.error(`Unknown embedding provider '${choice}'. Use one of: ${allowed.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const dir = pathMod.join(opts.workspace || process.cwd(), ".open-context");
      const file = pathMod.join(dir, "config.json");
      let existing: any = {};
      try { existing = JSON.parse(fsMod.readFileSync(file, "utf8")); } catch {}
      const next = { ...existing, embedding: { provider: choice, model: DEFAULT_MODEL_FOR_PROVIDER[choice as keyof typeof DEFAULT_MODEL_FOR_PROVIDER] } };
      fsMod.mkdirSync(dir, { recursive: true });
      fsMod.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      outputText(`Wrote ${file}`);
      outputText(`  embeddings · ${choice}${choice === "none" ? " (keyword search)" : ` · ${next.embedding.model}`}`);
      // Switching providers changes the embedding space, so the index rebuilds.
      if (choice !== "none") outputText(`\nNext: oce index   (rebuilds the index with ${choice} embeddings)`);
      if (!opts.provider) return;
    }

    const ollama = await probeOllama();
    const detected = PROVIDER_PRESETS
      .map(p => ({ preset: p, key: keyFor(p) }))
      .filter(d => d.key || (d.preset.id === "ollama" && ollama.up));

    if (opts.json) {
      outputJson({
        ollama,
        ready: detected.map(d => d.preset.id),
        presets: PROVIDER_PRESETS.map(p => ({ id: p.id, label: p.label, cost: p.cost, model: p.model })),
      });
      return;
    }

    // Writing the choice is the whole point: the next `oce trace` should just work.
    const write = (id: string): void => {
      const preset = findPreset(id);
      if (!preset) { humanDiagnostics.error(`Unknown provider '${id}'. Try one of: ${PROVIDER_PRESETS.map(p => p.id).join(", ")}`); process.exitCode = 1; return; }
      const dir = pathMod.join(opts.workspace || process.cwd(), ".open-context");
      const file = pathMod.join(dir, "config.json");
      let existing: any = {};
      try { existing = JSON.parse(fsMod.readFileSync(file, "utf8")); } catch {}
      const next = {
        ...existing,
        llm: {
          provider: preset.provider,
          model: opts.llmModel || preset.model,
          ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
        },
      };
      fsMod.mkdirSync(dir, { recursive: true });
      fsMod.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      outputText(`Wrote ${file}`);
      outputText(`  ${preset.label} · ${next.llm.model}`);
      const key = keyFor(preset);
      if (!key && preset.keyEnv.length) {
        outputText(`\nStill needed: ${preset.setup}`);
        outputText(`Then: export ${preset.keyEnv[0]}=...`);
      } else {
        outputText(`\nReady. Try:  oce trace`);
      }
    };

    if (opts.provider) return write(opts.provider);

    outputText("Open Context Engine — pick a model\n");
    if (ollama.up) {
      outputText(`✓ Ollama is running locally${ollama.models.length ? ` (${ollama.models.slice(0, 3).join(", ")})` : " — no models pulled yet"}`);
      outputText("  Free, offline, no key. Best default if you have the RAM.\n");
    }
    for (const d of detected.filter(d => d.key)) {
      outputText(`✓ ${d.preset.label} — key found in the environment`);
    }
    if (detected.length) outputText("");

    outputText("Free options:");
    for (const preset of freePresets()) {
      const ready = preset.id === "ollama" ? ollama.up : !!keyFor(preset);
      outputText(`  ${ready ? "✓" : " "} ${preset.id.padEnd(11)} ${preset.label}`);
      outputText(`      ${preset.note}`);
      if (!ready) outputText(`      ${preset.setup}`);
    }
    outputText("\nPaid:");
    for (const preset of PROVIDER_PRESETS.filter(p => p.cost === "paid")) {
      outputText(`  ${keyFor(preset) ? "✓" : " "} ${preset.id.padEnd(11)} ${preset.label}`);
    }

    // Retrieval has its own provider, separate from the chat model. Without
    // one the engine runs keyword search, which works — this is how to get
    // semantic ranking on top.
    const hasEmbedModel = ollama.models.some(m => m.startsWith("nomic-embed-text"));
    outputText("\nSemantic search (embeddings — separate from the chat model):");
    outputText(`  ${ollama.up && hasEmbedModel ? "✓" : " "} ollama      free, local — ollama pull nomic-embed-text`);
    outputText(`  ${process.env.VOYAGE_API_KEY ? "✓" : " "} voyage      best code retrieval — key at https://dash.voyageai.com`);
    outputText(`  ${process.env.OPENAI_API_KEY ? "✓" : " "} openai      text-embedding-3-small — uses OPENAI_API_KEY`);
    outputText(`    none        keyword search only (what runs when nothing is set)`);

    outputText(`\nChoose a chat model:   oce setup -p <name>`);
    outputText(`Choose embeddings:     oce setup --embeddings <name>`);
    outputText(`Or just run:           oce trace -p <name>`);
  });

program.command("status").description("Show index health: store, chunks, files, search mode, policy, license")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("--store-path <path>", "Custom store directory")
  .option("--json", "Emit as JSON")
  .action(async (opts: any) => {
    const fs = await import("fs");
    const pathMod = await import("path");
    const { defaultStorePath } = await import("../core/context");
    const config = resolveConfig(opts, { requireCreds: false });
    config.embedder = staticEmbedder(config.embedding);
    // `status` reports; it must never rebuild. Without this, running it without
    // naming the provider the index was built with silently wipes the index —
    // a read-only-sounding command destroying the thing it was asked about.
    config.readOnly = true;
    const storeDir = config.storePath || defaultStorePath(config.workspaceRoot);
    const dbPath = pathMod.join(storeDir, "context.db");
    const ctx = await OpenContext.create(config);
    try {
      const status = ctx.getStatus();
      const policy = ctx.getPolicy();
      const license = getLicense();
      let dbSizeBytes = 0;
      try { dbSizeBytes = fs.statSync(dbPath).size; } catch {}
      const report = {
        workspace: config.workspaceRoot,
        store: { dir: storeDir, dbSizeBytes },
        index: {
          chunks: ctx.getChunkCount(),
          searchMode: status.searchMode,
          ...(status.degradedReason ? { degradedReason: status.degradedReason } : {}),
          ...(status.staleReason ? { staleReason: status.staleReason } : {}),
        },
        embedding: { provider: config.embedding.provider, model: config.embedding.model, dimension: config.embedding.dimension },
        policy: policy ? { sources: policy.sources, locked: policy.locked, summary: describePolicy(policy) } : null,
        license: { plan: license.plan, valid: license.valid, ...(license.payload?.org ? { org: license.payload.org } : {}) },
      };
      if (opts.json) { outputJson(report); return; }
      outputText(`workspace  ${report.workspace}`);
      outputText(`store      ${storeDir} (${(dbSizeBytes / 1e6).toFixed(1)} MB)`);
      const mode = status.degradedKind === "keyword_only"
        ? "keyword search — no embedding provider (run 'oce setup' for semantic)"
        : `${report.index.searchMode}${status.degradedReason ? ` (${status.degradedReason})` : ""}`;
      outputText(`index      ${report.index.chunks.toLocaleString()} chunks · ${mode}`);
      if (status.staleReason) {
        outputText(`⚠ stale    ${status.staleReason} — run 'oce index' to rebuild.`);
      }
      outputText(`embedding  ${report.embedding.provider}/${report.embedding.model} (${report.embedding.dimension}d)`);
      outputText(`policy     ${report.policy ? report.policy.summary : "(disabled)"}`);
      outputText(`license    ${report.license.plan}${report.license.org ? ` (${report.license.org})` : ""}`);
    } finally {
      ctx.close();
    }
  });

program.command("clean").description("Delete the workspace's index store (sessions, memories, and audit logs are kept)")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("--store-path <path>", "Custom store directory")
  .option("--yes", "Confirm deletion (required)")
  .action(async (opts: any) => {
    const fs = await import("fs");
    const pathMod = await import("path");
    const { defaultStorePath } = await import("../core/context");
    const storeDir = opts.storePath || defaultStorePath(opts.workspace);
    const dbPath = pathMod.join(storeDir, "context.db");
    if (!fs.existsSync(dbPath)) { outputText(`No index database at ${dbPath}.`); return; }
    if (!opts.yes) {
      humanDiagnostics.error(`This deletes the index database at ${dbPath} (a re-index rebuilds it). Re-run with --yes to confirm.`);
      process.exit(1);
    }
    let removed = 0;
    for (const suffix of ["", "-wal", "-shm", ".pre-pull"]) {
      try { fs.unlinkSync(dbPath + suffix); removed++; } catch {}
    }
    outputText(`Removed ${removed} file(s) from ${storeDir}. Run 'oce index' to rebuild.`);
  });

program.command("push-index <dest>").description("Export the index as an artifact and publish it — Team feature. <dest> is a file path or HTTP(S) URL (PUT; presigned S3/GCS URLs work).")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("-p, --provider <provider>", "Embedding provider")
  .option("-m, --model <model>", "Embedding model")
  .option("--api-key <key>", "API key")
  .option("--store-path <path>", "Custom store directory")
  .option("--token <token>", "Bearer token for HTTP uploads (or OCE_INDEX_TOKEN)")
  .option("--no-index", "Export the store as-is without refreshing the index first")
  .option("--no-embed-cache", "Disable the shared embedding cache")
  .action(async (dest: string, opts: any) => {
    requireTeamIndex("push-index");
    const refresh = opts.index !== false;
    const config = resolveConfig(opts, { requireCreds: refresh });
    if (!refresh) config.embedder = staticEmbedder(config.embedding);
    const { pushArtifact } = await import("../core/index-artifact");
    const os = await import("os");
    const fs = await import("fs");
    const pathMod = await import("path");
    const ctx = await OpenContext.create(config);
    try {
      if (refresh) {
        humanDiagnostics.info("Refreshing index...");
        await ctx.incrementalIndex((s, c, t) => t > 0 && humanDiagnostics.progress(`\r[${s}] ${c}/${t}   `));
        humanDiagnostics.progress("\n");
      }
      if (!ctx.getChunkCount()) { humanDiagnostics.error("Index is empty — run 'oce index' first."); process.exit(1); }
      const isLocal = !/^https?:\/\//i.test(dest);
      const artifactFile = isLocal ? dest : pathMod.join(os.tmpdir(), `oce-index-${Date.now()}.db.gz`);
      const manifest = await ctx.exportIndex(artifactFile);
      if (!isLocal) {
        humanDiagnostics.progress(`Uploading to ${dest} ...\n`);
        await pushArtifact(artifactFile, dest, { token: opts.token || process.env.OCE_INDEX_TOKEN });
        await fs.promises.rm(artifactFile, { force: true });
      }
      const size = isLocal ? ` (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)` : "";
      outputText(`Published index artifact${size}: ${manifest.chunkCount} chunks, ${manifest.fileCount} files, ${manifest.embeddingModel} ${manifest.dimension}d${manifest.git?.commit ? `, commit ${manifest.git.commit.slice(0, 8)}` : ""}.`);
      outputText(`Teammates install it with: oce pull-index ${isLocal ? dest : "<url>"}`);
    } finally {
      ctx.close();
    }
  });

program.command("pull-index <src>").description("Install a team index artifact, then re-index only your local changes — Team feature. <src> is a file path or HTTP(S) URL.")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("-p, --provider <provider>", "Embedding provider")
  .option("-m, --model <model>", "Embedding model")
  .option("--api-key <key>", "API key")
  .option("--store-path <path>", "Custom store directory")
  .option("--token <token>", "Bearer token for HTTP downloads (or OCE_INDEX_TOKEN)")
  .option("--no-reconcile", "Install the artifact without re-indexing local changes")
  .option("--no-embed-cache", "Disable the shared embedding cache")
  .action(async (src: string, opts: any) => {
    requireTeamIndex("pull-index");
    const reconcile = opts.reconcile !== false;
    const config = resolveConfig(opts, { requireCreds: reconcile });
    const { pullArtifact, installArtifact } = await import("../core/index-artifact");
    const { defaultStorePath } = await import("../core/context");
    const os = await import("os");
    const fs = await import("fs");
    const pathMod = await import("path");
    const storeDir = config.storePath || defaultStorePath(config.workspaceRoot);
    const isLocal = !/^https?:\/\//i.test(src);
    let artifactFile = src;
    if (!isLocal) {
      artifactFile = pathMod.join(os.tmpdir(), `oce-index-pull-${Date.now()}.db.gz`);
      humanDiagnostics.progress(`Downloading ${src} ...\n`);
      await pullArtifact(src, artifactFile, { token: opts.token || process.env.OCE_INDEX_TOKEN });
    }
    try {
      const manifest = await installArtifact(artifactFile, storeDir, { model: config.embedding.model, dimension: config.embedding.dimension });
      outputText(`Installed team index: ${manifest.chunkCount} chunks, ${manifest.fileCount} files, built ${manifest.createdAt.slice(0, 19)}${manifest.git?.commit ? ` at commit ${manifest.git.commit.slice(0, 8)}` : ""}.`);
      if (reconcile) {
        const ctx = await OpenContext.create(config);
        try {
          humanDiagnostics.progress("Reconciling local changes...\n");
          const r = await ctx.incrementalIndex((s, c, t) => t > 0 && humanDiagnostics.progress(`\r[${s}] ${c}/${t}   `));
          humanDiagnostics.progress("\n");
          outputText(`Reconciled: ${r.newlyIndexed.length} file(s) re-embedded locally, ${r.alreadyIndexed.length} reused from the artifact, ${r.removed.length} removed.`);
          if (r.failed?.length) { humanDiagnostics.error(`⚠ ${r.failed.length} file(s) failed to embed — retried on the next index. ${r.failedReason ?? ""}`); process.exitCode = 1; }
        } finally {
          ctx.close();
        }
      } else {
        outputText("Skipped reconciliation (--no-reconcile) — run 'oce index --incremental' to fold in local changes.");
      }
    } finally {
      if (!isLocal) await fs.promises.rm(artifactFile, { force: true });
    }
  });

program.command("bench").description("Benchmark indexing throughput on this workspace (parse/chunk pipeline; no API calls)")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("--workers <n>", "Worker count for the parallel pass (default: auto)")
  .option("--json", "Print results as JSON")
  .action(async (opts: any) => {
    const diag = diagnosticsFor(opts);
    const { FileFilter } = await import("../core/file-filter");
    const { AstChunker } = await import("../core/ast-chunker");
    const { CodeChunker } = await import("../core/chunker");
    const { extractEdges } = await import("../core/graph-extractor");
    const { ChunkWorkerPool, defaultPoolSize } = await import("../core/chunk-pool");

    const filter = new FileFilter();
    diag.info("Collecting files...");
    const files = await filter.collectFiles(opts.workspace);
    const totalBytes = files.reduce((s, f) => s + f.contents.length, 0);

    const maxChunkChars = 80_000;
    const runInline = async () => {
      const chunker = new AstChunker({ maxChunkChars, fallback: new CodeChunker(undefined, undefined, maxChunkChars) });
      const start = Date.now();
      let chunkCount = 0, edgeCount = 0;
      for (const file of files) {
        const parsed = await chunker.parseFile(file);
        try {
          chunkCount += (await chunker.chunkFile(file, { parsed })).length;
          const lang = AstChunker.languageFor(file.path);
          if (lang) { try { edgeCount += extractEdges(file, lang, parsed?.tree ?? null).edges.length; } catch {} }
        } finally { parsed?.dispose(); }
      }
      const ms = Date.now() - start;
      chunker.dispose();
      return { ms, chunkCount, edgeCount };
    };

    diag.info(`Chunking ${files.length} files (${(totalBytes / 1e6).toFixed(1)} MB) in-process...`);
    const inline = await runInline();

    let pooled: { ms: number; chunkCount: number; edgeCount: number; workers: number } | null = null;
    if (ChunkWorkerPool.isAvailable()) {
      const workers = opts.workers ? Math.max(1, Number(opts.workers)) : defaultPoolSize();
      diag.info(`Chunking again with ${workers} worker thread(s)...`);
      const pool = new ChunkWorkerPool({ maxChunkChars, size: workers });
      const start = Date.now();
      const results = await pool.run(files);
      const ms = Date.now() - start;
      await pool.destroy();
      pooled = {
        ms,
        chunkCount: results.reduce((s, r) => s + r.chunks.length, 0),
        edgeCount: results.reduce((s, r) => s + r.edges.length, 0),
        workers,
      };
    } else {
      diag.warn("(worker pool unavailable — dist/core/chunk-worker.js not built; run 'npm run build')");
    }

    const report = {
      files: files.length,
      megabytes: +(totalBytes / 1e6).toFixed(2),
      inline: { ms: inline.ms, filesPerSec: +(files.length / (inline.ms / 1000)).toFixed(1), chunks: inline.chunkCount, edges: inline.edgeCount },
      ...(pooled ? {
        workers: {
          count: pooled.workers, ms: pooled.ms,
          filesPerSec: +(files.length / (pooled.ms / 1000)).toFixed(1),
          speedup: +(inline.ms / pooled.ms).toFixed(2),
        },
      } : {}),
    };
    if (opts.json) { outputJson(report); return; }
    outputText(`\nfiles: ${report.files}  size: ${report.megabytes} MB`);
    outputText(`in-process: ${inline.ms}ms  (${report.inline.filesPerSec} files/s, ${inline.chunkCount} chunks, ${inline.edgeCount} edges)`);
    if (pooled) outputText(`workers x${pooled.workers}: ${pooled.ms}ms  (${report.workers!.filesPerSec} files/s, speedup ${report.workers!.speedup}x)`);
  });

program.command("audit").description("Inspect the tamper-evident audit log")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("--store-path <path>", "Custom store directory (default: .open-context/)")
  .option("--type <type>", "Only events of this type (run-start, tool-call, run-end, mcp, …)")
  .option("--since <date>", "Only events at/after this ISO date/time")
  .option("--limit <n>", "Show only the last N matching events", "50")
  .option("--verify", "Verify the hash chain and report tampering")
  .option("--json", "Print raw JSONL events")
  .action((opts: any) => {
    const dir = defaultAuditDir(opts.workspace, opts.storePath);
    const all = readAuditEvents(dir);
    if (!all.length) { if (opts.json) outputJson([]); else outputText(`No audit events found in ${dir}.`); return; }
    if (opts.verify) {
      const v = verifyAuditChain(all);
      if (v.ok) outputText(`✓ chain intact — ${v.checked} events verified.`);
      else { humanDiagnostics.error(`✗ TAMPERED at seq ${v.brokenAtSeq}: ${v.reason} (${v.checked} events verified before the break)`); process.exitCode = 1; }
      return;
    }
    const events = readAuditEvents(dir, {
      type: opts.type,
      since: opts.since ? new Date(opts.since) : undefined,
      limit: Math.max(1, Number(opts.limit)),
    });
    if (opts.json) { outputJson(events); return; }
    for (const e of events) {
      const detail = Object.entries(e.data).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 120) : JSON.stringify(v)}`).join(" ");
      outputText(`${e.ts}  #${e.seq}  ${e.type.padEnd(10)} ${detail}`);
    }
    outputText(`\n${events.length} of ${all.length} events shown (${dir}). Use --verify to check integrity.`);
  });

program.command("policy").description("Show the effective policy for a workspace (user + workspace + org lock)")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("--json", "Print the effective policy as JSON")
  .action((opts: any) => {
    const p = loadPolicy(opts.workspace);
    if (opts.json) { outputJson(p); return; }
    outputText(describePolicy(p));
    if (p.sources.length) outputText(`Sources:\n${p.sources.map(s => `  - ${s}`).join("\n")}`);
    for (const w of p.warnings) outputText(`⚠ ${w}`);
  });

program.command("activate <key>").description("Activate a Team/Enterprise license key").action(async (key: string) => {
  // Opportunistic revocation refresh (only when a URL is configured — the
  // engine never phones home unprompted). Best-effort: offline still works.
  try { const { refreshRevocations } = await import("../core/license"); await refreshRevocations(); } catch {}
  const status = verifyLicenseToken(key);
  if (!status.valid) {
    const why = status.reason === "expired" ? "this license has expired"
      : status.reason === "bad-signature" ? "invalid signature (is the key correct and complete?)"
      : "malformed license key";
    humanDiagnostics.error(`Activation failed: ${why}.`);
    process.exit(1);
  }
  {
    const { loadCachedRevocations } = await import("../core/license");
    if (status.payload?.id && loadCachedRevocations()?.revoked.includes(status.payload.id)) {
      humanDiagnostics.error("Activation failed: this license has been revoked.");
      process.exit(1);
    }
  }
  // SSO-lite: a domain-bound license only activates for a matching identity.
  const domainCheck = checkOrgDomainBinding(status.payload, resolveActivationEmail());
  if (domainCheck === "mismatch") {
    humanDiagnostics.error(`Activation failed: this license is bound to @${status.payload?.orgDomain} email addresses, but your identity (git config user.email / OCE_ACTIVATION_EMAIL) does not match.`);
    process.exit(1);
  }
  if (domainCheck === "unverifiable") {
    humanDiagnostics.error(`⚠ License is bound to @${status.payload?.orgDomain} but no local email identity was found — proceeding. Set OCE_ACTIVATION_EMAIL or git config user.email to silence this.`);
  }
  const p = saveLicenseToken(key);
  const exp = status.payload?.exp ? new Date(status.payload.exp * 1000).toISOString().slice(0, 10) : "perpetual";
  outputText(`Activated ${status.plan} license for ${status.payload?.org} — ${status.payload?.seats} seat(s), expires ${exp}.`);
  outputText(`Saved to ${p}`);
});

program.command("license").description("Show the current license status")
  .option("--refresh [url]", "Fetch the signed revocation list (from the given URL or OCE_REVOCATION_URL) before checking")
  .action(async (opts: any) => {
  if (opts.refresh) {
    const { refreshRevocations } = await import("../core/license");
    const list = await refreshRevocations(typeof opts.refresh === "string" ? opts.refresh : undefined);
    if (list) outputText(`Revocation list refreshed (${list.revoked.length} entries, updated ${new Date(list.updatedAt * 1000).toISOString().slice(0, 10)}).`);
    else outputText("Revocation list not refreshed (no URL configured, or fetch/verify failed) — continuing with the cached list.");
  }
  const s = getLicense();
  if (!s.valid) {
    if (s.reason === "expired") outputText(`License expired (was ${s.payload?.plan} for ${s.payload?.org}). Running as Community (free) edition.`);
    else if (s.reason === "revoked") outputText(`License ${s.payload?.id} for ${s.payload?.org} has been REVOKED. Running as Community (free) edition — contact support if this is unexpected.`);
    else outputText("No active license — running as Community (free) edition. Activate with 'oce activate <key>'.");
    return;
  }
  const exp = s.payload?.exp ? new Date(s.payload.exp * 1000).toISOString().slice(0, 10) : "perpetual";
  outputText(`Plan:    ${s.plan}`);
  outputText(`Org:     ${s.payload?.org}`);
  outputText(`Seats:   ${s.payload?.seats}`);
  outputText(`Expires: ${exp}`);
  if (s.inGrace) outputText(`\n⚠ In grace period — ${s.daysLeft} day(s) left. Please renew to avoid interruption.`);
});

program.command("deactivate").description("Remove the saved license key").action(() => {
  outputText(clearLicense() ? "License removed — now running as Community edition." : "No license was active.");
});

// Every action is async. `parse()` left their rejections unhandled, so a
// misconfiguration surfaced as a raw Node stack trace — the first thing a new
// user saw. Print the message; keep the stack for OCE_DEBUG.
program.parseAsync().catch((err: any) => {
  humanDiagnostics.error(String(err?.message ?? err));
  if (process.env.OCE_DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
