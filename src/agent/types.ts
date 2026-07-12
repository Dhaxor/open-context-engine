export type LLMProvider = "openai" | "anthropic" | "google" | "custom";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Handler receives the parsed arguments and (optionally) the run's abort
   *  signal — long-running tools should observe it. */
  handler: (args: any, signal?: AbortSignal) => Promise<string>;
  /** Marks tools with side effects (file edits, shell). Mutating tools run
   *  strictly in call order; read-only tools from one assistant turn run
   *  concurrently. Default: false (read-only). */
  mutates?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RunStats {
  /** Reasoning steps taken (assistant turns). */
  steps: number;
  /** LLM API calls made (≥ steps when retries happened). */
  llmCalls: number;
  /** Tool invocations executed. */
  toolCalls: number;
  /** Tool invocations that returned an error. */
  toolErrors: number;
  usage: TokenUsage;
  durationMs: number;
}

export interface StreamEvent {
  type: "text" | "tool_call" | "tool_result" | "step_start" | "step_end" | "error" | "edit_proposed" | "history_compacted" | "retry" | "model_selected" | "usage" | "run_end";
  text?: string;
  toolCall?: ToolCall;
  toolResult?: { id: string; name: string; result: string; error?: boolean };
  step?: number;
  error?: string;
  edit?: EditProposal;
  retryAttempt?: number;
  retryDelayMs?: number;
  retryReason?: string;
  droppedMessages?: number;
  /** Emitted once per run when a ModelRouter picked the tier for this query. */
  tier?: { name: string; provider: string; model: string };
  /** Emitted after each LLM call that reported token usage. */
  usage?: TokenUsage;
  /** Emitted once per run() just before it returns. */
  stats?: RunStats;
}

export interface EditProposal {
  id: string;
  kind: "str-replace" | "create" | "remove";
  path: string;
  oldContents?: string;
  newContents?: string;
  diff: string;
  replacedOccurrences?: number;
}

export interface AgentRunOptions {
  onStream?: (event: StreamEvent) => void;
  signal?: AbortSignal;
}

/** Decision returned by a preToolCall hook. */
export type PreToolCallDecision =
  | { behavior: "allow"; arguments?: Record<string, any> }
  | { behavior: "deny"; reason: string };

export interface AgentHooks {
  /** Runs before every tool call. Return deny to block (the model sees the
   *  reason as the tool result) or allow with replacement arguments. */
  preToolCall?: (call: ToolCall) => PreToolCallDecision | Promise<PreToolCallDecision>;
  /** Runs after every tool call. A returned string REPLACES the stored result
   *  (e.g. redaction); return nothing to keep it. */
  postToolCall?: (call: ToolCall, result: string, isError: boolean) => string | void | Promise<string | void>;
}

export interface AgentConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  systemPrompt?: string;
  maxSteps?: number;
  maxTokens?: number;
  tools: ToolDefinition[];
  historyTokenBudget?: number;
  maxToolResultChars?: number;
  maxRetries?: number;
  /** Max read-only tool calls executed concurrently within one step. Default 4. */
  maxParallelTools?: number;
  guidelinesProvider?: (query: string) => string | null;
  hooks?: AgentHooks;
  /** Route each query to a cost-appropriate model tier (fast/standard/
   *  reasoning). When set, provider/model act as a fallback only and each
   *  run() picks its caller via the router. Inline import type — no cycle. */
  router?: import("./model-router").ModelRouter;
  /** Persistent cross-session memory. When set, relevant remembered facts are
   *  injected into the system prompt per query and new codebase insights are
   *  extracted from final answers. */
  memory?: import("./session-memory").SessionMemory;
  /** Label recorded as the source of extracted memories (default "agent"). */
  memorySource?: string;
  /** Tamper-evident audit logger. When set, run starts/ends and every tool
   *  call are appended to the audit log. Inline import type — no cycle. */
  audit?: import("../core/audit").AuditLogger;
}
