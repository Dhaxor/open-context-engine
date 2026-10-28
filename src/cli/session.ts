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
import type { ContextAgent, LLMProvider } from "../agent/agent";
import { checkReady, resolveProvider } from "../agent/presets";
import type { AgentPlan } from "../agent/plan";
import type { PermissionManager } from "../agent/permissions";
import { SessionStore } from "../agent/session-store";
import { EditProposal, ToolDefinition } from "../agent/types";
import { FsEditApplier } from "../agent/edit-tools";
import { AuditLogger, defaultAuditDir } from "../core/audit";
import { policyRequiresAudit } from "../core/policy";
import { getLicense, isEntitled } from "../core/license";
import { loadFileConfig } from "./config-file";
import { Diagnostics } from "../core/diagnostics";
import type { ContextLedger } from "../trace/ledger";
import type { CheckpointStore } from "../trace/checkpoints";
import type { TraceSession } from "../trace/session";
import { assembleAgentStack, type AgentStack } from "../trace/stack";

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

  const editLog: EditProposal[] = [];

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

  // Sessions: every conversation persists; --continue / --resume restore one.
  const sessionStore = SessionStore.forWorkspace(config.workspaceRoot, config.storePath);
  let sessionId = sessionStore.newId();
  let saved: ReturnType<SessionStore["latest"]> = null;
  if (opts.continue || opts.resume) {
    saved = opts.resume ? sessionStore.load(String(opts.resume)) : sessionStore.latest();
    if (!saved && opts.resume) {
      fatal(`No session '${opts.resume}' — run /sessions in the REPL or check .open-context/sessions/.`);
    }
  }

  // Policy can strip capabilities the flags asked for — say so up front instead
  // of letting the agent discover missing tools mid-run.
  const policyBlocks: string[] = [];
  let stack: AgentStack;
  try {
    stack = assembleAgentStack({
      ctx,
      workspaceRoot: config.workspaceRoot,
      provider,
      model,
      apiKey: opts.apiKey,
      baseUrl: opts.llmBaseUrl,
      router,
      memory,
      memorySource: "cli-agent",
      audit,
      applier: new FsEditApplier(config.workspaceRoot),
      // Approvals: interactive sessions get edits+shell BEHIND the approval
      // flow (suggest mode asks per mutation); --print has no approver, so
      // tools stay opt-in via the explicit flags.
      mode: opts.fullAuto ? "full-auto" : opts.autoEdit ? "auto-edit" : interactive ? "suggest" : "full-auto",
      includeEdits: interactive ? true : !!opts.allowEdits,
      shell: interactive ? true : !!opts.allowShell,
      plan: opts.plan !== false,
      delegate: opts.delegate !== false,
      env: opts.env !== false,
      traced,
      onEdit: (e) => editLog.push(e),
      onPolicyBlock: (cap, reason) => policyBlocks.push(`${cap}: ${reason}`),
      sessionStore,
      sessionId: saved?.id ?? sessionId,
      ...(saved ? { restore: saved.session } : {}),
      meta: {
        ...(saved ? { title: saved.title } : {}),
        ...(opts.branch ? { branch: String(opts.branch) } : {}),
      },
      maxOutputLength: config.search?.maxOutputLength,
    });
  } catch (e: any) {
    if (!saved) throw e;
    return fatal(`Could not resume session: ${e?.message ?? e}`);
  }
  for (const b of policyBlocks) diag.progress(`⚠ policy: ${b}\n`);
  if (saved) {
    sessionId = saved.id;
    diag.progress(`Resumed session '${saved.title}' (${saved.turns} turns).\n`);
  }
  const { agent, plan, permissions, tools, trace, ledger, checkpoints } = stack;

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
