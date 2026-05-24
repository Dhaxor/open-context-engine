import { OpenContext } from "../core/context";
import { RetrieveOptions } from "../core/retriever";
import { AgentConfig, AgentMessage, AgentRunOptions, LLMProvider, ToolDefinition } from "./types";
import { AnthropicCaller, LLMCaller, OpenAICaller } from "./providers";
import { compactHistory, truncateToolResult, withRetry } from "./utils";
import { editTools, EditApplier, FsEditApplier } from "./edit-tools";
import { shellTool, webSearchTool, ShellToolOptions, WebSearchOptions } from "./extra-tools";
import { StepBudget } from "./step-budget";

export { AgentConfig, AgentMessage, AgentRunOptions, LLMProvider, ToolCall, ToolDefinition, StreamEvent, EditProposal } from "./types";
export { EditApplier, FsEditApplier, editTools } from "./edit-tools";
export { shellTool, webSearchTool } from "./extra-tools";

const DEFAULT_SYSTEM_PROMPT = `You are an expert coding assistant with tools to search, read, run, and edit the user's codebase.
- Before answering a question about code, call codebase-retrieval at least once to ground your answer in real files.
- For broad questions (overview, architecture, "what does this codebase do"), issue multiple codebase-retrieval calls with different angles (entry points, top-level modules, domain models, tests) and synthesize across all results — do not rely on a single snippet.
- codebase-retrieval returns many ranked snippets across files; read them all before answering. Use list-files and read-file to fill in gaps.
- Use run-command for build/test/lint/git/shell work when available. Commands run non-interactively in the workspace; pass all input as flags and assume no human will respond.
- Use web-search when the answer depends on external docs, library references, or up-to-date facts not in the codebase.
- When making edits, use str-replace with enough surrounding context so the old_str is unique. Use create-file for new files and remove-file to delete.
- Cite file paths and line ranges when you reference code.
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
  ];
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
}

// Read-only by default: codebase retrieval + read tools only. File edits and
// shell execution are powerful and must be opted into explicitly, so embedding
// `defaultAgentTools({ context })` never silently grants write/exec access.
export function defaultAgentTools(opts: DefaultToolsOptions): ToolDefinition[] {
  let tools: ToolDefinition[] = defaultCodebaseTools(opts.context, opts.retrieveOptions);
  if (opts.includeEdits) {
    const applier = opts.applier ?? new FsEditApplier(opts.context.getWorkspaceRoot());
    tools = tools.concat(editTools({ context: opts.context, applier, onEdit: opts.onEdit }));
  }
  if (opts.shell) {
    const shellOpts = opts.shell === true ? {} : opts.shell;
    tools.push(shellTool({ ...shellOpts, workspaceRoot: opts.context.getWorkspaceRoot() }));
  }
  if (opts.webSearch) {
    tools.push(webSearchTool(opts.webSearch));
  }
  return tools;
}

export class ContextAgent {
  private caller: LLMCaller;
  private tools: Map<string, ToolDefinition> = new Map();
  private messages: AgentMessage[] = [];
  private system: string;
  private maxSteps: number;
  private historyTokenBudget: number;
  private maxToolResultChars: number;
  private maxRetries: number;
  private guidelinesProvider?: (query: string) => string | null;

  constructor(config: AgentConfig) {
    for (const t of config.tools) this.tools.set(t.name, t);
    this.system = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxSteps = config.maxSteps ?? 10;
    this.historyTokenBudget = config.historyTokenBudget ?? 120_000;
    this.maxToolResultChars = config.maxToolResultChars ?? 24_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.guidelinesProvider = config.guidelinesProvider;
    const apiKey = config.apiKey ?? envKey(config.provider);
    if (!apiKey) throw new Error(`Missing API key for provider ${config.provider}`);
    if (config.provider === "openai") this.caller = new OpenAICaller(config.model, apiKey, config.baseUrl, config.maxTokens ?? 4096);
    else if (config.provider === "anthropic") this.caller = new AnthropicCaller(config.model, apiKey, config.baseUrl, config.maxTokens ?? 4096);
    else throw new Error(`Provider ${config.provider} not yet supported`);
  }

  getMessages(): readonly AgentMessage[] { return this.messages; }
  reset(): void { this.messages = []; }
  addUserMessage(content: string): void { this.messages.push({ role: "user", content }); }
  loadMessages(messages: AgentMessage[]): void { this.messages = [...messages]; }

  async run(query: string, options: AgentRunOptions = {}): Promise<string> {
    this.messages.push({ role: "user", content: query });
    const budget = new StepBudget(query, {
      baseSimple: this.maxSteps,
      baseComplex: Math.min(this.maxSteps * 2, 25),
      maxBudget: 25,
    });
    let step = 0;
    while (budget.shouldContinue()) {
      options.onStream?.({ type: "step_start", step });
      this.compactIfNeeded(options);
      const systemWithGuidelines = this.buildSystemPrompt(query);
      const resp = await withRetry(
        () => this.caller.call(this.messages, [...this.tools.values()], systemWithGuidelines, options.onStream, options.signal),
        {
          maxRetries: this.maxRetries,
          signal: options.signal,
          onRetry: (attempt, delayMs, reason) => options.onStream?.({ type: "retry", retryAttempt: attempt, retryDelayMs: delayMs, retryReason: reason }),
        },
      );
      this.messages.push({
        role: "assistant",
        content: resp.text,
        toolCalls: resp.toolCalls.length ? resp.toolCalls : undefined,
      });
      if (!resp.toolCalls.length) {
        options.onStream?.({ type: "step_end", step });
        return resp.text;
      }
      let lastResultLength = 0;
      for (const tc of resp.toolCalls) {
        if (options.signal?.aborted) throw new Error("Aborted");
        if (budget.isLooping(tc.name, tc.arguments)) {
          const stored = "Loop detected: same tool called with identical arguments. Please try a different approach.";
          this.messages.push({ role: "tool", content: stored, toolCallId: tc.id, toolName: tc.name });
          options.onStream?.({ type: "tool_result", toolResult: { id: tc.id, name: tc.name, result: stored, error: true } });
          continue;
        }
        options.onStream?.({ type: "tool_call", toolCall: tc });
        const tool = this.tools.get(tc.name);
        let result: string;
        let isError = false;
        try {
          if (!tool) { result = `Error: unknown tool '${tc.name}'`; isError = true; }
          else result = await tool.handler(tc.arguments);
        } catch (err: any) {
          result = `Error: ${err?.message ?? String(err)}`;
          isError = true;
        }
        const stored = truncateToolResult(result, this.maxToolResultChars);
        lastResultLength = Math.max(lastResultLength, stored.length);
        this.messages.push({ role: "tool", content: stored, toolCallId: tc.id, toolName: tc.name });
        options.onStream?.({ type: "tool_result", toolResult: { id: tc.id, name: tc.name, result: stored, error: isError } });
      }
      if (budget.getRemaining() <= 1 && lastResultLength > 200) {
        budget.requestExtension(lastResultLength);
      }
      options.onStream?.({ type: "step_end", step });
      step++;
    }
    const tail = this.messages[this.messages.length - 1];
    return tail?.role === "assistant" ? tail.content : "Agent exceeded step budget without a final answer.";
  }

  private buildSystemPrompt(query: string): string {
    if (!this.guidelinesProvider) return this.system;
    const guidelines = this.guidelinesProvider(query);
    if (!guidelines) return this.system;
    return `${this.system}\n\n## Project Guidelines\n${guidelines}`;
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
