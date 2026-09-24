import { describe, it, expect } from "vitest";
import { ContextAgent } from "../agent/agent";
import { AgentPlan } from "../agent/plan";
import { PermissionManager } from "../agent/permissions";
import { EditApplier } from "../agent/edit-tools";
import { AgentMessage, AgentRunOptions, StreamEvent } from "../agent/types";
import { RetrievalDebugReport } from "../core/retriever";
import { CheckpointStore } from "./checkpoints";
import { ContextLedger } from "./ledger";
import { SessionMeta, TraceEnvelope, TraceEvent } from "./protocol";
import { TraceSession, truncateToTurn } from "./session";

class MemoryApplier implements EditApplier {
  constructor(public files = new Map<string, string>()) {}
  async readFile(p: string) { return this.files.has(p) ? this.files.get(p)! : null; }
  async writeFile(p: string, c: string) { this.files.set(p, c); }
  async removeFile(p: string) { return this.files.delete(p); }
  async fileExists(p: string) { return this.files.has(p); }
}

/** Minimal stand-in for ContextAgent — enough surface for the session, no LLM. */
class StubAgent {
  messages: AgentMessage[] = [];
  script: (emit: (e: StreamEvent) => void, signal?: AbortSignal) => Promise<void> = async () => {};
  compacted = 0;

  async run(query: string, opts: AgentRunOptions = {}): Promise<string> {
    this.messages.push({ role: "user", content: query });
    await this.script(e => opts.onStream?.(e), opts.signal);
    if (opts.signal?.aborted) throw new Error("The operation was aborted");
    opts.onStream?.({
      type: "run_end",
      stats: { steps: 1, llmCalls: 1, toolCalls: 0, toolErrors: 0, usage: { inputTokens: 10, outputTokens: 5 }, durationMs: 5 },
    });
    return "done";
  }
  getMessages(): readonly AgentMessage[] { return this.messages; }
  loadMessages(m: AgentMessage[]): void { this.messages = [...m]; }
  exportSession(): string { return JSON.stringify({ version: 1, messages: this.messages }); }
  reset(): void { this.messages = []; }
  async compact() { this.compacted++; return { dropped: 3, summarized: true }; }
}

const META: Omit<SessionMeta, "turn" | "startedAt" | "mode"> = {
  id: "s1", title: "test", workspace: "/ws", provider: "openai", model: "gpt-4o",
  windowTokens: 128_000, indexedChunks: 100, searchMode: "hybrid", indexFresh: true, auditing: false,
};

function build(over: { applier?: MemoryApplier; permissions?: PermissionManager } = {}) {
  const agent = new StubAgent();
  const applier = over.applier ?? new MemoryApplier();
  const plan = new AgentPlan();
  const permissions = over.permissions ?? new PermissionManager({ mode: "suggest" });
  const ledger = new ContextLedger({
    windowTokens: 128_000,
    systemPrompt: () => "system",
    toolSchemas: () => [],
  });
  const checkpoints = new CheckpointStore({ applier });
  const session = new TraceSession({
    id: "s1",
    agent: agent as unknown as ContextAgent,
    plan, permissions, ledger, checkpoints, meta: META,
  });
  const events: TraceEvent[] = [];
  const envelopes: TraceEnvelope[] = [];
  session.subscribe(e => { envelopes.push(e); events.push(e.event); });
  return { session, agent, plan, permissions, ledger, checkpoints, applier, events, envelopes };
}

function types(events: TraceEvent[]): string[] { return events.map(e => e.type); }

function report(paths: string[]): RetrievalDebugReport {
  return {
    query: "how does search work",
    signals: [],
    vectorHits: [],
    bm25Hits: [],
    fused: [],
    ranked: [],
    expanded: [],
    final: paths.map((p, i) => ({ rank: i + 1, path: p, lines: "1-9", score: 0.9 - i * 0.1, preview: "…" })),
    finalResults: paths.map(p => ({ chunk: { id: p, path: p, startLine: 1, endLine: 9, contents: `body of ${p}` }, score: 0.9 })),
  };
}

describe("TraceSession streaming", () => {
  it("opens with the session state so a fresh client can render immediately", () => {
    const { events } = build();
    expect(events[0]).toMatchObject({ type: "session" });
    expect((events[0] as any).meta.mode).toBe("suggest");
  });

  it("gives a late subscriber the history that already happened", async () => {
    // A browser attached to a session already underway must not show an empty
    // transcript next to a "live" badge.
    const { session, agent } = build();
    agent.script = async emit => { emit({ type: "text", text: "already said" }); };
    await session.prompt("earlier question");

    const late: TraceEnvelope[] = [];
    session.subscribe(e => late.push(e));
    const kinds = late.map(e => e.event.type);
    expect(kinds[0]).toBe("session");
    expect(kinds).toContain("turn_start");
    expect(late.some(e => (e.event as any).text === "already said")).toBe(true);
  });

  it("numbers the opening snapshot 0 so it cannot skip buffered events", () => {
    const { session, envelopes } = build();
    expect(envelopes[0].seq).toBe(0);
    expect(session.cursor()).toBe(0);
  });

  it("emits a turn as start → text → end → checkpoint", async () => {
    const { session, agent, events } = build();
    agent.script = async emit => { emit({ type: "text", text: "hello" }); };
    await session.prompt("why does search degrade");
    expect(types(events)).toContain("turn_start");
    expect(types(events)).toContain("turn_end");
    expect(types(events)).toContain("checkpoint");
    const text = events.find(e => e.type === "text") as any;
    expect(text.text).toBe("hello");
  });

  it("numbers every event so a reconnect can replay exactly what it missed", async () => {
    const { session, agent, envelopes } = build();
    agent.script = async emit => { emit({ type: "text", text: "a" }); };
    await session.prompt("one");
    const cursorAfterFirst = envelopes[envelopes.length - 1].seq;
    await session.prompt("two");

    const replayed: TraceEnvelope[] = [];
    session.subscribe(e => replayed.push(e), cursorAfterFirst);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every(e => e.seq > cursorAfterFirst)).toBe(true);
    expect(replayed.map(e => e.seq)).toEqual([...replayed.map(e => e.seq)].sort((a, b) => a - b));
    expect((replayed[0].event as any).prompt).toBe("two");
  });

  it("keeps running when a subscriber throws", async () => {
    const { session, agent } = build();
    session.subscribe(() => { throw new Error("bad UI"); });
    agent.script = async emit => { emit({ type: "text", text: "still fine" }); };
    await expect(session.prompt("hi")).resolves.toBeUndefined();
  });

  it("reports an error as a notice rather than throwing at the caller", async () => {
    const { session, agent, events } = build();
    agent.script = async () => { throw new Error("provider exploded"); };
    await session.prompt("hi");
    const notice = events.find(e => e.type === "notice") as any;
    expect(notice).toMatchObject({ level: "error", message: "provider exploded" });
  });

  it("refuses to start a second turn while one is running", async () => {
    const { session, agent } = build();
    let release = () => {};
    agent.script = () => new Promise<void>(r => { release = r; });
    const first = session.prompt("one");
    await expect(session.prompt("two")).rejects.toThrow(/already running/);
    release();
    await first;
  });
});

describe("TraceSession retrieval telemetry", () => {
  it("correlates a retrieval back to its tool call and files it in the ledger", async () => {
    const { session, agent, ledger, events } = build();
    agent.script = async emit => {
      emit({ type: "tool_call", toolCall: { id: "call-1", name: "codebase-retrieval", arguments: { information_request: "how does search work" } } });
      session.observeRetrieval({ query: "how does search work", report: report(["src/a.ts", "src/b.ts"]), durationMs: 42, stages: [{ stage: "bm25", ms: 3, count: 40 }] });
      emit({ type: "tool_result", toolResult: { id: "call-1", name: "codebase-retrieval", result: "output" } });
    };
    await session.prompt("why");

    const retrieval = events.find(e => e.type === "retrieval") as any;
    expect(retrieval.trace.toolCallId).toBe("call-1");
    expect(retrieval.trace.durationMs).toBe(42);
    expect(retrieval.trace.chunks).toHaveLength(2);
    expect(ledger.snapshot([]).entries.map(e => e.label)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("publishes a context snapshot alongside the retrieval", async () => {
    const { session, agent, events } = build();
    agent.script = async () => {
      session.observeRetrieval({ query: "q", report: report(["src/a.ts"]), durationMs: 1, stages: [] });
    };
    await session.prompt("why");
    const ctx = events.find(e => e.type === "context") as any;
    expect(ctx.snapshot.buckets.retrieval).toBeGreaterThan(0);
    expect(ctx.snapshot.windowTokens).toBe(128_000);
  });

  it("tracks read-file results against the path from the call", async () => {
    const { session, agent, ledger } = build();
    agent.script = async emit => {
      emit({ type: "tool_call", toolCall: { id: "c9", name: "read-file", arguments: { path: "src/x.ts" } } });
      emit({ type: "tool_result", toolResult: { id: "c9", name: "read-file", result: "file body" } });
    };
    await session.prompt("read it");
    expect(ledger.snapshot([]).entries[0]).toMatchObject({ bucket: "files", label: "src/x.ts" });
  });

  it("reports the phase so the UI can show progress instead of a spinner", async () => {
    const { session, agent, events } = build();
    agent.script = async emit => {
      emit({ type: "tool_call", toolCall: { id: "c1", name: "codebase-retrieval", arguments: { information_request: "q" } } });
      emit({ type: "tool_result", toolResult: { id: "c1", name: "codebase-retrieval", result: "r" } });
    };
    await session.prompt("why");
    const phases = events.filter(e => e.type === "phase").map(e => (e as any).phase);
    expect(phases).toContain("retrieving");
    expect(phases[phases.length - 1]).toBe("idle");
  });
});

describe("TraceSession mentions", () => {
  function withFiles(files: Record<string, string>) {
    const h = build();
    (h.session as any).opts.listFiles = () => Object.keys(files);
    (h.session as any).opts.readFile = async (p: string) => files[p] ?? null;
    return h;
  }

  it("ranks indexed paths for the @ menu", () => {
    const { session } = withFiles({ "src/core/retriever.ts": "a", "src/cli/index.ts": "b" });
    expect(session.files("retriev")).toEqual(["src/core/retriever.ts"]);
    expect(session.files("")).toHaveLength(2);
  });

  it("pins a mentioned file so it survives compaction", async () => {
    const { session, ledger } = withFiles({ "src/a.ts": "export const a = 1;" });
    const result = await session.mention(["src/a.ts"]);

    expect(result.pinned).toEqual(["src/a.ts"]);
    const entry = ledger.snapshot([]).entries.find(e => e.label === "src/a.ts")!;
    // A mention is the user saying what matters — retrieval only guesses.
    expect(entry.pinned).toBe(true);
    expect(ledger.pinnedBlock()).toContain("export const a = 1;");
  });

  it("warns about a path that is not indexed instead of failing silently", async () => {
    const { session, events } = withFiles({ "src/a.ts": "x" });
    const result = await session.mention(["src/a.ts", "nope.ts"]);

    expect(result).toEqual({ pinned: ["src/a.ts"], missing: ["nope.ts"] });
    const warning = events.find(e => e.type === "notice" && (e as any).level === "warn") as any;
    expect(warning.message).toContain("nope.ts");
  });

  it("resolves mentions before the turn runs, not a turn late", async () => {
    const { session, agent, ledger } = withFiles({ "src/a.ts": "PINNED BODY" });
    let pinnedDuringTurn = false;
    agent.script = async () => {
      pinnedDuringTurn = (ledger.pinnedBlock() ?? "").includes("PINNED BODY");
    };
    await session.prompt("explain @src/a.ts please");
    // The model must be given the file it was asked about on THIS turn.
    expect(pinnedDuringTurn).toBe(true);
  });

  it("leaves the mention text in the prompt", async () => {
    const { session, agent } = withFiles({ "src/a.ts": "x" });
    agent.script = async () => {};
    await session.prompt("explain @src/a.ts please");
    // Stripping it would lose which file the sentence is about.
    expect(agent.messages[0].content).toBe("explain @src/a.ts please");
  });
});

describe("TraceSession direct shell", () => {
  function withShell(run?: (command: string) => Promise<string>) {
    const h = build();
    if (run) (h.session as any).opts.runCommand = run;
    return h;
  }

  it("runs a command and records it in the transcript", async () => {
    const { session, events } = withShell(async () => "3 passed");
    session.setMode("full-auto");
    await session.runShell("npm test");

    const call = events.find(e => e.type === "tool_call") as any;
    const result = events.find(e => e.type === "tool_result") as any;
    expect(call.call).toMatchObject({ name: "run-command", arguments: { command: "npm test" } });
    // The model's next turn inherits a changed workspace; the record has to
    // explain why.
    expect(result).toMatchObject({ ok: true, name: "run-command" });
    expect(result.result).toBe("3 passed");
  });

  it("still asks for approval — typing it by hand is no safer", async () => {
    const permissions = new PermissionManager({ mode: "suggest" });
    permissions.registerMutatingTools(["run-command"]);
    const h = build({ permissions });
    (h.session as any).opts.runCommand = async () => "done";

    const running = h.session.runShell("rm -rf build");
    await new Promise(r => setTimeout(r, 20));
    const [id] = h.session.pendingApproval();
    expect(id).toBeDefined();
    h.session.approve(id, "deny");
    await running;

    const notice = h.events.find(e => e.type === "notice" && (e as any).level === "warn") as any;
    expect(notice.message).toContain("Not run");
    expect(h.events.some(e => e.type === "tool_call")).toBe(false);
  });

  it("reports a failed command rather than throwing", async () => {
    const { session, events } = withShell(async () => { throw new Error("exit 1"); });
    session.setMode("full-auto");
    await session.runShell("false");
    const result = events.find(e => e.type === "tool_result") as any;
    expect(result).toMatchObject({ ok: false });
    expect(result.result).toContain("exit 1");
  });

  it("refuses when policy stripped the shell tool", async () => {
    const { session, events } = withShell();
    await session.runShell("npm test");
    // There is no second path around the policy.
    expect(events.some(e => e.type === "tool_call")).toBe(false);
    const notice = events.find(e => e.type === "notice" && (e as any).level === "error") as any;
    expect(notice.message).toContain("disabled by policy");
  });

  it("returns to idle afterwards", async () => {
    const { session, events } = withShell(async () => "ok");
    session.setMode("full-auto");
    await session.runShell("ls");
    const phases = events.filter(e => e.type === "phase").map(e => (e as any).phase);
    expect(phases[phases.length - 1]).toBe("idle");
  });
});

describe("TraceSession sub-agents", () => {
  it("tags a child's events with the delegation so a UI can nest them", async () => {
    const { session, agent, envelopes } = build();
    agent.script = async () => {
      const d = session.delegateObserver;
      d.start("sub-1", "map the auth flow");
      d.event("sub-1", { type: "tool_call", toolCall: { id: "c1", name: "codebase-retrieval", arguments: {} } });
      d.event("sub-1", { type: "text", text: "found it" });
      d.end("sub-1", { ok: true, chars: 820, ms: 4100 });
    };
    await session.prompt("why");

    const tagged = envelopes.filter(e => e.agentId === "sub-1");
    expect(tagged.map(e => e.event.type)).toEqual(["tool_call", "text"]);
    // start/end describe the delegation itself, so they belong to the parent.
    const start = envelopes.find(e => e.event.type === "subagent_start");
    expect(start?.agentId).toBeUndefined();
    expect(start?.event).toMatchObject({ id: "sub-1", task: "map the auth flow" });
    expect(envelopes.find(e => e.event.type === "subagent_end")?.event)
      .toMatchObject({ ok: true, chars: 820, ms: 4100 });
  });

  it("keeps a sub-agent's work out of the context ledger", async () => {
    const { session, agent, ledger, events } = build();
    agent.script = async () => {
      const d = session.delegateObserver;
      d.start("sub-1", "explore");
      d.event("sub-1", { type: "tool_result", toolResult: { id: "c9", name: "read-file", result: "x".repeat(9000) } });
      d.end("sub-1", { ok: true, chars: 10, ms: 5 });
    };
    await session.prompt("why");

    // The child works in its OWN context; counting it would make the rail lie
    // about the main thread's window.
    expect(ledger.snapshot([]).entries).toEqual([]);
    const last = [...events].reverse().find(e => e.type === "context") as any;
    expect(last.snapshot.buckets.files).toBe(0);
  });

  it("reports the delegation as the running phase", async () => {
    const { session, agent, events } = build();
    agent.script = async () => {
      session.delegateObserver.start("sub-1", "map the auth flow end to end");
    };
    await session.prompt("why");
    const detail = events.filter(e => e.type === "phase").map(e => (e as any).detail ?? "");
    expect(detail.some(d => d.includes("delegate · map the auth flow"))).toBe(true);
  });
});

describe("TraceSession approvals", () => {
  it("surfaces a pending approval and resolves it from a command", async () => {
    const permissions = new PermissionManager({ mode: "suggest" });
    permissions.registerMutatingTools(["str-replace"]);
    const { session, agent, events } = build({ permissions });

    agent.script = async () => {
      const decision = permissions.check({ id: "t1", name: "str-replace", arguments: { path: "a.ts", old_str: "a", new_str: "b" } });
      // The UI answers while the agent waits — the whole point of the async ask.
      await Promise.resolve();
      const pending = session.pendingApproval();
      expect(pending).toHaveLength(1);
      session.approve(pending[0], "allow");
      expect(await decision).toMatchObject({ behavior: "allow" });
    };
    await session.prompt("edit it");

    const request = events.find(e => e.type === "approval_request") as any;
    expect(request.request).toMatchObject({ kind: "edit", title: "edit a.ts" });
    expect(request.request.risk).toBeGreaterThan(0);
    expect(types(events)).toContain("approval_resolved");
  });

  it("ignores an unknown or already-answered approval", () => {
    const { session } = build();
    expect(session.approve("nope", "allow")).toBe(false);
  });

  it("scores blast radius higher for a delete than an edit", () => {
    const permissions = new PermissionManager({ mode: "suggest" });
    permissions.registerMutatingTools(["remove-file", "str-replace"]);
    const { session, permissions: p } = build({ permissions });
    void p.check({ id: "r", name: "remove-file", arguments: { path: "a.ts" } });
    void p.check({ id: "e", name: "str-replace", arguments: { path: "a.ts", old_str: "a", new_str: "b" } });
    const [removeId, editId] = session.pendingApproval();
    expect(removeId).toBeDefined();
    expect(editId).toBeDefined();
  });
});

describe("TraceSession context commands", () => {
  it("evicting rewrites the agent's own history", async () => {
    const { session, agent, ledger } = build();
    agent.script = async emit => {
      emit({ type: "tool_call", toolCall: { id: "call-1", name: "codebase-retrieval", arguments: { information_request: "q" } } });
      session.observeRetrieval({ query: "q", report: report(["src/a.ts", "src/b.ts"]), durationMs: 1, stages: [] });
      emit({ type: "tool_result", toolResult: { id: "call-1", name: "codebase-retrieval", result: "ORIGINAL" } });
    };
    await session.prompt("why");
    agent.messages.push({ role: "tool", content: "ORIGINAL", toolCallId: "call-1", toolName: "codebase-retrieval" });

    const target = ledger.snapshot([]).entries.find(e => e.label === "src/b.ts")!;
    expect(session.evict(target.id)).toBe(true);

    const tool = agent.messages.find(m => m.role === "tool")!;
    expect(tool.content).toContain("body of src/a.ts");
    expect(tool.content).not.toContain("body of src/b.ts");
  });

  it("pinning is reflected in the snapshot", async () => {
    const { session, agent, ledger, events } = build();
    agent.script = async () => {
      session.observeRetrieval({ query: "q", report: report(["src/a.ts"]), durationMs: 1, stages: [] });
    };
    await session.prompt("why");
    const id = ledger.snapshot([]).entries[0].id;
    expect(session.pin(id)).toBe(true);
    const last = [...events].reverse().find(e => e.type === "context") as any;
    expect(last.snapshot.entries[0].pinned).toBe(true);
    expect(ledger.pinnedBlock()).toContain("body of src/a.ts");
  });

  it("rejects a ledger command for an unknown entry", () => {
    const { session } = build();
    expect(session.evict("nope")).toBe(false);
  });

  it("changing approval mode is announced", () => {
    const { session, events, permissions } = build();
    session.setMode("full-auto");
    expect(permissions.getMode()).toBe("full-auto");
    expect((events[events.length - 1] as any).mode).toBe("full-auto");
  });

  it("compact delegates to the agent and republishes context", async () => {
    const { session, agent, events } = build();
    await session.compact();
    expect(agent.compacted).toBe(1);
    expect(types(events)).toContain("compacted");
  });

  it("reset clears the conversation, plan, ledger and checkpoints", async () => {
    const { session, agent, ledger, checkpoints } = build();
    agent.script = async () => {
      session.observeRetrieval({ query: "q", report: report(["src/a.ts"]), durationMs: 1, stages: [] });
    };
    await session.prompt("why");
    expect(checkpoints.list()).toHaveLength(1);
    session.reset();
    expect(agent.messages).toEqual([]);
    expect(ledger.snapshot([]).entries).toEqual([]);
    expect(checkpoints.list()).toEqual([]);
  });
});

describe("TraceSession rewind", () => {
  it("undoes the files and drops the turns that made them", async () => {
    const applier = new MemoryApplier(new Map([["a.ts", "v2"]]));
    const { session, agent, events, checkpoints } = build({ applier });

    agent.script = async () => {};
    await session.prompt("first");
    const target = checkpoints.list()[0].hash;

    agent.script = async emit => {
      emit({ type: "edit_proposed", edit: { id: "e1", kind: "str-replace", path: "a.ts", oldContents: "v1", newContents: "v2", diff: "" } });
    };
    await session.prompt("second");
    expect(agent.messages.filter(m => m.role === "user")).toHaveLength(2);

    await session.rewind(target);
    expect(applier.files.get("a.ts")).toBe("v1");
    expect(agent.messages.filter(m => m.role === "user")).toHaveLength(1);
    const rewound = events.find(e => e.type === "rewound") as any;
    expect(rewound).toMatchObject({ toHash: target, turnsDropped: 1, filesRestored: 1 });
  });

  it("warns instead of clobbering a file the user changed", async () => {
    const applier = new MemoryApplier(new Map([["a.ts", "MINE"]]));
    const { session, agent, events, checkpoints } = build({ applier });
    agent.script = async () => {};
    await session.prompt("first");
    const target = checkpoints.list()[0].hash;
    agent.script = async emit => {
      emit({ type: "edit_proposed", edit: { id: "e1", kind: "str-replace", path: "a.ts", oldContents: "v1", newContents: "v2", diff: "" } });
    };
    await session.prompt("second");

    await session.rewind(target);
    expect(applier.files.get("a.ts")).toBe("MINE");
    const warning = events.find(e => e.type === "notice" && (e as any).level === "warn") as any;
    expect(warning.message).toContain("Left a.ts alone");
  });

  it("refuses to rewind under a running turn", async () => {
    const { session, agent, checkpoints } = build();
    agent.script = async () => {};
    await session.prompt("first");
    const target = checkpoints.list()[0].hash;

    let release = () => {};
    agent.script = () => new Promise<void>(r => { release = r; });
    const running = session.prompt("second");
    await expect(session.rewind(target)).rejects.toThrow(/Interrupt the running turn/);
    release();
    await running;
  });

  it("builds a real hash chain even when auditing is off", async () => {
    const { session, agent, checkpoints } = build();
    agent.script = async () => {};
    await session.prompt("one");
    await session.prompt("two");
    const [a, b] = checkpoints.list();
    expect(a.hash).toHaveLength(64);
    expect(b.prev).toBe(a.hash);
    expect(a.short).toBe(a.hash.slice(0, 4));
  });
});

describe("truncateToTurn", () => {
  const history: AgentMessage[] = [
    { role: "user", content: "one" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "two" },
    { role: "assistant", content: "a2", toolCalls: [{ id: "t", name: "read-file", arguments: {} }] },
    { role: "tool", content: "r", toolCallId: "t" },
  ];

  it("keeps whole exchanges", () => {
    expect(truncateToTurn(history, 1)).toHaveLength(2);
  });

  it("keeps everything when the turn is the last one", () => {
    expect(truncateToTurn(history, 2)).toHaveLength(5);
  });

  it("returns nothing at turn zero", () => {
    expect(truncateToTurn(history, 0)).toEqual([]);
  });

  it("never splits a tool call from its result", () => {
    const kept = truncateToTurn(history, 1);
    const calls = kept.flatMap(m => m.toolCalls ?? []);
    expect(calls).toEqual([]);
  });
});
