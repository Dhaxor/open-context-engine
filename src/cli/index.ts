#!/usr/bin/env node
import { Command } from "commander";
import { OpenContext } from "../core/context";
import { OpenContextConfig, DEFAULT_EMBEDDING_CONFIG, EMBEDDING_MODELS } from "../core/types";
import { runMCPServer } from "../mcp/server";
import { ContextAgent, defaultAgentTools, LLMProvider } from "../agent/agent";
import * as readline from "readline";

const program = new Command();

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
  return { workspaceRoot: workspace, embedding: { provider, model, apiKey, baseUrl, dimension, batchSize }, storePath: opts.storePath, maxFileSize: opts.maxFileSize, chunkSize: opts.chunkSize, chunkOverlap: opts.chunkOverlap };
}

program.name("oce").description("Open Context Engine").version("0.1.0");

program.command("index").description("Index workspace").option("-w, --workspace <path>", "Workspace root", process.cwd()).option("-p, --provider <provider>", "Embedding provider").option("-m, --model <model>", "Embedding model").option("--api-key <key>", "API key").option("--incremental", "Incremental").action(async (opts) => {
  const ctx = await OpenContext.create(resolveConfig(opts));
  console.log("Indexing..."); const r = opts.incremental ? await ctx.incrementalIndex((s,c,t) => t > 0 && process.stdout.write(`\r[${s}] ${c}/${t}`)) : await ctx.indexWorkspace((s,c,t) => t > 0 && process.stdout.write(`\r[${s}] ${c}/${t}`));
  console.log(`\nDone in ${r.duration}ms | New: ${r.newlyIndexed.length} | Existing: ${r.alreadyIndexed.length} | Removed: ${r.removed.length} | Chunks: ${ctx.getChunkCount()}`);
});

program.command("search <query>").description("Search codebase").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").action(async (query, opts) => { console.log(await (await OpenContext.create(resolveConfig(opts))).search(query)); });

program.command("mcp").description("Run MCP server (stdio)").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").action(async (opts) => { await runMCPServer(resolveConfig(opts)); });

program.command("agent").description("Interactive agent").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "LLM provider", "openai").option("--llm-model <model>", "LLM model", "gpt-4o").option("--api-key <key>", "API key").option("--print <query>", "Non-interactive").option("--allow-edits", "Enable file-edit tools (str-replace, create-file, remove-file)").action(async (opts) => {
  const ctx = await OpenContext.create(resolveConfig(opts));
  const agent = new ContextAgent({
    provider: (opts.provider || "openai") as LLMProvider,
    model: opts.llmModel || "gpt-4o",
    apiKey: opts.apiKey,
    tools: defaultAgentTools({ context: ctx, includeEdits: !!opts.allowEdits }),
  });
  const stream = (ev: any) => {
    if (ev.type === "text") process.stdout.write(ev.text);
    else if (ev.type === "tool_call") process.stdout.write(`\n[tool ${ev.toolCall.name}] ${JSON.stringify(ev.toolCall.arguments)}\n`);
    else if (ev.type === "tool_result") process.stdout.write(`[tool ${ev.toolResult.name} result: ${ev.toolResult.result.length} chars]\n`);
    else if (ev.type === "retry") process.stdout.write(`\n[retry attempt ${ev.retryAttempt} in ${ev.retryDelayMs}ms: ${ev.retryReason}]\n`);
    else if (ev.type === "history_compacted") process.stdout.write(`\n[compacted ${ev.droppedMessages} messages]\n`);
  };
  if (opts.print) { await agent.run(opts.print, { onStream: stream }); process.stdout.write("\n"); return; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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

program.parse();
