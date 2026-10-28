/**
 * The agent stack, assembled once for every front end.
 *
 * `oce agent` / `oce trace` (src/cli/session.ts) and the VS Code extension each
 * own their own config and index — the CLI resolves flags and a config file and
 * indexes on start; the extension reads its settings and keeps an index live in
 * the window. Everything AFTER that is the same: tools filtered by policy,
 * approvals, the plan, sub-agent delegation, the retrieval ledger, checkpoints,
 * and the TraceSession every UI subscribes to. That part lives here, because
 * two copies of it is how one surface gets a policy or approval fix and the
 * other silently does not.
 */

import type { OpenContext } from "../core/context";
import type { AuditLogger } from "../core/audit";
import { ContextAgent, defaultAgentTools, defaultCodebaseTools, RetrievalObserver } from "../agent/agent";
import type { LLMProvider } from "../agent/agent";
import { AgentPlan } from "../agent/plan";
import { ApprovalMode, PermissionManager } from "../agent/permissions";
import type { SessionStore } from "../agent/session-store";
import type { DelegateObserver } from "../agent/delegate";
import type { EditApplier } from "../agent/edit-tools";
import type { EditProposal, ToolDefinition } from "../agent/types";
import { environmentProvider } from "../agent/env";
import { contextWindowFor } from "../agent/providers";
import { ContextLedger } from "./ledger";
import { CheckpointStore } from "./checkpoints";
import { TraceSession } from "./session";
import type { SessionMeta } from "./protocol";

type ToolOptions = Parameters<typeof defaultAgentTools>[0];

export interface AgentStackInput {
  ctx: OpenContext;
  workspaceRoot: string;
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  router?: import("../agent/model-router").ModelRouter;
  memory?: import("../agent/session-memory").SessionMemory;
  /** Tags memories with where they came from ("cli-agent", "vscode-agent"). */
  memorySource: string;
  audit?: AuditLogger;
  /** How edits reach disk: the filesystem for the CLI, a WorkspaceEdit in VS Code. */
  applier: EditApplier;
  mode: ApprovalMode;
  includeEdits: boolean;
  shell: ToolOptions["shell"];
  webSearch?: ToolOptions["webSearch"];
  retrieveOptions?: ToolOptions["retrieveOptions"];
  /** Give the agent the update-plan tool. */
  plan: boolean;
  /** Give the agent the read-only delegate (sub-agent) tool. */
  delegate: boolean;
  /** Inject platform/git/index facts into the system prompt. */
  env: boolean;
  /** Build the ledger, checkpoints, and TraceSession. The classic REPL has
   *  nothing to render them with, and the untraced search path is cheaper. */
  traced: boolean;
  agent?: Pick<import("../agent/types").AgentConfig, "maxSteps" | "maxTokens" | "historyTokenBudget" | "maxToolResultChars" | "maxRetries">;
  onEdit?: (edit: EditProposal) => void;
  onPolicyBlock?: (capability: "edits" | "shell" | "web-search", reason: string) => void;
  /** Re-index a file a rewind restored (or remove it, when contents is null). */
  onRestored?: (path: string, contents: string | null) => Promise<void>;
  sessionStore: SessionStore;
  sessionId: string;
  /** A saved conversation to continue. Import failures throw. */
  restore?: Parameters<ContextAgent["importSession"]>[0];
  /** Static session facts for the TraceSession beyond what this can derive. */
  meta?: Partial<Pick<SessionMeta, "title" | "branch" | "indexFresh">>;
  maxOutputLength?: number;
}

export interface AgentStack {
  agent: ContextAgent;
  plan: AgentPlan;
  permissions: PermissionManager;
  tools: ToolDefinition[];
  /** Present only when `traced`. */
  trace?: TraceSession;
  ledger?: ContextLedger;
  checkpoints?: CheckpointStore;
}

export function assembleAgentStack(input: AgentStackInput): AgentStack {
  const { ctx, provider, model, traced } = input;

  const permissions = new PermissionManager({ mode: input.mode });
  const plan = new AgentPlan();

  // The traced surfaces need the ledger before the agent exists (tools capture
  // the observer) and the session before the ledger can be fed — so the
  // observer is indirected through a holder rather than reordering the wiring.
  const ledger = traced
    ? new ContextLedger({
      windowTokens: contextWindowFor(model),
      systemPrompt: () => baseEnvironment(),
      toolSchemas: () => tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
      maxOutputLength: input.maxOutputLength,
    })
    : undefined;
  const applier = input.applier;
  const checkpoints = traced
    ? new CheckpointStore({
      applier,
      onRestored: async paths => {
        // Re-index restored files so retrieval reflects the rewound tree.
        for (const p of paths) {
          try {
            const contents = await applier.readFile(p);
            if (input.onRestored) await input.onRestored(p, contents);
            else if (contents === null) await ctx.removeFromIndex([p]);
            else await ctx.addFiles([{ path: p, contents }]);
          } catch {}
        }
      },
    })
    : undefined;
  const observer: { fn?: RetrievalObserver } = {};
  // Same indirection as retrieval: the tools capture these before the session
  // that fulfils them exists.
  const delegation: { observer?: DelegateObserver } = {};

  const tools = defaultAgentTools({
    context: ctx,
    applier,
    includeEdits: input.includeEdits,
    shell: input.shell,
    ...(input.webSearch !== undefined ? { webSearch: input.webSearch } : {}),
    ...(input.retrieveOptions ? { retrieveOptions: input.retrieveOptions } : {}),
    ...(input.onEdit ? { onEdit: input.onEdit } : {}),
    plan: input.plan ? plan : undefined,
    ...(traced ? { onRetrieval: ((o) => observer.fn?.(o)) as RetrievalObserver } : {}),
    delegate: input.delegate ? {
      ...(traced ? { observer: {
        start: (id, task) => delegation.observer?.start(id, task),
        event: (id, event) => delegation.observer?.event(id, event),
        end: (id, result) => delegation.observer?.end(id, result),
      } } : {}),
      makeAgent: () => new ContextAgent({
        provider, model, apiKey: input.apiKey, baseUrl: input.baseUrl, router: input.router,
        tools: defaultCodebaseTools(ctx, input.retrieveOptions),
        maxSteps: 8, compaction: "drop",
        systemPrompt: "You are a codebase research sub-agent. Investigate the brief thoroughly with your tools, then reply with a single, complete report (file paths + line ranges + key excerpts). Your reply goes to another agent, not a human.",
      }),
    } : undefined,
    ...(input.onPolicyBlock ? { onPolicyBlock: input.onPolicyBlock } : {}),
  });
  permissions.registerMutatingTools(tools.filter(t => t.mutates).map(t => t.name));

  const baseEnv = input.env
    ? environmentProvider(input.workspaceRoot, () => ({ chunks: ctx.getChunkCount(), searchMode: ctx.getStatus().searchMode }))
    : undefined;
  function baseEnvironment(): string {
    try { return baseEnv?.() ?? ""; } catch { return ""; }
  }
  // Pinned context rides in the system prompt (not the transcript) so a pin
  // outlives compaction — which is the only thing that makes pinning worth
  // offering. environmentProvider is appended verbatim, so no header is
  // imposed on top of the block's own.
  const environment = baseEnv || ledger
    ? () => [baseEnvironment(), ledger?.pinnedBlock()].filter(Boolean).join("\n\n")
    : undefined;

  const agent = new ContextAgent({
    provider,
    model,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    tools,
    router: input.router,
    memory: input.memory,
    memorySource: input.memorySource,
    audit: input.audit,
    hooks: permissions.asHooks(),
    environmentProvider: environment,
    ...input.agent,
  });
  if (input.restore) agent.importSession(input.restore);

  let trace: TraceSession | undefined;
  if (traced && ledger && checkpoints) {
    const meta: Omit<SessionMeta, "turn" | "startedAt" | "mode"> = {
      id: input.sessionId,
      title: input.meta?.title ?? "",
      workspace: input.workspaceRoot,
      ...(input.meta?.branch ? { branch: input.meta.branch } : {}),
      provider,
      model,
      windowTokens: contextWindowFor(model),
      indexedChunks: ctx.getChunkCount(),
      searchMode: ctx.getStatus().searchMode === "keyword-only" ? "keyword-only" : "hybrid",
      indexFresh: input.meta?.indexFresh ?? true,
      auditing: !!input.audit,
    };
    // The shell tool the agent got is the same one `!command` uses, so a
    // policy that stripped it also disables the composer's direct shell —
    // there is no second path around the policy.
    const shell = tools.find(t => t.name === "run-command");
    trace = new TraceSession({
      id: input.sessionId, agent, plan, permissions, ledger, checkpoints, meta,
      audit: input.audit, sessionStore: input.sessionStore,
      callersOf: (p) => safeCallers(ctx, p),
      listFiles: () => safeIndexedPaths(ctx),
      readFile: (p) => ctx.readFile(p),
      ...(shell ? { runCommand: (command, signal) => shell.handler({ command }, signal) } : {}),
      ...(input.restore ? { resumed: { title: input.meta?.title ?? "", messages: agent.getMessages() } } : {}),
    });
    observer.fn = trace.observeRetrieval;
    delegation.observer = trace.delegateObserver;
  }

  return { agent, plan, permissions, tools, trace, ledger, checkpoints };
}

/** Indexed paths for `@` autocomplete. A store that cannot answer just means
 *  an empty menu, never a broken composer. */
function safeIndexedPaths(ctx: OpenContext): string[] {
  try {
    return ctx.getIndexedPaths();
  } catch {
    return [];
  }
}

/** Indexed references to a path, for approval blast-radius. Never throws — a
 *  missing count only costs the UI a hint. */
function safeCallers(ctx: OpenContext, filePath: string): number {
  try {
    const symbol = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    if (!symbol) return 0;
    return ctx.findSymbolReferences(symbol, undefined, 50).length;
  } catch {
    return 0;
  }
}
