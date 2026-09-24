import * as vscode from "vscode";
import { EMBEDDING_MODELS } from "../../../src/core/types";

/** Default chat model per LLM provider. */
export function defaultModelFor(provider: string): string {
  if (provider === "anthropic") return "claude-opus-4-7";
  if (provider === "openai") return "gpt-5.4";
  if (provider === "google") return "gemini-3.1-pro-preview";
  if (provider === "ollama") return "llama3.1";
  if (provider === "custom") return "";
  return provider;
}

/** Default embedding model per embedding provider. */
export const DEFAULT_EMBEDDING_MODEL_BY_PROVIDER: Record<string, string> = {
  openai: "text-embedding-3-small",
  voyage: "voyage-code-3",
  ollama: "nomic-embed-text",
  local: "jina-embeddings-v2-base-code",
};

/** A setting's value only if the user set it somewhere — not package.json's default. */
function explicitSetting(cfg: vscode.WorkspaceConfiguration, key: string): string | undefined {
  const i = cfg.inspect<string>(key);
  return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue ?? undefined;
}

/**
 * The chat model: openContext.llm.model when the user set it, else the
 * provider's default. package.json contributes "gpt-5.4" as the setting's
 * default, so cfg.get() would pair any provider picked in settings.json with
 * an OpenAI model. (The chat's model picker writes provider and model together.)
 */
export function resolveLLMModel(cfg: vscode.WorkspaceConfiguration, provider: string): string {
  return explicitSetting(cfg, "llm.model") || defaultModelFor(provider);
}

/**
 * The embedding model, by the same rule. A set model the registry knows
 * belongs to another provider is dropped too: it is a leftover from switching
 * only the provider (e.g. voyage-code-3 sent to Ollama). Unknown names are
 * kept — they are custom models for the chosen provider.
 */
export function resolveEmbeddingModel(cfg: vscode.WorkspaceConfiguration, provider: string): string {
  const set = explicitSetting(cfg, "embedding.model");
  const owner = set ? EMBEDDING_MODELS[set]?.provider : undefined;
  if (set && (!owner || owner === provider)) return set;
  return DEFAULT_EMBEDDING_MODEL_BY_PROVIDER[provider] ?? "voyage-code-3";
}
