import { describe, it, expect, afterEach, vi } from "vitest";
import { GoogleCaller, contextWindowFor } from "./providers";
import { ContextAgent } from "./agent";
import { AgentMessage } from "./types";

/** SSE body builder for mocked Gemini responses. */
function sse(events: unknown[]): Response {
  const body = events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GoogleCaller", () => {
  it("streams text, collects function calls, and reports usage", async () => {
    let captured: any;
    vi.stubGlobal("fetch", async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return sse([
        { candidates: [{ content: { parts: [{ text: "Looking" }] } }] },
        { candidates: [{ content: { parts: [{ text: " it up." }, { functionCall: { name: "codebase-retrieval", args: { information_request: "auth" } } }] } }] },
        { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 15 } },
      ]);
    });

    const caller = new GoogleCaller("gemini-3-flash", "gk");
    const chunks: string[] = [];
    const resp = await caller.call(
      [{ role: "user", content: "how does auth work?" }],
      [{ name: "codebase-retrieval", description: "search", parameters: { type: "object", properties: {} }, handler: async () => "" }],
      "system prompt here",
      (e) => { if (e.type === "text" && e.text) chunks.push(e.text); },
    );

    expect(resp.text).toBe("Looking it up.");
    expect(chunks.join("")).toBe("Looking it up.");
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0].name).toBe("codebase-retrieval");
    expect(resp.toolCalls[0].arguments).toEqual({ information_request: "auth" });
    expect(resp.toolCalls[0].id).toBeTruthy();
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.usage).toEqual({ inputTokens: 120, outputTokens: 15 });

    // Request shape: model in URL, key in header path, system instruction + tools present.
    expect(captured.url).toContain("/models/gemini-3-flash:streamGenerateContent");
    expect(captured.body.systemInstruction.parts[0].text).toBe("system prompt here");
    expect(captured.body.tools[0].functionDeclarations[0].name).toBe("codebase-retrieval");
  });

  it("round-trips tool results as functionResponse keyed by NAME", async () => {
    let captured: any;
    vi.stubGlobal("fetch", async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return sse([{ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }]);
    });
    const history: AgentMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_x", name: "read-file", arguments: { path: "a.ts" } }] },
      { role: "tool", content: "file body", toolCallId: "call_x", toolName: "read-file" },
    ];
    await new GoogleCaller("gemini-3-flash", "gk").call(history, [], "s");
    const roles = captured.contents.map((c: any) => c.role);
    expect(roles).toEqual(["user", "model", "user"]);
    expect(captured.contents[1].parts[0].functionCall.name).toBe("read-file");
    expect(captured.contents[2].parts[0].functionResponse).toEqual({ name: "read-file", response: { result: "file body" } });
  });

  it("throws a status-carrying error on HTTP failure (retry classification)", async () => {
    vi.stubGlobal("fetch", async () => new Response("quota", { status: 429 }));
    await expect(new GoogleCaller("gemini-3-flash", "gk").call([{ role: "user", content: "q" }], [], "s"))
      .rejects.toMatchObject({ status: 429 });
  });
});

describe("provider construction matrix", () => {
  it("google no longer throws 'not yet supported'", () => {
    expect(() => new ContextAgent({ provider: "google", model: "gemini-3-flash", apiKey: "gk", tools: [] })).not.toThrow();
  });

  it("ollama builds with no API key at all (fully local)", () => {
    const prev = process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_BASE_URL;
    try {
      expect(() => new ContextAgent({ provider: "ollama", model: "llama3.1", tools: [] })).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.OLLAMA_BASE_URL = prev;
    }
  });
});

describe("contextWindowFor → history budgets", () => {
  it("maps model families to their windows", () => {
    expect(contextWindowFor("gemini-3-flash")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(contextWindowFor("gpt-4o")).toBe(128_000);
    expect(contextWindowFor("qwen2.5-coder:7b")).toBe(32_000);
    expect(contextWindowFor("mystery-model")).toBe(128_000);
  });

  it("small-window local models get a proportionally small history budget", async () => {
    // llama (32k window) → 16k budget; a ~20k-token history must compact,
    // where the old fixed 120k default would have let it sail through.
    const agent = new ContextAgent({ provider: "ollama", model: "llama3.1", tools: [], compaction: "drop" });
    const big: AgentMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < 20; i++) big.push({ role: "assistant", content: "x".repeat(4000) });
    agent.loadMessages(big);
    // compact() with "drop" halves the budget → definitely drops something.
    const r = await agent.compact();
    expect(r.dropped).toBeGreaterThan(0);
  });
});
