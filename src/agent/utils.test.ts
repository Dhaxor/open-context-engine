import { describe, it, expect } from "vitest";
import { compactHistory, truncateToolResult, withRetry, estimateTokens } from "./utils";
import { AgentMessage } from "./types";

function user(content: string): AgentMessage { return { role: "user", content }; }
function assistant(content: string, toolCalls?: any[]): AgentMessage { return { role: "assistant", content, toolCalls }; }
function tool(id: string, content: string): AgentMessage { return { role: "tool", content, toolCallId: id, toolName: "x" }; }

describe("truncateToolResult", () => {
  it("leaves small results alone", () => {
    const r = truncateToolResult("hello", 100);
    expect(r).toBe("hello");
  });
  it("truncates large results with marker", () => {
    const big = "a".repeat(5000);
    const r = truncateToolResult(big, 1000);
    expect(r.length).toBeLessThanOrEqual(1100);
    expect(r).toContain("truncated");
    expect(r.startsWith("a")).toBe(true);
    expect(r.endsWith("a")).toBe(true);
  });
});

describe("compactHistory", () => {
  it("is a no-op when within budget", () => {
    const msgs = [user("hi"), assistant("hello")];
    const { messages, droppedCount } = compactHistory(msgs, 10_000);
    expect(droppedCount).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it("drops older messages while preserving first user and recent tail", () => {
    const msgs: AgentMessage[] = [];
    msgs.push(user("original question"));
    for (let i = 0; i < 30; i++) {
      msgs.push(assistant("a".repeat(400)));
      msgs.push(user("follow up " + i));
    }
    const budget = estimateTokens("a".repeat(400)) * 6 + 50;
    const { messages, droppedCount } = compactHistory(msgs, budget);
    expect(droppedCount).toBeGreaterThan(0);
    expect(messages[0]).toBe(msgs[0]);
    expect(messages[messages.length - 1]).toBe(msgs[msgs.length - 1]);
    expect(messages.length).toBeLessThan(msgs.length);
  });

  it("repairs orphan tool messages whose call disappeared", () => {
    const msgs = [
      user("q"),
      assistant("", [{ id: "t1", name: "x", arguments: {} }]),
      tool("t1", "result1"),
      assistant("final"),
      user("q2"),
      assistant("", [{ id: "t2", name: "x", arguments: {} }]),
      tool("t2", "result2"),
      assistant("final2"),
    ];
    const { messages } = compactHistory(msgs, 30);
    for (const m of messages) {
      if (m.role === "tool" && m.toolCallId) {
        const hasCall = messages.some(o => o.role === "assistant" && o.toolCalls?.some(tc => tc.id === m.toolCallId));
        expect(hasCall).toBe(true);
      }
    }
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls++; return 42; }, { maxRetries: 3, baseDelayMs: 1 });
    expect(r).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries on 429 and eventually succeeds", async () => {
    let calls = 0;
    const retries: number[] = [];
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) { const e: any = new Error("rate"); e.status = 429; throw e; }
      return "ok";
    }, { maxRetries: 5, baseDelayMs: 1, onRetry: (a) => retries.push(a) });
    expect(r).toBe("ok");
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it("does not retry on 4xx non-429", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      const e: any = new Error("bad"); e.status = 400; throw e;
    }, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow(/bad/);
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries on 500", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      const e: any = new Error("boom"); e.status = 500; throw e;
    }, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow(/boom/);
    expect(calls).toBe(3);
  });
});
