import { describe, it, expect } from "vitest";
import { ContextAgent } from "./agent";
import { AgentHooks, StreamEvent, ToolDefinition } from "./types";
import { LLMCaller, LLMResponse } from "./providers";

/** Scripted caller: returns queued responses in order. */
function scriptedCaller(responses: LLMResponse[]): LLMCaller {
  const queue = [...responses];
  return {
    call: async (): Promise<LLMResponse> => {
      const next = queue.shift();
      if (!next) throw new Error("scripted caller exhausted");
      return next;
    },
  };
}

function agentWith(caller: LLMCaller, tools: ToolDefinition[], extra: Partial<ConstructorParameters<typeof ContextAgent>[0]> = {}): ContextAgent {
  const router = {
    getCallerForQuery: () => ({ caller, tier: { name: "standard", provider: "custom", model: "scripted" } }),
  } as any;
  return new ContextAgent({ provider: "custom", model: "scripted", tools, router, ...extra });
}

function toolCallsResponse(calls: { id: string; name: string; arguments?: Record<string, any> }[]): LLMResponse {
  return { text: "", toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} })), stopReason: "tool_use" };
}

const finalResponse = (text = "done"): LLMResponse => ({ text, toolCalls: [], stopReason: "stop" });

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/** Tool that tracks concurrent executions. */
function trackingTool(name: string, tracker: { active: number; maxActive: number; order: string[] }, opts: { delayMs?: number; mutates?: boolean } = {}): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    mutates: opts.mutates,
    handler: async () => {
      tracker.order.push(`${name}:start`);
      tracker.active++;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      await sleep(opts.delayMs ?? 40);
      tracker.active--;
      tracker.order.push(`${name}:end`);
      return `${name}-result`;
    },
  };
}

describe("parallel tool execution", () => {
  it("runs an all-read-only batch concurrently", async () => {
    const tracker = { active: 0, maxActive: 0, order: [] as string[] };
    const tools = ["a", "b", "c"].map(n => trackingTool(n, tracker));
    const agent = agentWith(scriptedCaller([
      toolCallsResponse([{ id: "1", name: "a" }, { id: "2", name: "b" }, { id: "3", name: "c" }]),
      finalResponse(),
    ]), tools);
    const started = Date.now();
    await agent.run("q");
    expect(tracker.maxActive).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(3 * 40 + 60); // ≪ sequential 120ms + overhead
  });

  it("keeps the whole batch sequential when any call mutates", async () => {
    const tracker = { active: 0, maxActive: 0, order: [] as string[] };
    const tools = [
      trackingTool("read1", tracker, { delayMs: 15 }),
      trackingTool("edit", tracker, { delayMs: 15, mutates: true }),
      trackingTool("read2", tracker, { delayMs: 15 }),
    ];
    const agent = agentWith(scriptedCaller([
      toolCallsResponse([{ id: "1", name: "read1" }, { id: "2", name: "edit" }, { id: "3", name: "read2" }]),
      finalResponse(),
    ]), tools);
    await agent.run("q");
    expect(tracker.maxActive).toBe(1);
    expect(tracker.order).toEqual(["read1:start", "read1:end", "edit:start", "edit:end", "read2:start", "read2:end"]);
  });

  it("stores tool results in call order even when parallel finishes out of order", async () => {
    const tracker = { active: 0, maxActive: 0, order: [] as string[] };
    const tools = [
      trackingTool("slow", tracker, { delayMs: 60 }),
      trackingTool("fast", tracker, { delayMs: 5 }),
    ];
    const agent = agentWith(scriptedCaller([
      toolCallsResponse([{ id: "1", name: "slow" }, { id: "2", name: "fast" }]),
      finalResponse(),
    ]), tools);
    await agent.run("q");
    const toolMessages = agent.getMessages().filter(m => m.role === "tool");
    expect(toolMessages.map(m => m.toolName)).toEqual(["slow", "fast"]);
    expect(toolMessages.map(m => m.content)).toEqual(["slow-result", "fast-result"]);
  });

  it("respects maxParallelTools as the concurrency ceiling", async () => {
    const tracker = { active: 0, maxActive: 0, order: [] as string[] };
    const tools = ["a", "b", "c", "d", "e"].map(n => trackingTool(n, tracker, { delayMs: 20 }));
    const agent = agentWith(scriptedCaller([
      toolCallsResponse(tools.map((t, i) => ({ id: String(i), name: t.name }))),
      finalResponse(),
    ]), tools, { maxParallelTools: 2 });
    await agent.run("q");
    expect(tracker.maxActive).toBeLessThanOrEqual(2);
    expect(tracker.maxActive).toBeGreaterThan(1);
  });
});

describe("hooks", () => {
  const echoTool: ToolDefinition = {
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { msg: { type: "string" } } },
    handler: async (args) => `echo:${args.msg}`,
  };

  it("preToolCall deny blocks execution and surfaces the reason", async () => {
    let executed = false;
    const tool: ToolDefinition = { ...echoTool, handler: async () => { executed = true; return "ran"; } };
    const hooks: AgentHooks = { preToolCall: () => ({ behavior: "deny", reason: "blocked by test" }) };
    const agent = agentWith(scriptedCaller([
      toolCallsResponse([{ id: "1", name: "echo", arguments: { msg: "hi" } }]),
      finalResponse(),
    ]), [tool], { hooks });
    await agent.run("q");
    expect(executed).toBe(false);
    const toolMsg = agent.getMessages().find(m => m.role === "tool");
    expect(toolMsg?.content).toContain("Denied by hook: blocked by test");
  });

  it("preToolCall can rewrite arguments", async () => {
    const hooks: AgentHooks = { preToolCall: (tc) => ({ behavior: "allow", arguments: { ...tc.arguments, msg: "rewritten" } }) };
    const agent = agentWith(scriptedCaller([
      toolCallsResponse([{ id: "1", name: "echo", arguments: { msg: "original" } }]),
      finalResponse(),
    ]), [echoTool], { hooks });
    await agent.run("q");
    expect(agent.getMessages().find(m => m.role === "tool")?.content).toBe("echo:rewritten");
  });

  it("postToolCall can replace the stored result (redaction)", async () => {
    const hooks: AgentHooks = { postToolCall: (_tc, result) => result.replace("hi", "[REDACTED]") };
    const agent = agentWith(scriptedCaller([
      toolCallsResponse([{ id: "1", name: "echo", arguments: { msg: "hi" } }]),
      finalResponse(),
    ]), [echoTool], { hooks });
    await agent.run("q");
    expect(agent.getMessages().find(m => m.role === "tool")?.content).toBe("echo:[REDACTED]");
  });
});

describe("usage accounting + run stats", () => {
  it("accumulates provider-reported usage and emits run_end stats", async () => {
    const caller = scriptedCaller([
      { ...toolCallsResponse([{ id: "1", name: "echo", arguments: { msg: "x" } }]), usage: { inputTokens: 100, outputTokens: 20 } },
      { ...finalResponse("answer"), usage: { inputTokens: 150, outputTokens: 30 } },
    ]);
    const echo: ToolDefinition = { name: "echo", description: "e", parameters: {}, handler: async (a) => `echo:${a.msg}` };
    const agent = agentWith(caller, [echo]);
    const events: StreamEvent[] = [];
    await agent.run("q", { onStream: (e) => events.push(e) });

    const stats = agent.getLastRunStats()!;
    expect(stats.usage).toEqual({ inputTokens: 250, outputTokens: 50 });
    expect(stats.steps).toBe(2);
    expect(stats.llmCalls).toBe(2);
    expect(stats.toolCalls).toBe(1);
    expect(stats.toolErrors).toBe(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);

    expect(events.filter(e => e.type === "usage")).toHaveLength(2);
    const runEnd = events.find(e => e.type === "run_end");
    expect(runEnd?.stats?.usage.inputTokens).toBe(250);
  });

  it("sums usage across runs in getTotalUsage", async () => {
    const caller = scriptedCaller([
      { ...finalResponse("one"), usage: { inputTokens: 10, outputTokens: 1 } },
      { ...finalResponse("two"), usage: { inputTokens: 20, outputTokens: 2 } },
    ]);
    const agent = agentWith(caller, []);
    await agent.run("a");
    await agent.run("b");
    expect(agent.getTotalUsage()).toEqual({ inputTokens: 30, outputTokens: 3 });
  });

  it("counts tool errors", async () => {
    const bad: ToolDefinition = { name: "bad", description: "b", parameters: {}, handler: async () => { throw new Error("boom"); } };
    const agent = agentWith(scriptedCaller([
      toolCallsResponse([{ id: "1", name: "bad" }]),
      finalResponse(),
    ]), [bad]);
    await agent.run("q");
    expect(agent.getLastRunStats()?.toolErrors).toBe(1);
  });
});

describe("session persistence", () => {
  it("round-trips messages and usage through export/import", async () => {
    const agent = agentWith(scriptedCaller([{ ...finalResponse("hello"), usage: { inputTokens: 5, outputTokens: 7 } }]), []);
    await agent.run("hi");
    const exported = agent.exportSession();

    const restored = agentWith(scriptedCaller([finalResponse("again")]), []);
    restored.importSession(exported);
    expect(restored.getMessages()).toEqual(agent.getMessages());
    expect(restored.getTotalUsage()).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  it("rejects unknown formats", () => {
    const agent = agentWith(scriptedCaller([]), []);
    expect(() => agent.importSession("{}")).toThrow(/Unrecognized session format/);
  });
});

describe("cancellation", () => {
  it("passes the run signal into tool handlers", async () => {
    let received: AbortSignal | undefined;
    const tool: ToolDefinition = { name: "t", description: "t", parameters: {}, handler: async (_a, signal) => { received = signal; return "ok"; } };
    const controller = new AbortController();
    const agent = agentWith(scriptedCaller([
      toolCallsResponse([{ id: "1", name: "t" }]),
      finalResponse(),
    ]), [tool]);
    await agent.run("q", { signal: controller.signal });
    expect(received).toBe(controller.signal);
  });
});
