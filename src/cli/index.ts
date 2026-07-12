#!/usr/bin/env node
import { Command } from "commander";
import { OpenContext } from "../core/context";
import { SqliteStore } from "../core/sqlite-store";
import { OpenContextConfig, EMBEDDING_MODELS, DEFAULT_MODEL_FOR_PROVIDER } from "../core/types";
import { runMCPServer } from "../mcp/server";
import { ContextAgent, defaultAgentTools, LLMProvider } from "../agent/agent";
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
import * as readline from "readline";

const program = new Command();

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
  const provider = (opts.provider || process.env.OCE_EMBEDDING_PROVIDER || "voyage") as OpenContextConfig["embedding"]["provider"];
  const modelKey = opts.model || DEFAULT_MODEL_FOR_PROVIDER[provider] || "voyage-code-3";
  const workspace = opts.workspace || process.cwd();
  const modelInfo = EMBEDDING_MODELS[modelKey];
  // The registry may map a short key to a fully-qualified model id (e.g.
  // "all-MiniLM-L6-v2" → "Xenova/all-MiniLM-L6-v2"); unknown keys pass through.
  const model = modelInfo?.model ?? modelKey;
  let apiKey: string | undefined, baseUrl: string | undefined, dimension = modelInfo?.dimension ?? 1024;
  const batchSize = modelInfo?.batchSize ?? 32;
  if (provider === "openai") { apiKey = opts.apiKey || process.env.OPENAI_API_KEY; baseUrl = opts.baseUrl; }
  else if (provider === "voyage") { apiKey = opts.apiKey || process.env.VOYAGE_API_KEY; }
  else if (provider === "ollama") { baseUrl = opts.baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434"; }
  const config: OpenContextConfig = {
    workspaceRoot: workspace,
    embedding: { provider, model, apiKey, baseUrl, dimension, batchSize },
    storePath: opts.storePath, maxFileSize: opts.maxFileSize, chunkSize: opts.chunkSize, chunkOverlap: opts.chunkOverlap,
    // Cache is on for the CLI (commander's --no-embed-cache sets false).
    embedCache: opts.embedCache !== false,
  };
  // requireCreds false = the command won't embed (e.g. exporting an existing
  // index) — don't demand API keys it will never use.
  if (o.requireCreds !== false) validateConfig(config);
  return config;
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
    console.error(`'oce ${command}' is a Team feature. Activate a license with 'oce activate <key>' (status: 'oce license').`);
    process.exit(1);
  }
}

program.name("oce").description("Open Context Engine").version("0.1.0");

program.command("index").description("Index workspace").option("-w, --workspace <path>", "Workspace root", process.cwd()).option("-p, --provider <provider>", "Embedding provider").option("-m, --model <model>", "Embedding model").option("--api-key <key>", "API key").option("--incremental", "Incremental").option("--no-embed-cache", "Disable the shared embedding cache").action(async (opts) => {
  const ctx = await OpenContext.create(resolveConfig(opts));
  console.log("Indexing..."); const r = opts.incremental ? await ctx.incrementalIndex((s,c,t) => t > 0 && process.stdout.write(`\r[${s}] ${c}/${t}`)) : await ctx.indexWorkspace((s,c,t) => t > 0 && process.stdout.write(`\r[${s}] ${c}/${t}`));
  console.log(`\nDone in ${r.duration}ms | New: ${r.newlyIndexed.length} | Existing: ${r.alreadyIndexed.length} | Removed: ${r.removed.length} | Chunks: ${ctx.getChunkCount()}`);
  if (ctx.getStatus().searchMode === "keyword-only") {
    console.error(`⚠ sqlite-vec unavailable — keyword-only (BM25) search, no semantic ranking. ${ctx.getStatus().degradedReason ?? ""}`);
  }
  if (r.failed?.length) {
    console.error(`\n⚠ ${r.failed.length} file(s) failed to embed and will be retried on the next index run.`);
    if (r.failedReason) console.error(`  Reason: ${r.failedReason}`);
    process.exitCode = 1;
  }
});

program.command("search <query>").description("Search codebase").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").action(async (query, opts) => { console.log(await (await OpenContext.create(resolveConfig(opts))).search(query)); });

program.command("mcp").description("Run MCP server (stdio by default; --http for a shared Streamable HTTP endpoint). Indexes on startup and watches for changes.")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("-p, --provider <provider>", "Provider")
  .option("-m, --model <model>", "Model")
  .option("--api-key <key>", "API key")
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

program.command("watch").description("Index the workspace and keep it live as files change").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").option("--no-embed-cache", "Disable the shared embedding cache").action(async (opts) => {
  const config = resolveConfig(opts);
  const { createLiveContext } = await import("../core/live-index");
  console.log(`Indexing ${config.workspaceRoot} ...`);
  const handle = await createLiveContext(config, {
    onProgress: (s, c, t) => t > 0 && process.stdout.write(`\r[${s}] ${c}/${t}   `),
    onReindex: (r) => console.log(`\n[reindex] +${r.newlyIndexed.length} new, ${r.removed.length} removed (${r.duration}ms) | ${handle.context.getChunkCount()} chunks${r.failed?.length ? ` | ⚠ ${r.failed.length} failed (will retry)` : ""}`),
    onError: (e) => console.error(`\n[watch error] ${e.message}`),
  });
  if (handle.context.getStatus().searchMode === "keyword-only") {
    console.error(`⚠ sqlite-vec unavailable — keyword-only (BM25) search, no semantic ranking.`);
  }
  console.log(`\nWatching for changes — ${handle.context.getChunkCount()} chunks indexed. Press Ctrl+C to stop.`);
  const stop = async () => { await handle.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});

program.command("agent").description("Interactive agent").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "LLM provider", "openai").option("--llm-model <model>", "LLM model (default: provider-appropriate)").option("--api-key <key>", "API key").option("--print <query>", "Non-interactive").option("--allow-edits", "Enable file-edit tools (str-replace, create-file, remove-file)").option("--allow-shell", "Enable the run-command shell tool (off by default)").option("--no-index", "Skip the startup index (use the existing index as-is)").option("--watch", "Keep the index live as files change during the session").option("--route", "Route each query to a cost-appropriate model tier (fast/standard/reasoning)").option("--memory", "Remember codebase insights across sessions (.open-context/memories.json)").option("--audit", "Append runs and tool calls to the tamper-evident audit log (.open-context/audit/)").action(async (opts) => {
  // Routing config is validated up front — before the (potentially long)
  // index run — so `-p google --route` fails in milliseconds, not minutes.
  const provider = (opts.provider || "openai") as LLMProvider;
  let router: import("../agent/model-router").ModelRouter | undefined;
  if (opts.route) {
    try {
      const { ModelRouter, defaultRoutingConfig } = await import("../agent/model-router");
      // No commander default for --llm-model: only an EXPLICIT model should
      // override the routed standard tier (a hardcoded gpt-4o default used to
      // silently hijack the anthropic standard tier).
      router = new ModelRouter(defaultRoutingConfig(provider, { apiKey: opts.apiKey, standardModel: opts.llmModel }));
    } catch (e: any) {
      console.error(`--route: ${e?.message ?? e}`);
      process.exit(1);
    }
  }
  const config = resolveConfig(opts);
  const ctx = await OpenContext.create(config);
  if (ctx.getStatus().searchMode === "keyword-only") {
    process.stderr.write(`⚠ sqlite-vec unavailable — keyword-only (BM25) search, no semantic ranking.\n`);
  }
  let watcher: import("../core/file-watcher").FileWatcher | null = null;
  if (opts.index !== false) {
    const { liveIndex } = await import("../core/live-index");
    process.stderr.write("Indexing workspace...\n");
    const { result, watcher: w } = await liveIndex(ctx, config, {
      watch: !!opts.watch,
      onProgress: (s, c, t) => t > 0 && process.stderr.write(`\r[${s}] ${c}/${t}   `),
      onReindex: (r) => { if (r.failed?.length) process.stderr.write(`\n[watch] ⚠ ${r.failed.length} file(s) failed to embed (will retry on next index): ${r.failedReason ?? ""}\n`); },
      onError: (e) => process.stderr.write(`\n[watch error] ${e.message}\n`),
    });
    watcher = w;
    process.stderr.write(`\rIndexed ${ctx.getChunkCount()} chunks (+${result.newlyIndexed.length} new)${watcher ? "; watching for changes" : ""}.\n`);
    if (result.failed?.length) {
      process.stderr.write(`⚠ ${result.failed.length} file(s) failed to embed — answers may miss context until the next index retries them. ${result.failedReason ?? ""}\n`);
    }
  }
  let memory: import("../agent/session-memory").SessionMemory | undefined;
  if (opts.memory) {
    const { SessionMemory } = await import("../agent/session-memory");
    const pathMod = await import("path");
    memory = new SessionMemory({ storePath: config.storePath || pathMod.join(config.workspaceRoot, ".open-context") });
  }
  const FALLBACK_MODEL: Record<string, string> = { openai: "gpt-4o", anthropic: "claude-sonnet-4-6" };
  // Policy can strip capabilities the flags asked for — say so up front
  // instead of letting the agent discover missing tools mid-run.
  const policyBlocks: string[] = [];
  const tools = defaultAgentTools({
    context: ctx,
    includeEdits: !!opts.allowEdits,
    shell: !!opts.allowShell,
    onPolicyBlock: (cap, reason) => policyBlocks.push(`${cap}: ${reason}`),
  });
  for (const b of policyBlocks) process.stderr.write(`⚠ policy: ${b}\n`);
  // Audit: explicit --audit needs the audit-log entitlement; a policy that
  // REQUIRES audit always wins (the signed policy is the org's authority).
  let audit: AuditLogger | undefined;
  const wsPolicy = ctx.getPolicy();
  if (opts.audit || (wsPolicy && policyRequiresAudit(wsPolicy))) {
    if (!opts.audit || isEntitled(getLicense(), "audit-log") || policyRequiresAudit(wsPolicy ?? undefined)) {
      audit = new AuditLogger({ dir: defaultAuditDir(config.workspaceRoot, config.storePath) });
      process.stderr.write(`Audit log: ${audit.getFilePath()}\n`);
    } else {
      console.error(`--audit requires an Enterprise license ('oce license' to check). Workspace policies can also require audit.`);
      process.exit(1);
    }
  }
  const agent = new ContextAgent({
    provider,
    model: opts.llmModel || FALLBACK_MODEL[provider] || "gpt-4o",
    apiKey: opts.apiKey,
    tools,
    router,
    memory,
    memorySource: "cli-agent",
    audit,
  });
  const toolNames = tools.map(t => t.name).filter(n => !["codebase-retrieval", "list-files", "read-file", "find-symbol-definition", "find-symbol-references"].includes(n));
  process.stderr.write(`Tools: codebase-retrieval, list-files, read-file, symbols${toolNames.length ? ", " + toolNames.join(", ") : ""}.${opts.route ? " Routing: on." : ""}${opts.memory ? ` Memory: on (${memory ? "loaded " + memory.getAll().length + " entries" : ""}).` : ""}${audit ? " Audit: on." : ""}\n`);
  const stream = (ev: any) => {
    if (ev.type === "text") process.stdout.write(ev.text);
    else if (ev.type === "model_selected") process.stderr.write(`[routed: ${ev.tier.name} → ${ev.tier.model}]\n`);
    else if (ev.type === "tool_call") process.stdout.write(`\n[tool ${ev.toolCall.name}] ${JSON.stringify(ev.toolCall.arguments)}\n`);
    else if (ev.type === "tool_result") process.stdout.write(`[tool ${ev.toolResult.name} result: ${ev.toolResult.result.length} chars]\n`);
    else if (ev.type === "retry") process.stdout.write(`\n[retry attempt ${ev.retryAttempt} in ${ev.retryDelayMs}ms: ${ev.retryReason}]\n`);
    else if (ev.type === "history_compacted") process.stdout.write(`\n[compacted ${ev.droppedMessages} messages]\n`);
    else if (ev.type === "run_end" && ev.stats) {
      const s = ev.stats;
      const tokens = s.usage.inputTokens || s.usage.outputTokens ? `, ${s.usage.inputTokens} in / ${s.usage.outputTokens} out tokens` : "";
      process.stderr.write(`\n[${s.steps} step${s.steps === 1 ? "" : "s"}, ${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}${s.toolErrors ? ` (${s.toolErrors} errored)` : ""}${tokens}, ${(s.durationMs / 1000).toFixed(1)}s]\n`);
    }
  };
  if (opts.print) { await agent.run(opts.print, { onStream: stream }); process.stdout.write("\n"); await watcher?.stop(); ctx.close(); return; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => { void watcher?.stop().then(() => ctx.close()); });
  console.log(`Open Context Agent | Type 'exit' to quit, 'reset' to clear\n`);
  const p = () => rl.question("> ", async (q) => {
    if (!q.trim()) return p();
    if (q.trim() === "exit") return rl.close();
    if (q.trim() === "reset") { agent.reset(); console.log("Cleared."); return p(); }
    try { await agent.run(q, { onStream: stream }); console.log("\n"); }
    catch (e: any) { console.error(`Error: ${e.message}`); }
    p();
  });
  p();
});

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
    const { runEval, parseEvalCases, compareReports } = await import("../eval/runner");
    const cases = parseEvalCases(JSON.parse(await fs.promises.readFile(opts.cases, "utf8")));
    const k = Math.max(1, Number(opts.topK));
    const retrieveK = opts.retrieveK ? Math.max(k, Number(opts.retrieveK)) : k * 3;
    const ctx = await OpenContext.create(resolveConfig(opts));
    try {
      if (opts.index !== false) {
        process.stderr.write("Refreshing index...\n");
        await ctx.incrementalIndex((s, c, t) => t > 0 && process.stderr.write(`\r[${s}] ${c}/${t}   `));
        process.stderr.write("\n");
      }
      if (!ctx.getChunkCount()) {
        console.error("Index is empty — run 'oce index' first or drop --no-index.");
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
            console.log(`[${String(i + 1).padStart(2)}/${total}] ${mark.padEnd(7)} ndcg=${r.metrics.ndcg.toFixed(3)}${ctxMark} ${r.id}${r.error ? ` (${r.error})` : ""}`);
          },
        },
      );
      const mode = ctx.getStatus().searchMode;
      report.searchMode = mode; // persisted into --out/--json so saved baselines carry their mode
      if (opts.out) await fs.promises.writeFile(opts.out, JSON.stringify(report, null, 2));
      if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }
      const a = report.aggregate;
      console.log(`\nk=${k} retrieveK=${retrieveK} expand=${expand} | cases: ${a.cases}${mode === "keyword-only" ? " | ⚠ KEYWORD-ONLY MODE — not comparable to hybrid baselines" : ""}`);
      const ctxLine = a.contextRecall !== undefined ? `  ctx-recall=${a.contextRecall.toFixed(3)}  ctx-hit-rate=${(a.contextHitRate ?? 0).toFixed(3)}` : "";
      console.log(`recall@k=${a.recallAtK.toFixed(3)}  MRR=${a.mrr.toFixed(3)}  nDCG@k=${a.ndcgAtK.toFixed(3)}  hit-rate=${a.hitRate.toFixed(3)}${ctxLine}  mean-latency=${report.meanLatencyMs.toFixed(0)}ms`);
      const misses = report.results.filter(r => !r.metrics.hit);
      if (misses.length) {
        console.log(`\nMisses (${misses.length}):`);
        for (const m of misses) console.log(`  ${m.id}: expected ${m.expectedPaths.join(", ")} — got [${m.retrievedFiles.slice(0, 3).join(", ")}${m.retrievedFiles.length > 3 ? ", …" : ""}]`);
      }
      if (opts.baseline) {
        const baseline = JSON.parse(await fs.promises.readFile(opts.baseline, "utf8"));
        if (baseline.searchMode && baseline.searchMode !== mode) {
          console.log(`\n⚠ baseline was ${baseline.searchMode}, this run is ${mode} — deltas reflect the mode change, not retrieval quality.`);
        } else if (!baseline.searchMode && mode === "keyword-only") {
          console.log(`\n⚠ baseline has no search-mode marker (likely hybrid); this run is keyword-only — deltas are not meaningful.`);
        }
        const cmp = compareReports(baseline, report);
        const sign = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
        const ctxDelta = cmp.aggregate.contextRecall !== undefined ? ` Δctx-recall=${sign(cmp.aggregate.contextRecall)} Δctx-hit=${sign(cmp.aggregate.contextHitRate ?? 0)}` : "";
        console.log(`\nvs baseline (${cmp.perCase.length} shared cases): ΔnDCG=${sign(cmp.aggregate.ndcgAtK)} ΔMRR=${sign(cmp.aggregate.mrr)} Δrecall=${sign(cmp.aggregate.recallAtK)} Δhit-rate=${sign(cmp.aggregate.hitRate)}${ctxDelta}`);
        console.log(`improved: ${cmp.improved}  regressed: ${cmp.regressed}  unchanged: ${cmp.unchanged}`);
        for (const d of cmp.perCase.filter(d => d.direction === "regressed")) console.log(`  ▼ ${d.id} ΔnDCG=${sign(d.ndcg)}`);
        if (cmp.onlyInBaseline.length || cmp.onlyInCurrent.length) {
          console.log(`(cases only in baseline: ${cmp.onlyInBaseline.length}; only in current: ${cmp.onlyInCurrent.length} — excluded from deltas)`);
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
      console.error("Multi-repo search is a Team feature. Activate a license with 'oce activate <key>' (check 'oce license').");
      process.exit(1);
    }
    const repoPaths = String(opts.repos || "").split(",").map((s: string) => s.trim()).filter(Boolean);
    if (!repoPaths.length) { console.error("Specify repos with --repos <path1,path2,...>."); process.exit(1); }
    const base = resolveConfig(opts);
    const mr = await ee.createMultiRepoContext({ repos: repoPaths.map((p: string) => ({ path: p })), base });
    if (opts.index !== false) {
      process.stderr.write(`Indexing ${mr.repoNames().length} repo(s): ${mr.repoNames().join(", ")} ...\n`);
      const counts = await mr.indexAll((repo: string, s: string, c: number, t: number) => t > 0 && process.stderr.write(`\r[${repo}] ${s} ${c}/${t}     `));
      process.stderr.write("\n" + counts.map((c: any) => `${c.repo}: ${c.chunks} chunks`).join(" | ") + "\n\n");
    }
    console.log(await mr.searchFormatted(query, Number(opts.topK)));
    mr.close();
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
        process.stderr.write("Refreshing index...\n");
        await ctx.incrementalIndex((s, c, t) => t > 0 && process.stderr.write(`\r[${s}] ${c}/${t}   `));
        process.stderr.write("\n");
      }
      if (!ctx.getChunkCount()) { console.error("Index is empty — run 'oce index' first."); process.exit(1); }
      const isLocal = !/^https?:\/\//i.test(dest);
      const artifactFile = isLocal ? dest : pathMod.join(os.tmpdir(), `oce-index-${Date.now()}.db.gz`);
      const manifest = await ctx.exportIndex(artifactFile);
      if (!isLocal) {
        process.stderr.write(`Uploading to ${dest} ...\n`);
        await pushArtifact(artifactFile, dest, { token: opts.token || process.env.OCE_INDEX_TOKEN });
        await fs.promises.rm(artifactFile, { force: true });
      }
      const size = isLocal ? ` (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)` : "";
      console.log(`Published index artifact${size}: ${manifest.chunkCount} chunks, ${manifest.fileCount} files, ${manifest.embeddingModel} ${manifest.dimension}d${manifest.git?.commit ? `, commit ${manifest.git.commit.slice(0, 8)}` : ""}.`);
      console.log(`Teammates install it with: oce pull-index ${isLocal ? dest : "<url>"}`);
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
      process.stderr.write(`Downloading ${src} ...\n`);
      await pullArtifact(src, artifactFile, { token: opts.token || process.env.OCE_INDEX_TOKEN });
    }
    try {
      const manifest = await installArtifact(artifactFile, storeDir, { model: config.embedding.model, dimension: config.embedding.dimension });
      console.log(`Installed team index: ${manifest.chunkCount} chunks, ${manifest.fileCount} files, built ${manifest.createdAt.slice(0, 19)}${manifest.git?.commit ? ` at commit ${manifest.git.commit.slice(0, 8)}` : ""}.`);
      if (reconcile) {
        const ctx = await OpenContext.create(config);
        try {
          process.stderr.write("Reconciling local changes...\n");
          const r = await ctx.incrementalIndex((s, c, t) => t > 0 && process.stderr.write(`\r[${s}] ${c}/${t}   `));
          process.stderr.write("\n");
          console.log(`Reconciled: ${r.newlyIndexed.length} file(s) re-embedded locally, ${r.alreadyIndexed.length} reused from the artifact, ${r.removed.length} removed.`);
          if (r.failed?.length) { console.error(`⚠ ${r.failed.length} file(s) failed to embed — retried on the next index. ${r.failedReason ?? ""}`); process.exitCode = 1; }
        } finally {
          ctx.close();
        }
      } else {
        console.log("Skipped reconciliation (--no-reconcile) — run 'oce index --incremental' to fold in local changes.");
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
    const { FileFilter } = await import("../core/file-filter");
    const { AstChunker } = await import("../core/ast-chunker");
    const { CodeChunker } = await import("../core/chunker");
    const { extractEdges } = await import("../core/graph-extractor");
    const { ChunkWorkerPool, defaultPoolSize } = await import("../core/chunk-pool");

    const filter = new FileFilter();
    process.stderr.write("Collecting files...\n");
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

    process.stderr.write(`Chunking ${files.length} files (${(totalBytes / 1e6).toFixed(1)} MB) in-process...\n`);
    const inline = await runInline();

    let pooled: { ms: number; chunkCount: number; edgeCount: number; workers: number } | null = null;
    if (ChunkWorkerPool.isAvailable()) {
      const workers = opts.workers ? Math.max(1, Number(opts.workers)) : defaultPoolSize();
      process.stderr.write(`Chunking again with ${workers} worker thread(s)...\n`);
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
      process.stderr.write("(worker pool unavailable — dist/core/chunk-worker.js not built; run 'npm run build')\n");
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
    if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log(`\nfiles: ${report.files}  size: ${report.megabytes} MB`);
    console.log(`in-process: ${inline.ms}ms  (${report.inline.filesPerSec} files/s, ${inline.chunkCount} chunks, ${inline.edgeCount} edges)`);
    if (pooled) console.log(`workers x${pooled.workers}: ${pooled.ms}ms  (${report.workers!.filesPerSec} files/s, speedup ${report.workers!.speedup}x)`);
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
    if (!all.length) { console.log(`No audit events found in ${dir}.`); return; }
    if (opts.verify) {
      const v = verifyAuditChain(all);
      if (v.ok) console.log(`✓ chain intact — ${v.checked} events verified.`);
      else { console.error(`✗ TAMPERED at seq ${v.brokenAtSeq}: ${v.reason} (${v.checked} events verified before the break)`); process.exitCode = 1; }
      return;
    }
    const events = readAuditEvents(dir, {
      type: opts.type,
      since: opts.since ? new Date(opts.since) : undefined,
      limit: Math.max(1, Number(opts.limit)),
    });
    if (opts.json) { for (const e of events) console.log(JSON.stringify(e)); return; }
    for (const e of events) {
      const detail = Object.entries(e.data).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 120) : JSON.stringify(v)}`).join(" ");
      console.log(`${e.ts}  #${e.seq}  ${e.type.padEnd(10)} ${detail}`);
    }
    console.log(`\n${events.length} of ${all.length} events shown (${dir}). Use --verify to check integrity.`);
  });

program.command("policy").description("Show the effective policy for a workspace (user + workspace + org lock)")
  .option("-w, --workspace <path>", "Workspace", process.cwd())
  .option("--json", "Print the effective policy as JSON")
  .action((opts: any) => {
    const p = loadPolicy(opts.workspace);
    if (opts.json) { console.log(JSON.stringify(p, null, 2)); return; }
    console.log(describePolicy(p));
    if (p.sources.length) console.log(`Sources:\n${p.sources.map(s => `  - ${s}`).join("\n")}`);
    for (const w of p.warnings) console.log(`⚠ ${w}`);
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
    console.error(`Activation failed: ${why}.`);
    process.exit(1);
  }
  {
    const { loadCachedRevocations } = await import("../core/license");
    if (status.payload?.id && loadCachedRevocations()?.revoked.includes(status.payload.id)) {
      console.error("Activation failed: this license has been revoked.");
      process.exit(1);
    }
  }
  // SSO-lite: a domain-bound license only activates for a matching identity.
  const domainCheck = checkOrgDomainBinding(status.payload, resolveActivationEmail());
  if (domainCheck === "mismatch") {
    console.error(`Activation failed: this license is bound to @${status.payload?.orgDomain} email addresses, but your identity (git config user.email / OCE_ACTIVATION_EMAIL) does not match.`);
    process.exit(1);
  }
  if (domainCheck === "unverifiable") {
    console.error(`⚠ License is bound to @${status.payload?.orgDomain} but no local email identity was found — proceeding. Set OCE_ACTIVATION_EMAIL or git config user.email to silence this.`);
  }
  const p = saveLicenseToken(key);
  const exp = status.payload?.exp ? new Date(status.payload.exp * 1000).toISOString().slice(0, 10) : "perpetual";
  console.log(`Activated ${status.plan} license for ${status.payload?.org} — ${status.payload?.seats} seat(s), expires ${exp}.`);
  console.log(`Saved to ${p}`);
});

program.command("license").description("Show the current license status")
  .option("--refresh [url]", "Fetch the signed revocation list (from the given URL or OCE_REVOCATION_URL) before checking")
  .action(async (opts: any) => {
  if (opts.refresh) {
    const { refreshRevocations } = await import("../core/license");
    const list = await refreshRevocations(typeof opts.refresh === "string" ? opts.refresh : undefined);
    if (list) console.log(`Revocation list refreshed (${list.revoked.length} entries, updated ${new Date(list.updatedAt * 1000).toISOString().slice(0, 10)}).`);
    else console.log("Revocation list not refreshed (no URL configured, or fetch/verify failed) — continuing with the cached list.");
  }
  const s = getLicense();
  if (!s.valid) {
    if (s.reason === "expired") console.log(`License expired (was ${s.payload?.plan} for ${s.payload?.org}). Running as Community (free) edition.`);
    else if (s.reason === "revoked") console.log(`License ${s.payload?.id} for ${s.payload?.org} has been REVOKED. Running as Community (free) edition — contact support if this is unexpected.`);
    else console.log("No active license — running as Community (free) edition. Activate with 'oce activate <key>'.");
    return;
  }
  const exp = s.payload?.exp ? new Date(s.payload.exp * 1000).toISOString().slice(0, 10) : "perpetual";
  console.log(`Plan:    ${s.plan}`);
  console.log(`Org:     ${s.payload?.org}`);
  console.log(`Seats:   ${s.payload?.seats}`);
  console.log(`Expires: ${exp}`);
  if (s.inGrace) console.log(`\n⚠ In grace period — ${s.daysLeft} day(s) left. Please renew to avoid interruption.`);
});

program.command("deactivate").description("Remove the saved license key").action(() => {
  console.log(clearLicense() ? "License removed — now running as Community edition." : "No license was active.");
});

program.parse();
