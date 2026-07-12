import { OpenContext } from "../core/context";
import { RetrieveOptions } from "../core/retriever";
import { AgentConfig, AgentHooks, AgentMessage, AgentRunOptions, LLMProvider, RunStats, TokenUsage, ToolCall, ToolDefinition } from "./types";
import { AnthropicCaller, LLMCaller, OpenAICaller } from "./providers";
import { compactHistory, truncateToolResult, withRetry } from "./utils";
import { editTools, EditApplier, FsEditApplier } from "./edit-tools";
import { shellTool, webSearchTool, ShellToolOptions, WebSearchOptions } from "./extra-tools";
import { StepBudget } from "./step-budget";
import { EffectivePolicy, policyAllowsEdits, policyAllowsShell, policyAllowsWebSearch, policyShellAllowlist } from "../core/policy";
import { AuditLogger } from "../core/audit";

export { AgentConfig, AgentHooks, AgentMessage, AgentRunOptions, LLMProvider, PreToolCallDecision, RunStats, TokenUsage, ToolCall, ToolDefinition, StreamEvent, EditProposal } from "./types";
export { EditApplier, FsEditApplier, editTools } from "./edit-tools";
export { shellTool, webSearchTool } from "./extra-tools";

const DEFAULT_SYSTEM_PROMPT = `You are an expert coding assistant with tools to search, read, run, and edit the user's codebase.
- Before answering a question about code, call codebase-retrieval at least once to ground your answer in real files.
- For broad questions (overview, architecture, "what does this codebase do"), issue multiple codebase-retrieval calls with different angles (entry points, top-level modules, domain models, tests) and synthesize across all results — do not rely on a single snippet.
- codebase-retrieval returns many ranked snippets across files; read them all before answering. Use list-files and read-file to fill in gaps.
- When you already know an exact symbol name, prefer find-symbol-definition (where it's declared) and find-symbol-references (every usage) over codebase-retrieval — they are precise, instant, and don't burn ranking budget.
- Use run-command for build/test/lint/git/shell work when available. Commands run non-interactively in the workspace; pass all input as flags and assume no human will respond.
- Use web-search when the answer depends on external docs, library references, or up-to-date facts not in the codebase.
- When making edits, use str-replace with enough surrounding context so the old_str is unique. Use create-file for new files and remove-file to delete.
- Cite file paths and line ranges when you reference code.
- When your answer is about specific code, SHOW it: include the relevant excerpt as a fenced code block tagged with the language AND the file path (e.g. \`\`\`ts src/core/retriever.ts), not just a prose description. The reader sees tool results collapsed, so quote the lines that matter directly in your answer. Keep excerpts focused — the lines under discussion, not whole files.
- Do not fabricate file paths or symbols — verify them with the tools first.`;

export function defaultCodebaseTools(context: OpenContext, retrieveOptions?: () => RetrieveOptions | Promise<RetrieveOptions>): ToolDefinition[] {
  return [
    {
      name: "codebase-retrieval",
      description: "Semantic + keyword search over the indexed workspace. Returns up to ~15 ranked snippets across multiple files with file paths and line ranges. Call this whenever you need to ground an answer in the codebase; it is cheap to invoke multiple times with different queries.",
      parameters: {
        type: "object",
        properties: {
          information_request: { type: "string", description: "A detailed natural-language description of what you are looking for. Be specific about files, symbols, or concepts." },
        },
        required: ["information_request"],
      },
      handler: async (args) => context.search(args.information_request, undefined, await retrieveOptions?.()),
    },
    {
      name: "list-files",
      description: "List indexed files, optionally filtered by directory prefix and/or glob pattern.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Optional directory prefix (relative to workspace root)." },
          pattern: { type: "string", description: "Optional glob pattern, e.g. '**/*.ts'." },
        },
      },
      handler: async (args) => (await context.listFiles(args.directory, args.pattern)).join("\n") || "(no matching files)",
    },
    {
      name: "read-file",
      description: "Read an indexed file. start_line / end_line are 1-based and inclusive.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "number" },
          end_line: { type: "number" },
        },
        required: ["path"],
      },
      handler: async (args) => (await context.readFile(args.path, args.start_line, args.end_line)) ?? `Not found: ${args.path}`,
    },
    {
      name: "find-symbol-definition",
      description:
        "Find where a symbol (function, class, method, type) is DEFINED, by exact name. Precise and instant — prefer this over codebase-retrieval when you already know the exact identifier. Returns the defining chunk(s) with file path, line range, and source.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Exact symbol name, e.g. 'HybridRetriever' or 'reciprocalRankFusion'. Case-sensitive." },
        },
        required: ["symbol"],
      },
      handler: async (args) => {
        const symbol = String(args.symbol ?? "").trim();
        if (!symbol) return "No symbol given.";
        const defs = context.findSymbolDefinitions(symbol, 5);
        if (!defs.length) {
          return `No definition found for '${symbol}'. The name must match the declared identifier exactly (case-sensitive) — try codebase-retrieval for fuzzy/conceptual lookup, or find-symbol-references to locate usages.`;
        }
        return defs.map(c => renderDefinition(c)).join("\n\n");
      },
    },
    {
      name: "find-symbol-references",
      description:
        "Find every indexed place a symbol/identifier is USED (exact word-boundary match, case-sensitive). Use to trace callers, check impact of a change, or find usage examples. Returns matching lines with file:line locations.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Exact identifier to look up, e.g. 'vectorSearch'." },
          path: { type: "string", description: "Optional: restrict to one indexed file path." },
        },
        required: ["symbol"],
      },
      handler: async (args) => {
        const symbol = String(args.symbol ?? "").trim();
        if (!symbol) return "No symbol given.";
        const refs = context.findSymbolReferences(symbol, args.path ? String(args.path) : undefined, 12);
        if (!refs.length) return `No references to '${symbol}' found${args.path ? ` in ${args.path}` : ""} (exact, case-sensitive match).`;
        return refs.map(c => renderReference(c, symbol)).join("\n");
      },
    },
  ];
}

const SNIPPET_MAX_LINES = 40;

// Exported for the MCP server, which surfaces the same symbol tools.
export function renderDefinition(c: import("../core/types").Chunk): string {
  const kind = c.symbolKind ? `${c.symbolKind} ` : "";
  const parent = c.parentSymbol ? ` (in ${c.parentSymbol})` : "";
  const lines = c.contents.split("\n");
  const body = lines.length > SNIPPET_MAX_LINES
    ? lines.slice(0, SNIPPET_MAX_LINES).join("\n") + `\n… (${lines.length - SNIPPET_MAX_LINES} more lines — read-file for the rest)`
    : c.contents;
  return `${kind}${c.symbolName ?? "?"}${parent} — ${c.path}:${c.startLine}-${c.endLine}\n\`\`\`${c.language ?? ""}\n${body}\n\`\`\``;
}

export function renderReference(c: import("../core/types").Chunk, symbol: string): string {
  // Show the exact matching lines with absolute line numbers, not the whole
  // chunk — references are about WHERE, the agent can read-file for context.
  const re = new RegExp(`(^|[^A-Za-z0-9_])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`);
  const hits: string[] = [];
  const lines = c.contents.split("\n");
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    if (re.test(lines[i])) hits.push(`  ${c.path}:${c.startLine + i}: ${lines[i].trim().slice(0, 160)}`);
  }
  const where = c.symbolName ? ` (${c.symbolKind ?? "symbol"} ${c.symbolName})` : "";
  const header = `${c.path}:${c.startLine}-${c.endLine}${where}${c.symbolName === symbol ? " [definition]" : ""}`;
  return hits.length ? `${header}\n${hits.join("\n")}` : header;
}

export interface DefaultToolsOptions {
  context: OpenContext;
  applier?: EditApplier;
  /** Include file-editing tools (str-replace/create-file/remove-file). Default: false. */
  includeEdits?: boolean;
  onEdit?: (edit: import("./types").EditProposal) => void;
  /** Enable the shell `run-command` tool. Pass `true` or options to enable. Default: off. */
  shell?: Omit<ShellToolOptions, "workspaceRoot"> | boolean;
  webSearch?: WebSearchOptions | false;
  retrieveOptions?: () => RetrieveOptions | Promise<RetrieveOptions>;
  /** Policy to enforce. Default: the policy the OpenContext loaded for the
   *  workspace. Pass `false` to skip (tests / embedders that enforce upstream). */
  policy?: EffectivePolicy | false;
  /** When set, records which capabilities the policy stripped (for surfacing to the user). */
  onPolicyBlock?: (capability: "edits" | "shell" | "web-search", reason: string) => void;
}

// Read-only by default: codebase retrieval + read tools only. File edits and
// shell execution are powerful and must be opted into explicitly, so embedding
// `defaultAgentTools({ context })` never silently grants write/exec access.
// A workspace/org policy is enforced on top: it can strip edits/shell/web
// search and pin the shell allowlist, and opts cannot loosen it.
export function defaultAgentTools(opts: DefaultToolsOptions): ToolDefinition[] {
  // `getPolicy?.` — embedders (and tests) may pass a duck-typed context.
  const policy = opts.policy === false ? undefined : opts.policy ?? opts.context.getPolicy?.() ?? undefined;
  let tools: ToolDefinition[] = defaultCodebaseTools(opts.context, opts.retrieveOptions);
  if (opts.includeEdits) {
    if (!policyAllowsEdits(policy)) {
      opts.onPolicyBlock?.("edits", "file-editing tools are disabled by policy");
    } else {
      const applier = opts.applier ?? new FsEditApplier(opts.context.getWorkspaceRoot());
      tools = tools.concat(editTools({ context: opts.context, applier, onEdit: opts.onEdit }));
    }
  }
  if (opts.shell) {
    if (!policyAllowsShell(policy)) {
      opts.onPolicyBlock?.("shell", "the run-command tool is disabled by policy");
    } else {
      const shellOpts = opts.shell === true ? {} : { ...opts.shell };
      const allowlist = policyShellAllowlist(policy, shellOpts.allowlist ?? []);
      const maxTimeout = policy?.agent?.shell?.maxTimeoutMs;
      tools.push(shellTool({
        ...shellOpts,
        ...(allowlist.length || policy?.agent?.shell?.allowlist ? { allowlist } : {}),
        ...(maxTimeout ? { timeoutMs: Math.min(shellOpts.timeoutMs ?? maxTimeout, maxTimeout) } : {}),
        workspaceRoot: opts.context.getWorkspaceRoot(),
      }));
    }
  }
  if (opts.webSearch) {
    if (!policyAllowsWebSearch(policy)) {
      opts.onPolicyBlock?.("web-search", "the web-search tool is disabled by policy");
    } else {
      tools.push(webSearchTool(opts.webSearch));
    }
  }
  return tools;
}

export class ContextAgent {
  private caller: LLMCaller | null = null;
  private tools: Map<string, ToolDefinition> = new Map();
  private messages: AgentMessage[] = [];
  private system: string;
  private maxSteps: number;
  private historyTokenBudget: number;
  private maxToolResultChars: number;
  private maxRetries: number;
  private guidelinesProvider?: (query: string) => string | null;
  private router?: import("./model-router").ModelRouter;
  private memory?: import("./session-memory").SessionMemory;
  private memorySource: string;
  private audit?: AuditLogger;
  private hooks?: AgentHooks;
  private maxParallelTools: number;
  private lastRunStats: RunStats | null = null;
  private totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(config: AgentConfig) {
    for (const t of config.tools) this.tools.set(t.name, t);
    this.system = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = config.maxSteps ?? 10;
    this.historyTokenBudget = config.historyTokenBudget ?? 120_000;
    this.maxToolResultChars = config.maxToolResultChars ?? 24_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.maxParallelTools = Math.max(1, config.maxParallelTools ?? 4);
    this.guidelinesProvider = config.guidelinesProvider;
    this.hooks = config.hooks;
    this.router = config.router;
    this.memory = config.memory;
    this.memorySource = config.memorySource ?? "agent";
    this.audit = config.audit;
    if (!this.router) {
      // No router: a single fixed caller is built up front, as before. With a
      // router, callers are created lazily per tier inside the router itself.
      const apiKey = config.apiKey ?? envKey(config.provider);
      if (!apiKey) throw new Error(`Missing API key for provider ${config.provider}`);
      if (config.provider === "openai" || config.provider === "custom") this.caller = new OpenAICaller(config.model, apiKey, config.baseUrl, config.maxTokens ?? 4096);
      else if (config.provider === "anthropic") this.caller = new AnthropicCaller(config.model, apiKey, config.baseUrl, config.maxTokens ?? 4096);
      else throw new Error(`Provider ${config.provider} not yet supported`);
    }
  }

  getMessages(): readonly AgentMessage[] { return this.messages; }
  reset(): void { this.messages = []; }
  addUserMessage(content: string): void { this.messages.push({ role: "user", content }); }
  loadMessages(messages: AgentMessage[]): void { this.messages = [...messages]; }

  /** Stats for the most recent run() (null before the first run). */
  getLastRunStats(): RunStats | null { return this.lastRunStats; }
  /** Token usage accumulated across every run of this agent instance. */
  getTotalUsage(): TokenUsage { return { ...this.totalUsage }; }

  /** Serialize the conversation (and usage totals) for persistence. */
  exportSession(): string {
    return JSON.stringify({ version: 1, messages: this.messages, totalUsage: this.totalUsage });
  }

  /** Restore a session produced by exportSession(). Throws on malformed input. */
  importSession(serialized: string): void {
    const parsed = JSON.parse(serialized);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.messages)) {
      throw new Error("Unrecognized session format (expected exportSession() output, version 1).");
    }
    this.messages = parsed.messages;
    if (parsed.totalUsage) this.totalUsage = { inputTokens: parsed.totalUsage.inputTokens ?? 0, outputTokens: parsed.totalUsage.outputTokens ?? 0 };
  }

  async run(query: string, options: AgentRunOptions = {}): Promise<string> {
    // Pick the caller once per run: routed by query complexity when a router
    // is configured, the fixed caller otherwise. Routing happens BEFORE the
    // user message is appended so conversation depth reflects prior turns.
    let caller: LLMCaller;
    if (this.router) {
      const routed = this.router.getCallerForQuery(query, this.messages);
      caller = routed.caller;
      options.onStream?.({ type: "model_selected", tier: { name: routed.tier.name, provider: routed.tier.provider, model: routed.tier.model } });
    } else {
      caller = this.caller!;
    }
    this.messages.push({ role: "user", content: query });
    this.audit?.log("run-start", { query });
    const budget = new StepBudget(query, {
      baseSimple: this.maxSteps,
      baseComplex: Math.min(this.maxSteps * 2, 25),
      maxBudget: 25,
    });
    const startedAt = Date.now();
    const stats: RunStats = { steps: 0, llmCalls: 0, toolCalls: 0, toolErrors: 0, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 };
    const finishRun = (answer: string, exhausted = false): string => {
      stats.durationMs = Date.now() - startedAt;
      this.lastRunStats = stats;
      this.totalUsage.inputTokens += stats.usage.inputTokens;
      this.totalUsage.outputTokens += stats.usage.outputTokens;
      this.audit?.log("run-end", { steps: stats.steps, toolCalls: stats.toolCalls, inputTokens: stats.usage.inputTokens, outputTokens: stats.usage.outputTokens, ...(exhausted ? { exhaustedBudget: true } : { answerChars: answer.length }) });
      options.onStream?.({ type: "run_end", stats });
      return answer;
    };
    let step = 0;
    while (budget.shouldContinue()) {
      options.onStream?.({ type: "step_start", step });
      this.compactIfNeeded(options);
      const systemWithGuidelines = this.buildSystemPrompt(query);
      const resp = await withRetry(
        () => {
          stats.llmCalls++;
          return caller.call(this.messages, [...this.tools.values()], systemWithGuidelines, options.onStream, options.signal);
        },
        {
          maxRetries: this.maxRetries,
          signal: options.signal,
          onRetry: (attempt, delayMs, reason) => options.onStream?.({ type: "retry", retryAttempt: attempt, retryDelayMs: delayMs, retryReason: reason }),
        },
      );
      if (resp.usage) {
        stats.usage.inputTokens += resp.usage.inputTokens;
        stats.usage.outputTokens += resp.usage.outputTokens;
        options.onStream?.({ type: "usage", usage: resp.usage });
      }
      stats.steps = step + 1;
      this.messages.push({
        role: "assistant",
        content: resp.text,
        toolCalls: resp.toolCalls.length ? resp.toolCalls : undefined,
      });
      if (!resp.toolCalls.length) {
        options.onStream?.({ type: "step_end", step });
        // Final answer: harvest durable codebase insights into session memory.
        if (this.memory && resp.text) {
          try { this.memory.extractFacts(resp.text, this.memorySource); } catch {}
        }
        return finishRun(resp.text);
      }
      const outcomes = await this.executeToolCalls(resp.toolCalls, budget, options, stats);
      let lastResultLength = 0;
      for (const o of outcomes) {
        lastResultLength = Math.max(lastResultLength, o.result.length);
        this.messages.push({ role: "tool", content: o.result, toolCallId: o.call.id, toolName: o.call.name });
      }
      if (budget.getRemaining() <= 1 && lastResultLength > 200) {
        budget.requestExtension(lastResultLength);
      }
      options.onStream?.({ type: "step_end", step });
      step++;
    }
    const tail = this.messages[this.messages.length - 1];
    return finishRun(tail?.role === "assistant" ? tail.content : "Agent exceeded step budget without a final answer.", true);
  }

  /**
   * Execute one assistant turn's tool calls. Results come back in call order.
   * A batch that is entirely read-only (no `mutates` tool) fans out with
   * bounded concurrency; any mutating call forces the WHOLE batch sequential —
   * a read issued after an edit in the same turn must see the edit.
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    budget: StepBudget,
    options: AgentRunOptions,
    stats: RunStats,
  ): Promise<{ call: ToolCall; result: string; isError: boolean }[]> {
    const outcomes: { call: ToolCall; result: string; isError: boolean }[] = new Array(toolCalls.length);
    const runnable: number[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      // Loop detection stays sequential-order-sensitive: record every call.
      if (budget.isLooping(tc.name, tc.arguments)) {
        const stored = "Loop detected: same tool called with identical arguments. Please try a different approach.";
        outcomes[i] = { call: tc, result: stored, isError: true };
        options.onStream?.({ type: "tool_result", toolResult: { id: tc.id, name: tc.name, result: stored, error: true } });
        continue;
      }
      runnable.push(i);
    }
    const anyMutates = runnable.some(i => this.tools.get(toolCalls[i].name)?.mutates);
    if (anyMutates || runnable.length <= 1) {
      for (const i of runnable) {
        if (options.signal?.aborted) throw new Error("Aborted");
        outcomes[i] = await this.invokeTool(toolCalls[i], options, stats);
      }
    } else {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(this.maxParallelTools, runnable.length) }, async () => {
        while (cursor < runnable.length) {
          if (options.signal?.aborted) throw new Error("Aborted");
          const i = runnable[cursor++];
          outcomes[i] = await this.invokeTool(toolCalls[i], options, stats);
        }
      });
      await Promise.all(workers);
    }
    return outcomes;
  }

  private async invokeTool(tc: ToolCall, options: AgentRunOptions, stats: RunStats): Promise<{ call: ToolCall; result: string; isError: boolean }> {
    options.onStream?.({ type: "tool_call", toolCall: tc });
    stats.toolCalls++;
    const tool = this.tools.get(tc.name);
    let result: string;
    let isError = false;
    let args = tc.arguments;
    try {
      if (!tool) {
        result = `Error: unknown tool '${tc.name}'`;
        isError = true;
      } else {
        const decision = await this.hooks?.preToolCall?.(tc);
        if (decision?.behavior === "deny") {
          result = `Denied by hook: ${decision.reason}`;
          isError = true;
        } else {
          if (decision?.behavior === "allow" && decision.arguments) args = decision.arguments;
          result = await tool.handler(args, options.signal);
        }
      }
    } catch (err: any) {
      result = `Error: ${err?.message ?? String(err)}`;
      isError = true;
    }
    try {
      const replaced = await this.hooks?.postToolCall?.(tc, result, isError);
      if (typeof replaced === "string") result = replaced;
    } catch {}
    if (isError) stats.toolErrors++;
    const stored = truncateToolResult(result, this.maxToolResultChars);
    this.audit?.log("tool-call", { name: tc.name, arguments: JSON.stringify(args), resultChars: stored.length, ...(isError ? { error: true } : {}) });
    options.onStream?.({ type: "tool_result", toolResult: { id: tc.id, name: tc.name, result: stored, error: isError } });
    return { call: tc, result: stored, isError };
  }

  private buildSystemPrompt(query: string): string {
    let prompt = this.system;
    const guidelines = this.guidelinesProvider?.(query);
    if (guidelines) prompt += `\n\n## Project Guidelines\n${guidelines}`;
    if (this.memory) {
      try {
        // formatForSystemPrompt returns "" when nothing relevant is remembered.
        const remembered = this.memory.formatForSystemPrompt(query);
        if (remembered) prompt += `\n\n${remembered}`;
      } catch {}
    }
    return prompt;
  }

  private compactIfNeeded(options: AgentRunOptions): void {
    const { messages, droppedCount } = compactHistory(this.messages, this.historyTokenBudget);
    if (droppedCount > 0) {
      this.messages = messages;
      options.onStream?.({ type: "history_compacted", droppedMessages: droppedCount });
    }
  }
}

function envKey(provider: LLMProvider): string {
  if (provider === "openai") return process.env.OPENAI_API_KEY ?? "";
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY ?? "";
  if (provider === "google") return process.env.GOOGLE_API_KEY ?? "";
  return "";
}
