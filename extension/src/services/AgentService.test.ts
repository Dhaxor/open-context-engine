import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

let runImpl: any;
const constructed: any[] = [];
vi.mock("../../../src/agent/agent", () => ({
  defaultAgentTools: vi.fn((opts) => [{ name: "tool", opts }]),
  ContextAgent: class { constructor(public opts: any) { constructed.push(opts); } run = vi.fn(async (q, opts) => runImpl?.(q, opts)); reset = vi.fn(); },
}));
vi.mock("./ContextService", () => ({ ContextService: { getInstance: () => ({ getLLMApiKey: async () => "key", getWebSearchApiKey: async () => "web", getContext: async () => ({ getWorkspaceRoot: () => "/tmp/root", getPolicy: () => undefined }), getIdeRetrieveOptionsForCurrentContext: async () => ({}) }) } }));
vi.mock("../../../src/agent/session-memory", () => ({ SessionMemory: class { clearAll() { return 3; } } }));
vi.mock("../../../src/agent/model-router", () => ({ ModelRouter: class { constructor(public c: any) {} }, defaultRoutingConfig: (provider: string, cfg: any) => ({ provider, ...cfg }) }));
vi.mock("../../../src/core/license", () => ({ getLicense: () => ({}), isEntitled: () => false }));
vi.mock("../../../src/core/policy", () => ({ policyRequiresAudit: () => false }));
vi.mock("../../../src/core/audit", () => ({ AuditLogger: class {}, defaultAuditDir: (r: string) => r + "/audit" }));

import { AgentService } from "./AgentService";

beforeEach(() => { constructed.length = 0; runImpl = undefined; vscode.workspace._config = new Map([["llm.provider", "openai"], ["llm.model", "gpt-test"], ["agent.memory.enabled", false]]); });

describe("AgentService", () => {
  it("translates agent stream events to UI callbacks", async () => {
    runImpl = async (_q: string, opts: any) => {
      opts.onStream({ type: "text", text: "hello" });
      opts.onStream({ type: "tool_call", toolCall: { id: "t1", name: "codebase-retrieval", arguments: { query: "x" } } });
      opts.onStream({ type: "tool_result", toolResult: { id: "t1", name: "codebase-retrieval", result: "src/a.ts:1-2\ntext" } });
      opts.onStream({ type: "retry", retryAttempt: 2, retryDelayMs: 10, retryReason: "rate" });
      opts.onStream({ type: "model_selected", tier: { name: "fast", provider: "openai", model: "g" } });
    };
    const calls: any = { text: "", tools: [], sources: [], done: 0, retry: null, model: null };
    await new AgentService().run("q", { onText: (d) => calls.text += d, onToolCall: (i) => calls.tools.push(i), onSources: (f) => calls.sources = f, onRetry: (r) => calls.retry = r, onModelSelected: (m) => calls.model = m, onDone: () => calls.done++, onError: (e) => { throw e; } });
    expect(calls.text).toBe("hello"); expect(calls.tools.map((t: any) => t.status)).toEqual(["running", "complete"]); expect(calls.sources[0]).toEqual({ path: "src/a.ts", lines: "1-2" }); expect(calls.done).toBe(1);
  });
  it("reuses the cached agent for equivalent provider config", async () => {
    const svc = new AgentService(); const events: any = { onText() {}, onToolCall() {}, onDone() {}, onError(e: Error) { throw e; } };
    await svc.run("one", events); await svc.run("two", events);
    expect(constructed).toHaveLength(1);
  });
});
