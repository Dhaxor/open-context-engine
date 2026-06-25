import * as vscode from "vscode";
import { ContextService } from "../services/ContextService";

export interface OpenContextConfigPayload {
  type: "config";
  provider: string;
  model: string;
  baseUrl: string;
  hasKey: Record<string, boolean>;
  hasWebSearchKey: boolean;
  hasEmbeddingKey: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  indexWorkspaceRoot: string;
}

export function defaultModelFor(provider: string): string {
  if (provider === "anthropic") return "claude-opus-4-7";
  if (provider === "openai") return "gpt-5.4";
  if (provider === "google") return "gemini-3.1-pro-preview";
  if (provider === "custom") return "";
  return provider;
}

export async function buildConfigPayload(): Promise<OpenContextConfigPayload> {
  const cfg = vscode.workspace.getConfiguration("openContext");
  const provider = cfg.get<string>("llm.provider", "openai");
  const model = cfg.get<string>("llm.model", "") || defaultModelFor(provider);
  const baseUrl = cfg.get<string>("llm.baseUrl", "");
  const embeddingProvider = cfg.get<string>("embedding.provider", "voyage");
  const embeddingModel = cfg.get<string>("embedding.model", "");
  const svc = ContextService.getInstance();
  const hasKey: Record<string, boolean> = {
    openai: await svc.hasLLMApiKey("openai"),
    anthropic: await svc.hasLLMApiKey("anthropic"),
    google: await svc.hasLLMApiKey("google"),
    custom: await svc.hasLLMApiKey("custom"),
  };
  return {
    type: "config",
    provider,
    model,
    baseUrl,
    hasKey,
    hasWebSearchKey: await svc.hasWebSearchApiKey(),
    hasEmbeddingKey: await svc.hasEmbeddingApiKey(),
    embeddingProvider,
    embeddingModel,
    indexWorkspaceRoot: svc.getIndexWorkspaceRoot(),
  };
}

export interface ConfigMessageHandlers {
  onModelChange?: () => void;
  onConfigSent?: () => Promise<void>;
}

/** Handle config-related webview messages. Returns true if handled. */
export async function handleConfigMessage(msg: { type?: string; [k: string]: unknown }, handlers?: ConfigMessageHandlers): Promise<boolean> {
  const svc = ContextService.getInstance();
  switch (msg.type) {
    case "setLLMSelection":
      if (msg.provider && msg.model) {
        await svc.setLLMSelection(String(msg.provider), String(msg.model));
        handlers?.onModelChange?.();
      }
      return true;
    case "saveLLMKey":
      if (typeof msg.apiKey === "string") {
        await svc.setLLMApiKey(msg.apiKey, msg.provider ? String(msg.provider) : undefined);
        await handlers?.onConfigSent?.();
      }
      return true;
    case "setLLMBaseUrl":
      if (typeof msg.baseUrl === "string") {
        await svc.setLLMBaseUrl(String(msg.baseUrl));
        await handlers?.onConfigSent?.();
      }
      return true;
    case "saveEmbeddingKey":
      if (typeof msg.apiKey === "string") {
        await svc.setEmbeddingApiKey(msg.apiKey);
        await handlers?.onConfigSent?.();
      }
      return true;
    case "setWebSearchKey":
      if (typeof msg.apiKey === "string") {
        await svc.setWebSearchApiKey(msg.apiKey);
        await handlers?.onConfigSent?.();
      }
      return true;
    case "getConfig":
      await handlers?.onConfigSent?.();
      return true;
    default:
      return false;
  }
}
