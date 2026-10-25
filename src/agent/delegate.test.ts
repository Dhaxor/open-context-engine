import { describe, it, expect } from "vitest";
import { StreamEvent } from "./types";
import { DelegateObserver, delegateTool } from "./delegate";

function recorder() {
  const calls: string[] = [];
  const events: { id: string; event: StreamEvent }[] = [];
  let ended: { id: string; ok: boolean; chars: number; ms: number } | null = null;
  const observer: DelegateObserver = {
    start: (id, task) => calls.push(`start:${id}:${task}`),
    event: (id, event) => { events.push({ id, event }); },
    end: (id, result) => { calls.push(`end:${id}:${result.ok}`); ended = { id, ...result }; },
  };
  return { observer, calls, events, get ended() { return ended; } };
}

describe("delegateTool", () => {
  it("returns the child's answer to the parent", async () => {
    const tool = delegateTool({ makeAgent: () => ({ run: async () => "the report" }) });
    expect(await tool.handler({ task: "map the auth flow" })).toBe("the report");
  });

  it("rejects an empty brief", async () => {
    const tool = delegateTool({ makeAgent: () => ({ run: async () => "x" }) });
    expect(await tool.handler({ task: "  " })).toBe("No task given.");
  });

  it("truncates a long answer so it cannot flood the parent", async () => {
    const tool = delegateTool({
      makeAgent: () => ({ run: async () => "x".repeat(500) }),
      maxResultChars: 100,
    });
    const result = await tool.handler({ task: "t" });
    expect(result).toContain("truncated at 100 chars");
    expect(result.length).toBeLessThan(200);
  });

  it("reports a child failure as a result, not an exception", async () => {
    const tool = delegateTool({ makeAgent: () => ({ run: async () => { throw new Error("boom"); } }) });
    // A thrown error here would abort the parent's whole run.
    expect(await tool.handler({ task: "t" })).toBe("Sub-agent failed: boom");
  });

  it("announces the delegation and its outcome", async () => {
    const r = recorder();
    const tool = delegateTool({ makeAgent: () => ({ run: async () => "done" }), observer: r.observer });
    await tool.handler({ task: "map the auth flow" });

    // The counter is process-wide, so assert the shape and the pairing rather
    // than an absolute id.
    const id = r.calls[0].split(":")[1];
    expect(id).toMatch(/^sub-\d+$/);
    expect(r.calls[0]).toBe(`start:${id}:map the auth flow`);
    expect(r.calls[1]).toBe(`end:${id}:true`);
    expect(r.ended).toMatchObject({ id, ok: true, chars: 4 });
    expect(r.ended!.ms).toBeGreaterThanOrEqual(0);
  });

  it("republishes the child's stream so its work is visible", async () => {
    const r = recorder();
    const tool = delegateTool({
      observer: r.observer,
      makeAgent: () => ({
        run: async (_task, options) => {
          options?.onStream?.({ type: "tool_call", toolCall: { id: "c1", name: "codebase-retrieval", arguments: {} } });
          options?.onStream?.({ type: "text", text: "found it" });
          return "report";
        },
      }),
    });
    await tool.handler({ task: "t" });

    expect(r.events.map(e => e.event.type)).toEqual(["tool_call", "text"]);
    // Everything is tagged with the delegation, so a UI can nest it.
    expect(new Set(r.events.map(e => e.id)).size).toBe(1);
  });

  it("does not ask the child to stream when nobody is watching", async () => {
    let sawStream = false;
    const tool = delegateTool({
      makeAgent: () => ({
        run: async (_task, options) => { sawStream = options?.onStream !== undefined; return "r"; },
      }),
    });
    await tool.handler({ task: "t" });
    expect(sawStream).toBe(false);
  });

  it("still reports the end when the child fails", async () => {
    const r = recorder();
    const tool = delegateTool({
      makeAgent: () => ({ run: async () => { throw new Error("nope"); } }),
      observer: r.observer,
    });
    await tool.handler({ task: "t" });
    // Without this the UI would show a delegation running forever.
    expect(r.ended).toMatchObject({ ok: false, chars: 0 });
  });

  it("survives an observer that throws", async () => {
    const exploding: DelegateObserver = {
      start: () => { throw new Error("bad UI"); },
      event: () => { throw new Error("bad UI"); },
      end: () => { throw new Error("bad UI"); },
    };
    const tool = delegateTool({
      observer: exploding,
      makeAgent: () => ({
        run: async (_t, options) => { options?.onStream?.({ type: "text", text: "hi" }); return "report"; },
      }),
    });
    // A broken UI must never break a delegation.
    expect(await tool.handler({ task: "t" })).toBe("report");
  });

  it("gives each delegation its own id", async () => {
    const r = recorder();
    const tool = delegateTool({ makeAgent: () => ({ run: async () => "r" }), observer: r.observer });
    await tool.handler({ task: "one" });
    await tool.handler({ task: "two" });
    const ids = r.calls.filter(c => c.startsWith("start:")).map(c => c.split(":")[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it("passes the abort signal down to the child", async () => {
    let seen: AbortSignal | undefined;
    const tool = delegateTool({ makeAgent: () => ({ run: async (_t, o) => { seen = o?.signal; return "r"; } }) });
    const controller = new AbortController();
    await tool.handler({ task: "t" }, controller.signal);
    expect(seen).toBe(controller.signal);
  });
});
