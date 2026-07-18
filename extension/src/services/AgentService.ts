import * as path from "path";
import * as vscode from "vscode";
import { ContextService } from "./ContextService";
import { ContextAgent, defaultAgentTools } from "../../../src/agent/agent";
import { ModelRouter, defaultRoutingConfig } from "../../../src/agent/model-router";
import { SessionMemory } from "../../../src/agent/session-memory";
import { EditProposal, LLMProvider, StreamEvent, ToolCall } from "../../../src/agent/types";
import { AuditLogger, defaultAuditDir } from "../../../src/core/audit";
import { policyRequiresAudit } from "../../../src/core/policy";
import { getLicense, isEntitled } from "../../../src/core/license";
import { VSCodeEditApplier } from "./VSCodeEditApplier";

export interface ToolCallInfo {
    id: string;
    name: string;
    args: Record<string, any>;
    status: "running" | "complete" | "error";
    summary?: string;
}

export interface RetryInfo { attempt: number; delayMs: number; reason: string; }
export interface CompactionInfo { dropped: number; }

export interface AgentEvents {
    onText: (delta: string) => void;
    onToolCall: (info: ToolCallInfo) => void;
    onEdit?: (edit: EditProposal) => void;
    onRetry?: (info: RetryInfo) => void;
    onCompaction?: (info: CompactionInfo) => void;
    onStep?: (info: { step: number; status: "running" | "complete" }) => void;
    onSources?: (files: { path: string; lines?: string }[]) => void;
    onModelSelected?: (tier: { name: string; provider: string; model: string }) => void;
    onDone: () => void;
    onError: (err: Error) => void;
}

const DEFAULT_LLM_MODEL: Record<string, string> = {
    openai: "gpt-5.4",
    anthropic: "claude-opus-4-7",
    google: "gemini-3.1-pro-preview",
    ollama: "llama3.1",
    custom: "",
};

export class AgentService {
    private agent: ContextAgent | null = null;
    private currentProviderKey = "";
    private memoryRef: SessionMemory | null = null;

    /** Clear the cached session memory (and its file). Returns entries removed, or null when memory is off/unbuilt. */
    clearMemories(): number | null {
        return this.memoryRef ? this.memoryRef.clearAll() : null;
    }

    async run(query: string, events: AgentEvents, signal?: AbortSignal): Promise<void> {
        try {
            const agent = await this.ensureAgent(events);
            const pending = new Map<string, ToolCall>();
            await agent.run(query, {
                signal,
                onStream: (ev: StreamEvent) => {
                    if (ev.type === "text" && ev.text) events.onText(ev.text);
                    else if (ev.type === "tool_call" && ev.toolCall) {
                        pending.set(ev.toolCall.id, ev.toolCall);
                        events.onToolCall({
                            id: ev.toolCall.id,
                            name: ev.toolCall.name,
                            args: ev.toolCall.arguments,
                            status: "running",
                        });
                    } else if (ev.type === "tool_result" && ev.toolResult) {
                        const call = pending.get(ev.toolResult.id);
                        pending.delete(ev.toolResult.id);
                        events.onToolCall({
                            id: ev.toolResult.id,
                            name: ev.toolResult.name,
                            args: call?.arguments ?? {},
                            status: ev.toolResult.error ? "error" : "complete",
                            summary: summarize(ev.toolResult.result),
                        });
                        if (!ev.toolResult.error && /retrieval|codebase|search/i.test(ev.toolResult.name)) {
                            const files = extractSources(ev.toolResult.result);
                            if (files.length) events.onSources?.(files);
                        }
                    } else if (ev.type === "retry") {
                        events.onRetry?.({ attempt: ev.retryAttempt ?? 0, delayMs: ev.retryDelayMs ?? 0, reason: ev.retryReason ?? "" });
                    } else if (ev.type === "history_compacted") {
                        events.onCompaction?.({ dropped: ev.droppedMessages ?? 0 });
                    } else if (ev.type === "step_start") {
                        events.onStep?.({ step: ev.step ?? 0, status: "running" });
                    } else if (ev.type === "step_end") {
                        events.onStep?.({ step: ev.step ?? 0, status: "complete" });
                    } else if (ev.type === "model_selected" && ev.tier) {
                        events.onModelSelected?.(ev.tier);
                    }
                },
            });
            events.onDone();
        } catch (err: any) {
            events.onError(err instanceof Error ? err : new Error(String(err)));
        }
    }

    reset(): void {
        this.agent?.reset();
    }

    dispose(): void {
        this.agent = null;
    }

    private async ensureAgent(events: AgentEvents): Promise<ContextAgent> {
        const cfg = vscode.workspace.getConfiguration("openContext");
        const provider = cfg.get<LLMProvider>("llm.provider", "openai");
        const model = cfg.get<string>("llm.model", "") || DEFAULT_LLM_MODEL[provider] || "gpt-4o";
        const baseUrl = cfg.get<string>("llm.baseUrl", "") || undefined;
        const svc = ContextService.getInstance();
        // Ollama runs locally and needs no key; the SDK just wants a non-empty string.
        const apiKey = (await svc.getLLMApiKey(provider)) || envKey(provider) || (provider === "ollama" ? "ollama" : "");
        if (!apiKey) {
            throw new Error(buildMissingKeyMessage(provider));
        }
        const includeEdits = cfg.get<boolean>("agent.allowEdits", true);
        const shellEnabled = cfg.get<boolean>("agent.shell.enabled", false);
        const shellAllowlist = cfg.get<string[]>("agent.shell.allowlist", []) ?? [];
        const shellTimeoutMs = cfg.get<number>("agent.shell.timeoutMs", 60000);
        const webSearchEnabled = cfg.get<boolean>("agent.webSearch.enabled", true);
        const webSearchKey = webSearchEnabled ? await svc.getWebSearchApiKey() : undefined;
        const routingEnabled = cfg.get<boolean>("agent.routing.enabled", false);
        const routingFast = cfg.get<string>("agent.routing.fastModel", "");
        const routingReasoning = cfg.get<string>("agent.routing.reasoningModel", "");
        const memoryEnabled = cfg.get<boolean>("agent.memory.enabled", true);
        const maxTokens = cfg.get<number>("agent.maxTokens", 4096);
        const ctx = await svc.getContext();
        // Audit: on when the user enabled it (and is entitled), or unconditionally
        // when the workspace/org policy requires it — the policy is the authority.
        const auditSetting = cfg.get<boolean>("agent.audit.enabled", false);
        const auditRequired = policyRequiresAudit(ctx.getPolicy() ?? undefined);
        let auditOn = auditRequired;
        if (auditSetting && !auditRequired) {
            if (isEntitled(getLicense(), "audit-log")) auditOn = true;
            else this.warnOnce("openContext.agent.audit.enabled needs an Enterprise license — audit logging stays off. Run 'oce license' to check.");
        }
        const key = `${provider}|${model}|${baseUrl ?? ""}|${apiKey.slice(0, 6)}|root=${ctx.getWorkspaceRoot()}`;
        const cacheKey = `${key}|edits=${includeEdits}|sh=${shellEnabled}|web=${webSearchEnabled && !!webSearchKey}|route=${routingEnabled}:${routingFast}:${routingReasoning}|mem=${memoryEnabled}|mt=${maxTokens}|audit=${auditOn}`;
        if (this.agent && this.currentProviderKey === cacheKey) {
            this.editForwarder = events.onEdit;
            return this.agent;
        }
        let router: ModelRouter | undefined;
        if (routingEnabled && (provider === "openai" || provider === "anthropic")) {
            router = new ModelRouter(defaultRoutingConfig(provider, {
                apiKey,
                standardModel: model,
                fastModel: routingFast || undefined,
                reasoningModel: routingReasoning || undefined,
                maxTokens,
            }));
        }
        const memory = memoryEnabled
            ? new SessionMemory({ storePath: path.join(ctx.getWorkspaceRoot(), ".open-context") })
            : undefined;
        this.memoryRef = memory ?? null;
        const applier = new VSCodeEditApplier(ctx.getWorkspaceRoot());
        this.editForwarder = events.onEdit;
        this.agent = new ContextAgent({
            provider,
            model,
            apiKey,
            baseUrl,
            maxSteps: cfg.get<number>("agent.maxSteps", 10),
            maxTokens: cfg.get<number>("agent.maxTokens", 4096),
            historyTokenBudget: cfg.get<number>("agent.historyTokenBudget", 120000),
            maxToolResultChars: cfg.get<number>("agent.maxToolResultChars", 24000),
            maxRetries: cfg.get<number>("agent.maxRetries", 3),
            router,
            memory,
            memorySource: "vscode-agent",
            audit: auditOn ? new AuditLogger({ dir: defaultAuditDir(ctx.getWorkspaceRoot()) }) : undefined,
            tools: defaultAgentTools({
                context: ctx,
                applier,
                includeEdits,
                onEdit: (edit) => this.editForwarder?.(edit),
                shell: shellEnabled ? { enabled: true, allowlist: shellAllowlist, timeoutMs: shellTimeoutMs } : false,
                webSearch: webSearchEnabled ? { enabled: true, apiKey: webSearchKey } : false,
                retrieveOptions: () => svc.getIdeRetrieveOptionsForCurrentContext(),
                onPolicyBlock: (cap, reason) => this.warnOnce(`Workspace policy: ${reason}.`),
            }),
        });
        this.currentProviderKey = cacheKey;
        return this.agent;
    }

    private editForwarder?: (edit: EditProposal) => void;
    private warned = new Set<string>();

    /** Show each distinct policy/licensing warning once per session, not per turn. */
    private warnOnce(message: string): void {
        if (this.warned.has(message)) return;
        this.warned.add(message);
        void vscode.window.showWarningMessage(message);
    }
}

function summarize(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= 200) return trimmed;
    return trimmed.slice(0, 200) + "…";
}

/** Best-effort: pull `path:line(-line)` file references out of a retrieval tool result. */
function extractSources(text: string): { path: string; lines?: string }[] {
    const out: { path: string; lines?: string }[] = [];
    const seen = new Set<string>();
    const re = /(?:^|\n)\s*([A-Za-z0-9_.@\/+\-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && out.length < 12) {
        const p = m[1];
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({ path: p, lines: m[3] ? `${m[2]}-${m[3]}` : m[2] });
    }
    return out;
}

function envKey(provider: LLMProvider): string {
    if (provider === "openai") return process.env.OPENAI_API_KEY ?? "";
    if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY ?? "";
    if (provider === "google") return process.env.GOOGLE_API_KEY ?? "";
    return "";
}

function buildMissingKeyMessage(provider: LLMProvider): string {
    if (provider === "custom") {
        return `LLM API key not set. Open Model & API keys and enter your custom endpoint key.`;
    }
    const envName = provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_API_KEY";
    return `LLM API key not set. Run the command "Open Context: Set LLM API Key" or set the ${envName} environment variable.`;
}
