import { OpenContextConfig, EMBEDDING_MODELS, DEFAULT_MODEL_FOR_PROVIDER } from "../core/types";
import { SqliteStore } from "../core/sqlite-store";
import { getLicense, isEntitled } from "../core/license";
import { loadFileConfig } from "./config-file";
import { CliIo } from "./io";

export function validateConfig(config: OpenContextConfig): void {
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

export function resolveConfig(opts: any, io: CliIo, o: { requireCreds?: boolean } = {}): OpenContextConfig {
  const workspace = opts.workspace || process.cwd();
  // File config: user (~/.open-context/config.json) then workspace
  // (.open-context/config.json). Flags and env vars always win over files.
  const { config: file, warnings } = loadFileConfig(workspace);
  for (const w of warnings) io.diagnosticsFor(opts).warn(`⚠ config: ${w}`);
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
      io.diagnosticsFor(opts).warn("ⓘ No embedding provider configured — using keyword search. Run 'oce setup' to enable semantic search (free options available).");
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
export function withStoreOptions(cmd: import("commander").Command): import("commander").Command {
  return cmd
    .option("--store-path <path>", "Custom store directory (default: .open-context/)")
    .option("--chunk-size <lines>", "Lines per chunk for non-AST files (default 80)")
    .option("--chunk-overlap <lines>", "Overlap between chunks (default 15)")
    .option("--max-file-size <bytes>", "Skip files larger than this (default 1 MiB)");
}

/** Embedder stand-in for commands that must open a store but never embed. */
export function staticEmbedder(embedding: OpenContextConfig["embedding"]): NonNullable<OpenContextConfig["embedder"]> {
  return {
    embed: async () => { throw new Error("This command does not embed; re-run without --no-index / --no-reconcile to index."); },
    getDimension: () => embedding.dimension,
    getModel: () => embedding.model,
  };
}

/** Gate a CLI command on the team-index entitlement with a clear upsell. */
export function requireTeamIndex(io: CliIo, command: string): void {
  const license = getLicense();
  if (!isEntitled(license, "team-index")) {
    io.fatal(`'oce ${command}' is a Team feature. Activate a license with 'oce activate <key>' (status: 'oce license').`);
  }
}

/** Best-effort local identity for SSO-lite activation checks. */
export function resolveActivationEmail(): string | null {
  if (process.env.OCE_ACTIVATION_EMAIL) return process.env.OCE_ACTIVATION_EMAIL;
  try {
    const { execSync } = require("child_process");
    const email = execSync("git config user.email", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return email || null;
  } catch { return null; }
}
