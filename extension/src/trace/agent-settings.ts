import * as vscode from "vscode";
import type { ApprovalMode } from "../../../src/agent/permissions";
import type { LLMProvider } from "../../../src/agent/types";
import { ContextService } from "../services/ContextService";
import { resolveLLMModel } from "../shared/model-settings";
import type { SetupNeed } from "./protocol";

const DEFAULT_LLM_MODEL: Record<string, string> = {
    openai: "gpt-5.4",
    anthropic: "claude-opus-4-7",
    google: "gemini-3.1-pro-preview",
    ollama: "llama3.1",
    custom: "",
};

const MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];

/** Something the user has to do before the agent can run; carries what the UI should say. */
export class SetupError extends Error {
    constructor(public readonly need: SetupNeed) {
        super(need.message);
        this.name = "SetupError";
    }
}

/** Everything the agent stack is built from that comes out of VS Code settings. */
export interface AgentSettings {
    provider: LLMProvider;
    model: string;
    baseUrl?: string;
    apiKey: string;
    webSearchKey?: string;
    includeEdits: boolean;
    shell: false | { enabled: true; allowlist: string[]; timeoutMs: number };
    webSearch: boolean;
    routing: { enabled: boolean; fastModel: string; reasoningModel: string };
    memory: boolean;
    audit: boolean;
    limits: { maxSteps: number; maxTokens: number; historyTokenBudget: number; maxToolResultChars: number; maxRetries: number };
    mode: ApprovalMode;
    /**
     * Every setting a built stack captures, so a change means rebuilding it.
     * The keys are compared separately (AgentSettings.apiKey / webSearchKey)
     * and never folded in here, so they can never end up in a string that
     * might be logged. The approval mode is absent on purpose: it applies to a
     * live session without a rebuild.
     */
    fingerprint: string;
}

export async function readAgentSettings(): Promise<AgentSettings> {
    const cfg = vscode.workspace.getConfiguration("openContext");
    const svc = ContextService.getInstance();
    const provider = cfg.get<LLMProvider>("llm.provider", "openai");
    // Not cfg.get: package.json's default ("gpt-5.4"), or a model saved for
    // another provider, would follow the user into a provider picked in
    // settings.json.
    const model = resolveLLMModel(cfg, provider, svc.getLLMSelection()) || DEFAULT_LLM_MODEL[provider] || "gpt-4o";
    const baseUrl = cfg.get<string>("llm.baseUrl", "") || undefined;
    // Ollama runs locally and needs no key; the SDK just wants a non-empty string.
    const apiKey = (await svc.getLLMApiKey(provider)) || envKey(provider) || (provider === "ollama" ? "ollama" : "");
    if (!apiKey) throw new SetupError({ kind: "llm-key", message: missingKeyMessage(provider) });

    const shellEnabled = cfg.get<boolean>("agent.shell.enabled", false);
    const shellAllowlist = cfg.get<string[]>("agent.shell.allowlist", []) ?? [];
    const shellTimeoutMs = cfg.get<number>("agent.shell.timeoutMs", 60000);
    const webSearch = cfg.get<boolean>("agent.webSearch.enabled", true);
    const webSearchKey = webSearch ? await svc.getWebSearchApiKey() : undefined;
    const routing = {
        enabled: cfg.get<boolean>("agent.routing.enabled", false),
        fastModel: cfg.get<string>("agent.routing.fastModel", ""),
        reasoningModel: cfg.get<string>("agent.routing.reasoningModel", ""),
    };
    const limits = {
        maxSteps: cfg.get<number>("agent.maxSteps", 25),
        maxTokens: cfg.get<number>("agent.maxTokens", 4096),
        historyTokenBudget: cfg.get<number>("agent.historyTokenBudget", 120000),
        maxToolResultChars: cfg.get<number>("agent.maxToolResultChars", 24000),
        maxRetries: cfg.get<number>("agent.maxRetries", 3),
    };
    const includeEdits = cfg.get<boolean>("agent.allowEdits", true);
    const memory = cfg.get<boolean>("agent.memory.enabled", true);
    const audit = cfg.get<boolean>("agent.audit.enabled", false);
    const configuredMode = cfg.get<string>("agent.approvalMode", "auto-edit");
    const mode = MODES.includes(configuredMode as ApprovalMode) ? configuredMode as ApprovalMode : "auto-edit";

    const fingerprint = [
        provider, model, baseUrl ?? "", `edits=${includeEdits}`,
        `sh=${shellEnabled}:${shellAllowlist.join("\u0000")}:${shellTimeoutMs}`,
        `web=${webSearch && !!webSearchKey}`, `route=${routing.enabled}:${routing.fastModel}:${routing.reasoningModel}`,
        `mem=${memory}`, `audit=${audit}`,
        `lim=${limits.maxSteps}:${limits.maxTokens}:${limits.historyTokenBudget}:${limits.maxToolResultChars}:${limits.maxRetries}`,
    ].join("|");

    return {
        provider, model, baseUrl, apiKey, webSearchKey, includeEdits,
        shell: shellEnabled ? { enabled: true, allowlist: shellAllowlist, timeoutMs: shellTimeoutMs } : false,
        webSearch: webSearch && !!webSearchKey,
        routing, memory, audit, limits, mode, fingerprint,
    };
}

/** Remember an approval mode picked in the UI for the next session and window. */
export async function saveApprovalMode(mode: ApprovalMode): Promise<void> {
    await vscode.workspace.getConfiguration("openContext").update("agent.approvalMode", mode, vscode.ConfigurationTarget.Global);
}

function envKey(provider: LLMProvider): string {
    if (provider === "openai") return process.env.OPENAI_API_KEY ?? "";
    if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY ?? "";
    if (provider === "google") return process.env.GOOGLE_API_KEY ?? "";
    return "";
}

function missingKeyMessage(provider: LLMProvider): string {
    if (provider === "custom") return "Add the API key for your custom endpoint to start the agent.";
    const envName = provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_API_KEY";
    return `Add your ${provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : "Google"} API key (or set ${envName}) to start the agent.`;
}
