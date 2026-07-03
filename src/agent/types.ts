export type LLMProvider = "openai" | "anthropic" | "google" | "custom";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: any) => Promise<string>;
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

export interface StreamEvent {
  type: "text" | "tool_call" | "tool_result" | "step_start" | "step_end" | "error" | "edit_proposed" | "history_compacted" | "retry" | "model_selected";
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
  guidelinesProvider?: (query: string) => string | null;
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
}
