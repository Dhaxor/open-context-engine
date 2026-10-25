/**
 * One wiring path for an agent session, shared by every front end.
 *
 * `oce agent` (REPL/TUI) and `oce trace` (server → Studio, desktop) need the
 * identical stack: resolved config, an index, tools filtered by policy,
 * approvals, memory, routing, audit, and session persistence. This used to live
 * inline in the `agent` command; two commands duplicating ~150 lines of that is
 * how surfaces silently drift apart — one gets a policy fix, the other does not.
 *
 * Config resolution and process exit stay with the caller (`resolveConfig`,
 * `fatal`), so this module holds wiring and no CLI policy.
 */

import { OpenContext } from "../core/context";
import { OpenContextConfig } from "../core/types";
import { ContextAgent, defaultAgentTools, defaultCodebaseTools, LLMProvider, RetrievalObserver } from "../agent/agent";
import { checkReady, resolveProvider } from "../agent/presets";
import { AgentPlan } from "../agent/plan";
import { PermissionManager } from "../agent/permissions";
import { SessionStore } from "../agent/session-store";
import { EditProposal, ToolDefinition } from "../agent/types";
import { environmentProvider } from "../agent/env";
import { FsEditApplier } from "../agent/edit-tools";
import { AuditLogger, defaultAuditDir } from "../core/audit";
import { policyRequiresAudit } from "../core/policy";
import { getLicense, isEntitled } from "../core/license";
import { loadFileConfig } from "./config-file";
import { Diagnostics } from "../core/diagnostics";
import { ContextLedger } from "../trace/ledger";
import { CheckpointStore } from "../trace/checkpoints";
import { TraceSession } from "../trace/session";
import { SessionMeta } from "../trace/protocol";
import { contextWindowFor } from "../agent/providers";

const FALLBACK_MODEL: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-3-flash",
  ollama: "llama3.1",
};

/** Named providers `-p` accepts beyond the four built-in ones. */
export { PROVIDER_PRESETS, freePresets } from "../agent/presets";

export interface BuildSessionInput {
  /** Parsed commander options for the `agent`/`trace` commands. */
  opts: any;
  diag: Diagnostics;
  /** Interactive sessions get edits+shell behind approvals; --print does not. */
  interactive: boolean;
  /**
   * Build the retrieval ledger, checkpoint store, and TraceSession. Off for the
   * classic REPL, which has nothing to render them with — and the untraced
   * search path is cheaper.
   */
  traced?: boolean;
  resolveConfig: (opts: any) => OpenContextConfig;
  /** Report a fatal misconfiguration. Never returns. */
  fatal: (message: string) => never;
}

export interface BuiltSession {
  ctx: OpenContext;
  config: OpenContextConfig;
  agent: ContextAgent;
  plan: AgentPlan;
  permissions: PermissionManager;
  tools: ToolDefinition[];
  sessionStore: SessionStore;
  sessionId: string;
  /** Edits made this session, in order (the REPL's /diff reads this). */
  editLog: EditProposal[];
  audit?: AuditLogger;
  watcher: import("../core/file-watcher").FileWatcher | null;
  memory?: import("../agent/session-memory").SessionMemory;
  router?: import("../agent/model-router").ModelRouter;
  provider: LLMProvider;
  model: string;
  /** Present only when `traced`. */
  trace?: TraceSession;
  ledger?: ContextLedger;
  checkpoints?: CheckpointStore;
  /** Stop the watcher and close the index. Safe to call twice. */
  close: () => Promise<void>;
}

export async function buildSession(input: BuildSessionInput): Promise<BuiltSession> {
  const { opts, diag, interactive, fatal } = input;
  const traced = !!input.traced;

  // LLM settings resolve flags → config file → defaults. The LLM provider is
  // DISTINCT from the embedding provider: `-p anthropic` must not leak into the
  // embedding config.
  const fileCfg = loadFileConfig(opts.workspace || process.cwd()).config;
  const providerName = opts.provider || fileCfg.llm?.provider || "openai";
  // The file's model/baseUrl only apply when the file's provider is in effect.
  const fileLlmApplies = !opts.provider || opts.provider === fileCfg.llm?.provider;
  opts.llmModel = opts.llmModel || (fileLlmApplies ? fileCfg.llm?.model : undefined);
  opts.llmBaseUrl = opts.llmBaseUrl || (fileLlmApplies ? fileCfg.llm?.baseUrl : undefined);

  // A preset supplies the endpoint, default model, and key env var for
  // providers that are otherwise three pieces of trivia away from working.
  // Explicit flags still win; an unrecognised name passes straight through, so
  // the original four provider names behave exactly as before.
  const resolved = resolveProvider({
    provider: providerName,
    model: opts.llmModel,
    apiKey: opts.apiKey,
    baseUrl: opts.llmBaseUrl,
  });
  const provider = resolved.provider;
  opts.llmModel = resolved.model;
  opts.llmBaseUrl = resolved.baseUrl;
  opts.apiKey = resolved.apiKey;

  const readiness = checkReady(resolved);
  if (!readiness.ok) fatal(readiness.message);

  // Routing is validated up front — before the (potentially long) index run —
  // so a bad `--route` fails in milliseconds, not minutes.
  let router: import("../agent/model-router").ModelRouter | undefined;
  if (opts.route) {
    try {
      const { ModelRouter, defaultRoutingConfig } = await import("../agent/model-router");
      router = new ModelRouter(defaultRoutingConfig(provider, { apiKey: opts.apiKey, standardModel: opts.llmModel }));
    } catch (e: any) {
      fatal(`--route: ${e?.message ?? e}`);
    }
  }

  const config = input.resolveConfig({ ...opts, provider: opts.embeddingProvider, model: opts.embeddingModel, apiKey: undefined });
  const ctx = await OpenContext.create(config);
  const degraded = keywordOnlyWarning(ctx.getStatus());
  if (degraded) diag.progress(`${degraded}\n`);

  let watcher: import("../core/file-watcher").FileWatcher | null = null;
  if (opts.index !== false) {
    const { liveIndex } = await import("../core/live-index");
    diag.progress("Indexing workspace...\n");
    const { result, watcher: w } = await liveIndex(ctx, config, {
      watch: !!opts.watch,
      onProgress: (s, c, t) => t > 0 && diag.progress(`\r[${s}] ${c}/${t}   `),
      onReindex: (r) => { if (r.failed?.length) diag.warn(`[watch] ⚠ ${r.failed.length} file(s) failed to embed (will retry on next index): ${r.failedReason ?? ""}`); },
      onError: (e) => diag.error(`[watch error] ${e.message}`),
    });
    watcher = w;
    diag.progress(`\rIndexed ${ctx.getChunkCount()} chunks (+${result.newlyIndexed.length} new)${watcher ? "; watching for changes" : ""}.\n`);
    if (result.failed?.length) {
      diag.progress(`⚠ ${result.failed.length} file(s) failed to embed — answers may miss context until the next index retries them. ${result.failedReason ?? ""}\n`);
    }
  }

  let memory: import("../agent/session-memory").SessionMemory | undefined;
  if (opts.memory) {
    const { SessionMemory } = await import("../agent/session-memory");
    const pathMod = await import("path");
    memory = new SessionMemory({ storePath: config.storePath || pathMod.join(config.workspaceRoot, ".open-context") });
  }

  const model = opts.llmModel || FALLBACK_MODEL[provider] || "gpt-4o";

  // Approvals: interactive sessions get edits+shell BEHIND the approval flow
  // (suggest mode asks per mutation); --print has no approver, so tools stay
  // opt-in via the explicit flags.
  const permissions = new PermissionManager({
    mode: opts.fullAuto ? "full-auto" : opts.autoEdit ? "auto-edit" : interactive ? "suggest" : "full-auto",
  });
  const plan = new AgentPlan();
  const editLog: EditProposal[] = [];

  // The traced surfaces need the ledger before the agent exists (tools capture
  // the observer) and the session before the ledger can be fed — so the
  // observer is indirected through a holder rather than reordering the wiring.
  const ledger = traced
    ? new ContextLedger({
      windowTokens: contextWindowFor(model),
      systemPrompt: () => baseEnvironment(),
      toolSchemas: () => tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
      maxOutputLength: config.search?.maxOutputLength,
    })
    : undefined;
  const applier = new FsEditApplier(config.workspaceRoot);
  const checkpoints = traced
    ? new CheckpointStore({
      applier,
      onRestored: async paths => {
        // Re-index restored files so retrieval reflects the rewound tree.
        for (const p of paths) {
          try {
            const contents = await applier.readFile(p);
            if (contents === null) await ctx.removeFromIndex([p]);
            else await ctx.addFiles([{ path: p, contents }]);
          } catch {}
        }
      },
    })
    : undefined;
  const observer: { fn?: RetrievalObserver } = {};
  // Same indirection as retrieval: the tools capture these before the session
  // that fulfils them exists.
  const delegation: { observer?: import("../agent/delegate").DelegateObserver } = {};

  // Policy can strip capabilities the flags asked for — say so up front instead
  // of letting the agent discover missing tools mid-run.
  const policyBlocks: string[] = [];
  const tools = defaultAgentTools({
    context: ctx,
    applier,
    includeEdits: interactive ? true : !!opts.allowEdits,
    shell: interactive ? true : !!opts.allowShell,
    onEdit: (e) => editLog.push(e),
    plan: opts.plan !== false ? plan : undefined,
    ...(traced ? { onRetrieval: ((o) => observer.fn?.(o)) as RetrievalObserver } : {}),
    delegate: opts.delegate !== false ? {
      ...(traced ? { observer: {
        start: (id, task) => delegation.observer?.start(id, task),
        event: (id, event) => delegation.observer?.event(id, event),
        end: (id, result) => delegation.observer?.end(id, result),
      } } : {}),
      makeAgent: () => new ContextAgent({
        provider, model, apiKey: opts.apiKey, baseUrl: opts.llmBaseUrl, router,
        tools: defaultCodebaseTools(ctx),
        maxSteps: 8, compaction: "drop",
        systemPrompt: "You are a codebase research sub-agent. Investigate the brief thoroughly with your tools, then reply with a single, complete report (file paths + line ranges + key excerpts). Your reply goes to another agent, not a human.",
      }),
    } : undefined,
    onPolicyBlock: (cap, reason) => policyBlocks.push(`${cap}: ${reason}`),
  });
  for (const b of policyBlocks) diag.progress(`⚠ policy: ${b}\n`);
  permissions.registerMutatingTools(tools.filter(t => t.mutates).map(t => t.name));

  // Audit: explicit --audit needs the audit-log entitlement; a policy that
  // REQUIRES audit always wins (the signed policy is the org's authority).
  let audit: AuditLogger | undefined;
  const wsPolicy = ctx.getPolicy();
  if (opts.audit || (wsPolicy && policyRequiresAudit(wsPolicy))) {
    if (!opts.audit || isEntitled(getLicense(), "audit-log") || policyRequiresAudit(wsPolicy ?? undefined)) {
      audit = new AuditLogger({ dir: defaultAuditDir(config.workspaceRoot, config.storePath) });
      diag.progress(`Audit log: ${audit.getFilePath()}\n`);
    } else {
      fatal(`--audit requires an Enterprise license ('oce license' to check). Workspace policies can also require audit.`);
    }
  }

  const baseEnv = opts.env !== false
    ? environmentProvider(config.workspaceRoot, () => ({ chunks: ctx.getChunkCount(), searchMode: ctx.getStatus().searchMode }))
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
    apiKey: opts.apiKey,
    baseUrl: opts.llmBaseUrl,
    tools,
    router,
    memory,
    memorySource: "cli-agent",
    audit,
    hooks: permissions.asHooks(),
    environmentProvider: environment,
  });

  // Sessions: every conversation persists; --continue / --resume restore one.
  const sessionStore = SessionStore.forWorkspace(config.workspaceRoot, config.storePath);
  let sessionId = sessionStore.newId();
  if (opts.continue || opts.resume) {
    const saved = opts.resume ? sessionStore.load(String(opts.resume)) : sessionStore.latest();
    if (saved) {
      try {
        agent.importSession(saved.session);
        sessionId = saved.id;
        diag.progress(`Resumed session '${saved.title}' (${saved.turns} turns).\n`);
      } catch (e: any) {
        fatal(`Could not resume session: ${e?.message ?? e}`);
      }
    } else if (opts.resume) {
      fatal(`No session '${opts.resume}' — run /sessions in the REPL or check .open-context/sessions/.`);
    }
  }

  let trace: TraceSession | undefined;
  if (traced && ledger && checkpoints) {
    const meta: Omit<SessionMeta, "turn" | "startedAt" | "mode"> = {
      id: sessionId,
      title: "",
      workspace: config.workspaceRoot,
      ...(opts.branch ? { branch: String(opts.branch) } : {}),
      provider,
      model,
      windowTokens: contextWindowFor(model),
      indexedChunks: ctx.getChunkCount(),
      searchMode: ctx.getStatus().searchMode === "keyword-only" ? "keyword-only" : "hybrid",
      indexFresh: true,
      auditing: !!audit,
    };
    // The shell tool the agent got is the same one `!command` uses, so a
    // policy that stripped it also disables the composer's direct shell —
    // there is no second path around the policy.
    const shell = tools.find(t => t.name === "run-command");
    trace = new TraceSession({
      id: sessionId, agent, plan, permissions, ledger, checkpoints, meta, audit, sessionStore,
      callersOf: (p) => safeCallers(ctx, p),
      listFiles: () => safeIndexedPaths(ctx),
      readFile: (p) => ctx.readFile(p),
      ...(shell ? { runCommand: (command, signal) => shell.handler({ command }, signal) } : {}),
    });
    observer.fn = trace.observeRetrieval;
    delegation.observer = trace.delegateObserver;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await watcher?.stop();
    ctx.close();
  };

  return {
    ctx, config, agent, plan, permissions, tools, sessionStore, sessionId, editLog,
    audit, watcher, memory, router, provider, model, trace, ledger, checkpoints, close,
  };
}

/**
 * The keyword-only warning, when one is warranted.
 *
 * Keyword-only by CHOICE (no embedding provider configured) is announced once
 * during config resolution and needs nothing more. Keyword-only because
 * sqlite-vec failed to load is a real degradation on this machine and says so.
 * Reporting the first as the second told every new user their install was
 * broken when it was working exactly as intended.
 */
export function keywordOnlyWarning(status: { searchMode: string; degradedKind?: string; degradedReason?: string }): string | null {
  if (status.searchMode !== "keyword-only" || status.degradedKind === "keyword_only") return null;
  return `⚠ sqlite-vec unavailable — keyword-only (BM25) search, no semantic ranking.${status.degradedReason ? ` ${status.degradedReason}` : ""}`;
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
