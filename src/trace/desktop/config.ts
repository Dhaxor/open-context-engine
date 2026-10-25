/**
 * Config resolution for the desktop shell.
 *
 * The CLI's resolver lives inside src/cli/index.ts and is wired to commander
 * flags. The desktop app has no flags — it has a workspace and whatever the
 * user already configured — so this reads the same sources in the same
 * precedence order (env, then user config, then workspace config, then
 * defaults) without pulling the CLI's argument parsing into an Electron
 * process.
 */

import { DEFAULT_MODEL_FOR_PROVIDER, EMBEDDING_MODELS, OpenContextConfig } from "../../core/types";
import { loadFileConfig } from "../../cli/config-file";

export interface DesktopConfigOptions {
  workspace?: string;
  /** Overrides, for tests and for a future settings pane. */
  provider?: OpenContextConfig["embedding"]["provider"];
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveDesktopConfig(opts: DesktopConfigOptions = {}): OpenContextConfig {
  const env = opts.env ?? process.env;
  const workspace = opts.workspace || process.cwd();
  const { config: file } = loadFileConfig(workspace);

  const chosen = opts.provider || env.OCE_EMBEDDING_PROVIDER || file.embedding?.provider;
  const provider = (chosen || "voyage") as OpenContextConfig["embedding"]["provider"];

  const modelKey = opts.model || file.embedding?.model || DEFAULT_MODEL_FOR_PROVIDER[provider] || "voyage-code-3";
  const info = EMBEDDING_MODELS[modelKey];

  let apiKey = opts.apiKey;
  let baseUrl = opts.baseUrl || file.embedding?.baseUrl;
  if (provider === "openai") apiKey = apiKey || env.OPENAI_API_KEY || env.OCE_EMBEDDING_API_KEY;
  else if (provider === "voyage") apiKey = apiKey || env.VOYAGE_API_KEY || env.OCE_EMBEDDING_API_KEY;
  else if (provider === "ollama") baseUrl = baseUrl || env.OLLAMA_BASE_URL || "http://localhost:11434";

  // The same rule as the CLI: nothing chosen and no key for the default means
  // keyword-only search that works now, not an app that cannot index. The store
  // refuses the fallback if it would cost an existing vector index.
  const keywordOnly = provider === "none"
    ? "explicit" as const
    : !chosen && !apiKey ? "fallback" as const : undefined;

  return {
    workspaceRoot: workspace,
    ...(keywordOnly ? { keywordOnly } : {}),
    embedding: {
      provider,
      // The registry may map a short key to a fully-qualified id; unknown keys
      // pass through so a custom model name still works.
      model: info?.model ?? modelKey,
      apiKey,
      baseUrl,
      dimension: info?.dimension ?? 1024,
      batchSize: info?.batchSize ?? 32,
    },
    storePath: file.storePath,
    maxFileSize: file.maxFileSize,
    chunkSize: file.chunkSize,
    chunkOverlap: file.chunkOverlap,
    ...(file.search && (file.search.topK !== undefined || file.search.minScore !== undefined)
      ? {
        search: {
          ...(file.search.topK !== undefined ? { topK: file.search.topK } : {}),
          ...(file.search.minScore !== undefined ? { minScore: file.search.minScore } : {}),
        },
      }
      : {}),
    embedCache: file.embedCache ?? true,
  };
}
