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
export function resolveLLMModel(
  cfg: vscode.WorkspaceConfiguration,
  provider: string,
  /** What the model & keys form last saved (ContextService.getLLMSelection). */
  formSelection?: { provider: string; model: string },
): string {
  const set = explicitSetting(cfg, "llm.model");
  if (!set) return defaultModelFor(provider);
  // Still exactly what the form saved for another provider: a leftover from
  // switching llm.provider on its own, not a choice (catches custom IDs such
  // as meta-llama/llama-3-70b that no name pattern can place).
  if (formSelection && set === formSelection.model && formSelection.provider !== provider) {
    return defaultModelFor(provider);
  }
  // A set model that is recognisably another hosted provider's (e.g. gpt-5.4
  // pinned by an earlier save, then llm.provider switched to anthropic) is a
  // leftover, not a choice. `custom` endpoints (OpenRouter and the like) serve
  // every provider's names, so they keep whatever was set.
  const owner = hostedModelOwner(set);
  if (owner && owner !== provider && provider !== "custom") return defaultModelFor(provider);
  return set;
}

/** The hosted provider a model name belongs to, when the name says so. */
function hostedModelOwner(model: string): "openai" | "anthropic" | "google" | undefined {
  // gpt-<digit>, not gpt-: Ollama serves open-weight models named gpt-oss.
  if (/^(gpt-\d|chatgpt-|o\d(-|$))/i.test(model)) return "openai";
  if (/^claude-/i.test(model)) return "anthropic";
  if (/^gemini-/i.test(model)) return "google";
  return undefined;
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
