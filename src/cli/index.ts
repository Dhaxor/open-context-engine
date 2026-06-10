#!/usr/bin/env node
import { Command } from "commander";
import { OpenContext } from "../core/context";
import { OpenContextConfig, EMBEDDING_MODELS } from "../core/types";
import { runMCPServer } from "../mcp/server";
import { ContextAgent, defaultAgentTools, LLMProvider } from "../agent/agent";
import { getLicense, verifyLicenseToken, saveLicenseToken, clearLicense, loadEnterpriseEdition } from "../core/license";
import * as readline from "readline";

const program = new Command();

function validateConfig(config: OpenContextConfig): void {
  const { provider, apiKey, baseUrl } = config.embedding;
  if (provider === "openai" && !apiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI embeddings. Set it via --api-key, OPENAI_API_KEY env var, or OCE_EMBEDDING_API_KEY env var.");
  }
  if (provider === "voyage" && !apiKey) {
    throw new Error("VOYAGE_API_KEY is required for Voyage embeddings. Set it via --api-key, VOYAGE_API_KEY env var, or OCE_EMBEDDING_API_KEY env var.");
  }
  if (provider === "ollama" && !baseUrl) {
    throw new Error("OLLAMA_BASE_URL is required for Ollama. Set it via --base-url, OLLAMA_BASE_URL env var, or OCE_EMBEDDING_BASE_URL env var.");
  }
}

function resolveConfig(opts: any): OpenContextConfig {
  const provider = opts.provider || process.env.OCE_EMBEDDING_PROVIDER || "voyage";
  const model = opts.model || "voyage-code-3";
  const workspace = opts.workspace || process.cwd();
  const modelInfo = EMBEDDING_MODELS[model];
  let apiKey: string | undefined, baseUrl: string | undefined, dimension = modelInfo?.dimension ?? 1024;
  const batchSize = modelInfo?.batchSize ?? 32;
  if (provider === "openai") { apiKey = opts.apiKey || process.env.OPENAI_API_KEY; baseUrl = opts.baseUrl; }
  else if (provider === "voyage") { apiKey = opts.apiKey || process.env.VOYAGE_API_KEY; }
  else { baseUrl = opts.baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434"; }
  const config: OpenContextConfig = { workspaceRoot: workspace, embedding: { provider, model, apiKey, baseUrl, dimension, batchSize }, storePath: opts.storePath, maxFileSize: opts.maxFileSize, chunkSize: opts.chunkSize, chunkOverlap: opts.chunkOverlap };
  validateConfig(config);
  return config;
}

program.name("oce").description("Open Context Engine").version("0.1.0");

program.command("index").description("Index workspace").option("-w, --workspace <path>", "Workspace root", process.cwd()).option("-p, --provider <provider>", "Embedding provider").option("-m, --model <model>", "Embedding model").option("--api-key <key>", "API key").option("--incremental", "Incremental").action(async (opts) => {
  const ctx = await OpenContext.create(resolveConfig(opts));
  console.log("Indexing..."); const r = opts.incremental ? await ctx.incrementalIndex((s,c,t) => t > 0 && process.stdout.write(`\r[${s}] ${c}/${t}`)) : await ctx.indexWorkspace((s,c,t) => t > 0 && process.stdout.write(`\r[${s}] ${c}/${t}`));
  console.log(`\nDone in ${r.duration}ms | New: ${r.newlyIndexed.length} | Existing: ${r.alreadyIndexed.length} | Removed: ${r.removed.length} | Chunks: ${ctx.getChunkCount()}`);
});

program.command("search <query>").description("Search codebase").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").action(async (query, opts) => { console.log(await (await OpenContext.create(resolveConfig(opts))).search(query)); });

program.command("mcp").description("Run MCP server (stdio). Indexes on startup and watches for changes by default.").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").option("--no-watch", "Do not keep the index live (no file watching)").action(async (opts) => { await runMCPServer(resolveConfig(opts), { watch: opts.watch }); });

program.command("watch").description("Index the workspace and keep it live as files change").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").action(async (opts) => {
  const config = resolveConfig(opts);
  const { createLiveContext } = await import("../core/live-index");
  console.log(`Indexing ${config.workspaceRoot} ...`);
  const handle = await createLiveContext(config, {
    onProgress: (s, c, t) => t > 0 && process.stdout.write(`\r[${s}] ${c}/${t}   `),
    onReindex: (r) => console.log(`\n[reindex] +${r.newlyIndexed.length} new, ${r.removed.length} removed (${r.duration}ms) | ${handle.context.getChunkCount()} chunks`),
    onError: (e) => console.error(`\n[watch error] ${e.message}`),
  });
  console.log(`\nWatching for changes — ${handle.context.getChunkCount()} chunks indexed. Press Ctrl+C to stop.`);
  const stop = async () => { await handle.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});

program.command("agent").description("Interactive agent").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "LLM provider", "openai").option("--llm-model <model>", "LLM model", "gpt-4o").option("--api-key <key>", "API key").option("--print <query>", "Non-interactive").option("--allow-edits", "Enable file-edit tools (str-replace, create-file, remove-file)").option("--allow-shell", "Enable the run-command shell tool (off by default)").option("--no-index", "Skip the startup index (use the existing index as-is)").option("--watch", "Keep the index live as files change during the session").action(async (opts) => {
  const config = resolveConfig(opts);
  const ctx = await OpenContext.create(config);
  let watcher: import("../core/file-watcher").FileWatcher | null = null;
  if (opts.index !== false) {
    const { liveIndex } = await import("../core/live-index");
    process.stderr.write("Indexing workspace...\n");
    const { result, watcher: w } = await liveIndex(ctx, config, {
      watch: !!opts.watch,
      onProgress: (s, c, t) => t > 0 && process.stderr.write(`\r[${s}] ${c}/${t}   `),
    });
    watcher = w;
    process.stderr.write(`\rIndexed ${ctx.getChunkCount()} chunks (+${result.newlyIndexed.length} new)${watcher ? "; watching for changes" : ""}.\n`);
  }
  const agent = new ContextAgent({
    provider: (opts.provider || "openai") as LLMProvider,
    model: opts.llmModel || "gpt-4o",
    apiKey: opts.apiKey,
    tools: defaultAgentTools({ context: ctx, includeEdits: !!opts.allowEdits, shell: !!opts.allowShell }),
  });
  process.stderr.write(`Tools: codebase-retrieval, list-files, read-file${opts.allowEdits ? ", edits" : ""}${opts.allowShell ? ", run-command" : ""}.\n`);
  const stream = (ev: any) => {
    if (ev.type === "text") process.stdout.write(ev.text);
    else if (ev.type === "tool_call") process.stdout.write(`\n[tool ${ev.toolCall.name}] ${JSON.stringify(ev.toolCall.arguments)}\n`);
    else if (ev.type === "tool_result") process.stdout.write(`[tool ${ev.toolResult.name} result: ${ev.toolResult.result.length} chars]\n`);
    else if (ev.type === "retry") process.stdout.write(`\n[retry attempt ${ev.retryAttempt} in ${ev.retryDelayMs}ms: ${ev.retryReason}]\n`);
    else if (ev.type === "history_compacted") process.stdout.write(`\n[compacted ${ev.droppedMessages} messages]\n`);
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

program.command("activate <key>").description("Activate a Team/Enterprise license key").action((key: string) => {
  const status = verifyLicenseToken(key);
  if (!status.valid) {
    const why = status.reason === "expired" ? "this license has expired"
      : status.reason === "bad-signature" ? "invalid signature (is the key correct and complete?)"
      : "malformed license key";
    console.error(`Activation failed: ${why}.`);
    process.exit(1);
  }
  const p = saveLicenseToken(key);
  const exp = status.payload?.exp ? new Date(status.payload.exp * 1000).toISOString().slice(0, 10) : "perpetual";
  console.log(`Activated ${status.plan} license for ${status.payload?.org} — ${status.payload?.seats} seat(s), expires ${exp}.`);
  console.log(`Saved to ${p}`);
});

program.command("license").description("Show the current license status").action(() => {
  const s = getLicense();
  if (!s.valid) {
    if (s.reason === "expired") console.log(`License expired (was ${s.payload?.plan} for ${s.payload?.org}). Running as Community (free) edition.`);
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
