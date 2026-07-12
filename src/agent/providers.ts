import { AgentMessage, StreamEvent, TokenUsage, ToolCall, ToolDefinition } from "./types";

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "stop" | "tool_use" | "length" | "error";
  /** Provider-reported token usage for this call, when available. */
  usage?: TokenUsage;
}

export interface LLMCaller {
  call(messages: AgentMessage[], tools: ToolDefinition[], system: string, onStream?: (e: StreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse>;
}

function genId(): string {
  return "call_" + Math.random().toString(36).slice(2, 12);
}

export class OpenAICaller implements LLMCaller {
  constructor(private model: string, private apiKey: string, private baseUrl?: string, private maxTokens: number = 4096) {}

  async call(messages: AgentMessage[], tools: ToolDefinition[], system: string, onStream?: (e: StreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseUrl, maxRetries: 2 });
    const toolDefs = tools.map(t => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters as any } }));
    const oaiMessages: any[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") oaiMessages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        const msg: any = { role: "assistant", content: m.content || null };
        if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }));
        oaiMessages.push(msg);
      } else if (m.role === "tool") {
        oaiMessages.push({ role: "tool", tool_call_id: m.toolCallId!, content: m.content });
      }
    }
    const req: any = { model: this.model, messages: oaiMessages, tools: toolDefs.length ? toolDefs : undefined, stream: true, stream_options: { include_usage: true } };
    if (usesMaxCompletionTokens(this.model)) req.max_completion_tokens = this.maxTokens;
    else req.max_tokens = this.maxTokens;
    const stream = (await client.chat.completions.create(req, { signal })) as unknown as AsyncIterable<any>;
    let text = "";
    const toolAccum: Record<number, { id: string; name: string; args: string }> = {};
    let stopReason: LLMResponse["stopReason"] = "stop";
    let usage: TokenUsage | undefined;
    for await (const chunk of stream) {
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) { text += delta.content; onStream?.({ type: "text", text: delta.content }); }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = toolAccum[idx] ?? (toolAccum[idx] = { id: "", name: "", args: "" });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
      const finish = chunk.choices[0]?.finish_reason;
      if (finish === "tool_calls") stopReason = "tool_use";
      else if (finish === "length") stopReason = "length";
      else if (finish === "stop") stopReason = "stop";
    }
    const toolCalls: ToolCall[] = Object.values(toolAccum).map(a => ({ id: a.id || genId(), name: a.name, arguments: safeJson(a.args) }));
    return { text, toolCalls, stopReason, usage };
  }
}

export class AnthropicCaller implements LLMCaller {
  constructor(private model: string, private apiKey: string, private baseUrl: string = "https://api.anthropic.com", private maxTokens: number = 4096) {}

  async call(messages: AgentMessage[], tools: ToolDefinition[], system: string, onStream?: (e: StreamEvent) => void, signal?: AbortSignal): Promise<LLMResponse> {
    const anthropicMessages: any[] = [];
    for (const m of messages) {
      if (m.role === "user") anthropicMessages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        const blocks: any[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
        anthropicMessages.push({ role: "assistant", content: blocks });
      } else if (m.role === "tool") {
        const last = anthropicMessages[anthropicMessages.length - 1];
        const block = { type: "tool_result", tool_use_id: m.toolCallId!, content: m.content };
        if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
        else anthropicMessages.push({ role: "user", content: [block] });
      }
    }
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: anthropicMessages,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      stream: true,
    };
    const resp = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      const err: any = new Error(`Anthropic: ${resp.status} ${text.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    let text = "";
    const toolCalls: ToolCall[] = [];
    const activeTool: Record<number, { id: string; name: string; input: string }> = {};
    let stopReason: LLMResponse["stopReason"] = "stop";
    let inputTokens = 0;
    let outputTokens = 0;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let evt: any;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.type === "message_start" && evt.message?.usage) {
          inputTokens = evt.message.usage.input_tokens ?? 0;
          outputTokens = evt.message.usage.output_tokens ?? 0;
        } else if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
          activeTool[evt.index] = { id: evt.content_block.id, name: evt.content_block.name, input: "" };
        } else if (evt.type === "content_block_delta") {
          if (evt.delta?.type === "text_delta") { text += evt.delta.text; onStream?.({ type: "text", text: evt.delta.text }); }
          else if (evt.delta?.type === "input_json_delta" && activeTool[evt.index]) {
            activeTool[evt.index].input += evt.delta.partial_json;
          }
        } else if (evt.type === "content_block_stop" && activeTool[evt.index]) {
          const a = activeTool[evt.index];
          toolCalls.push({ id: a.id, name: a.name, arguments: safeJson(a.input) });
          delete activeTool[evt.index];
        } else if (evt.type === "message_delta") {
          if (evt.delta?.stop_reason) {
            const sr = evt.delta.stop_reason;
            stopReason = sr === "tool_use" ? "tool_use" : sr === "max_tokens" ? "length" : "stop";
          }
          if (evt.usage?.output_tokens != null) outputTokens = evt.usage.output_tokens;
        }
      }
    }
    const usage: TokenUsage | undefined = inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined;
    return { text, toolCalls, stopReason, usage };
  }
}

function safeJson(s: string): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

function usesMaxCompletionTokens(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4");
}
