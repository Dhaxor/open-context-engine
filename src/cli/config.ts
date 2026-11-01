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
  // the default. Local (in-process MiniLM) is the default: semantic search
  // works on the first index with no key, no server, nothing sent anywhere.
  // Voyage stays the recommended upgrade — the strongest code embedder — and
  // the default-path notice points there once.
  const chosenProvider = opts.provider || process.env.OCE_EMBEDDING_PROVIDER || file.embedding?.provider;
  const provider = (chosenProvider || "local") as OpenContextConfig["embedding"]["provider"];
  const modelKey = opts.model || file.embedding?.model || DEFAULT_MODEL_FOR_PROVIDER[provider] || "all-MiniLM-L6-v2";
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
  } else if (!SqliteStore.sqliteVecResolvable()) {
    // Local embeddings need sqlite-vec for vector storage; without it the
    // engine degrades to keyword-only rather than crashing. The store refuses
    // this fallback if it would cost an existing vector index (keywordOnly).
    config.keywordOnly = "fallback";
    if (!keywordNoticeShown) {
      keywordNoticeShown = true;
      io.diagnosticsFor(opts).warn("ⓘ sqlite-vec unavailable — running keyword-only search. Local and remote embeddings both need it; see 'oce status' for the diagnosis.");
    }
  } else if (!chosenProvider && !keywordHintShown) {
    // First run on the built-in default: say what's running and name the one
    // upgrade worth making. Local does the job fine — this is an offer, not a
    // nag (shown once per process, like the keyword notice above).
    keywordHintShown = true;
    io.diagnosticsFor(opts).warn("ⓘ Semantic search: local MiniLM (free, on-device). For the best code retrieval, set a Voyage key — 'oce setup --embeddings voyage'. Local works fine without it.");
  }
  // requireCreds false = the command won't embed (e.g. exporting an existing
  // index) — don't demand API keys it will never use.
  if (o.requireCreds !== false && !config.keywordOnly) validateConfig(config);
  return config;
}

/** The notices are printed once per process, not once per resolve. */
let keywordNoticeShown = false;
let keywordHintShown = false;

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
