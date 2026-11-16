import { createHash } from "crypto";
import * as vscode from "vscode";
import type { ApprovalMode } from "../../../src/agent/permissions";
import type { LLMProvider } from "../../../src/agent/types";
import type { McpServerConfig } from "../../../src/agent/mcp-client";
import { loadUserMcpServers } from "../../../src/cli/config-file";
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
    shell: false | { enabled: true; allowlist: string[]; timeoutMs: number; sandbox: boolean };
    webSearch: boolean;
    routing: { enabled: boolean; fastModel: string; reasoningModel: string };
    memory: boolean;
    audit: boolean;
    limits: { maxSteps: number; maxTokens: number; historyTokenBudget: number; maxToolResultChars: number; maxRetries: number };
    mode: ApprovalMode;
    /** The user's MCP servers whose tools the agent gets. */
    mcpServers: Record<string, McpServerConfig>;
    /** A digest of mcpServers — they can carry tokens, so only this is compared. */
    mcpKey: string;
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

    const shellEnabled = cfg.get<boolean>("agent.shell.enabled", true);
    const shellSandbox = cfg.get<boolean>("agent.shell.sandbox", true);
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
    const mode = configuredApprovalMode();
    const mcpServers = configuredMcpServers(svc.getIndexWorkspaceRoot());
    const mcpKey = Object.keys(mcpServers).length
        ? createHash("sha256").update(JSON.stringify(mcpServers)).digest("hex").slice(0, 16)
        : "";

    const fingerprint = [
        provider, model, baseUrl ?? "", `edits=${includeEdits}`,
        `sh=${shellEnabled}:${shellSandbox}:${shellAllowlist.join("\u0000")}:${shellTimeoutMs}`,
        `web=${webSearch && !!webSearchKey}`, `route=${routing.enabled}:${routing.fastModel}:${routing.reasoningModel}`,
        `mem=${memory}`, `audit=${audit}`,
        `lim=${limits.maxSteps}:${limits.maxTokens}:${limits.historyTokenBudget}:${limits.maxToolResultChars}:${limits.maxRetries}`,
        `mcp=${mcpKey}`,
    ].join("|");

    return {
        provider, model, baseUrl, apiKey, webSearchKey, includeEdits,
        shell: shellEnabled ? { enabled: true, allowlist: shellAllowlist, timeoutMs: shellTimeoutMs, sandbox: shellSandbox } : false,
        webSearch: webSearch && !!webSearchKey,
        routing, memory, audit, limits, mode, mcpServers, mcpKey, fingerprint,
    };
}

/**
 * The MCP servers the agent may start: `openContext.agent.mcpServers` from
 * USER settings (the setting is machine-scoped, and a workspace value is
 * ignored even so) over the CLI's ~/.open-context/config.json. A server is a
 * program the agent launches — a folder you opened must not be able to choose
 * it, and in a Restricted Mode window none is started at all.
 */
export function configuredMcpServers(workspaceRoot: string): Record<string, McpServerConfig> {
    if (vscode.workspace.isTrusted === false) return {};
    const fromSettings = vscode.workspace.getConfiguration("openContext").inspect?.<Record<string, McpServerConfig>>("agent.mcpServers")?.globalValue;
    let fromFile: Record<string, McpServerConfig> = {};
    try { fromFile = loadUserMcpServers(workspaceRoot || process.cwd()).servers; } catch {}
    const merged = { ...fromFile, ...(fromSettings && typeof fromSettings === "object" && !Array.isArray(fromSettings) ? fromSettings : {}) };
    return Object.fromEntries(Object.entries(merged).filter(([, v]) => v && typeof v === "object"));
}

/** The approval mode the settings ask for, falling back to auto-edit. */
export function configuredApprovalMode(): ApprovalMode {
    const configured = vscode.workspace.getConfiguration("openContext").get<string>("agent.approvalMode", "auto-edit");
    return MODES.includes(configured as ApprovalMode) ? configured as ApprovalMode : "auto-edit";
}

/**
 * Remember an approval mode picked in the UI. Written where the setting is
 * already defined: a workspace value would otherwise outrank a global write,
 * and the next configuration event would put every session back.
 */
export async function saveApprovalMode(mode: ApprovalMode): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("openContext");
    const where = cfg.inspect?.<string>("agent.approvalMode");
    const target = where?.workspaceValue !== undefined || where?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await cfg.update("agent.approvalMode", mode, target);
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
