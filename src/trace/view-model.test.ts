import { describe, it, expect } from "vitest";
import type { RetrievalTrace, TraceEnvelope, TraceEvent } from "./protocol";
import { budgetPercent, initialState, phaseLabel, railEntries, reduce, type ViewState } from "./view-model";

let seq = 0;
function env(event: TraceEvent, at?: number): TraceEnvelope {
  return { seq: at ?? ++seq, ts: "", sessionId: "s1", event };
}

function apply(events: TraceEvent[], from: ViewState = initialState): ViewState {
  return events.reduce((s, e) => reduce(s, { type: "event", envelope: env(e) }), from);
}

function trace(over: Partial<RetrievalTrace> = {}): RetrievalTrace {
  return {
    id: "r1", query: "q", chunks: [], stages: [], durationMs: 10,
    searchMode: "hybrid", signals: [], graphAdded: 0, droppedChunks: 0, totalChars: 0, ...over,
  };
}

describe("reduce — transcript shape", () => {
  it("groups blocks under the turn that produced them", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "why" },
      { type: "text", text: "because" },
      { type: "turn_start", turn: 2, prompt: "and?" },
      { type: "text", text: "also" },
    ]);
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0].blocks).toEqual([{ kind: "text", text: "because" }]);
    expect(state.turns[1].prompt).toBe("and?");
  });

  it("coalesces streamed text deltas into one block", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "why" },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo " },
      { type: "text", text: "world" },
    ]);
    // A block per token would break markdown parsing and text selection.
    expect(state.turns[0].blocks).toEqual([{ kind: "text", text: "Hello world" }]);
  });

  it("does not merge text across an interleaved tool call", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "why" },
      { type: "text", text: "first" },
      { type: "tool_call", call: { id: "c1", name: "read-file", arguments: {} } },
      { type: "text", text: "second" },
    ]);
    expect(state.turns[0].blocks.map(b => b.kind)).toEqual(["text", "tool", "text"]);
  });

  it("completes a tool block in place when its result lands", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "why" },
      { type: "tool_call", call: { id: "c1", name: "read-file", arguments: {} } },
      { type: "tool_result", id: "c1", name: "read-file", ok: true, ms: 12, chars: 400 },
    ]);
    expect(state.turns[0].blocks[0]).toEqual({ kind: "tool", id: "c1", name: "read-file", ok: true, ms: 12, chars: 400 });
  });

  it("opens an implicit turn for events that arrive without one", () => {
    // Resumed sessions replay mid-conversation; dropping these would make the
    // agent's work invisible.
    const state = apply([{ type: "text", text: "orphan" }]);
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].blocks).toEqual([{ kind: "text", text: "orphan" }]);
  });

  it("attaches stats and the checkpoint to the right turn", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "why" },
      { type: "turn_end", turn: 1, stats: { steps: 2, llmCalls: 2, toolCalls: 1, toolErrors: 0, usage: { inputTokens: 5, outputTokens: 3 }, durationMs: 900 } },
      { type: "checkpoint", checkpoint: { seq: 1, hash: "a".repeat(64), prev: "", short: "aaaa", ts: "", label: "why", turn: 1, filesTouched: 1, restorable: true } },
    ]);
    expect(state.turns[0].stats?.steps).toBe(2);
    expect(state.turns[0].checkpoint?.short).toBe("aaaa");
    expect(state.checkpoints).toHaveLength(1);
  });
});

describe("reduce — sub-agents", () => {
  function nested(event: TraceEvent, agentId: string): TraceEnvelope {
    return { seq: ++seq, ts: "", sessionId: "s1", agentId, event };
  }

  const opened = () => apply([
    { type: "turn_start", turn: 1, prompt: "map the auth flow" },
    { type: "subagent_start", id: "sub-1", task: "trace login end to end" },
  ]);

  it("opens a delegation as its own block", () => {
    const block = opened().turns[0].blocks[0];
    expect(block).toMatchObject({ kind: "subagent", id: "sub-1", task: "trace login end to end", blocks: [] });
  });

  it("routes the child's events inside it, not into the main thread", () => {
    let state = opened();
    state = reduce(state, { type: "event", envelope: nested({ type: "tool_call", call: { id: "c1", name: "codebase-retrieval", arguments: {} } }, "sub-1") });
    state = reduce(state, { type: "event", envelope: nested({ type: "text", text: "found it" }, "sub-1") });

    // The parent's transcript still holds exactly one block: the delegation.
    expect(state.turns[0].blocks).toHaveLength(1);
    const block = state.turns[0].blocks[0] as any;
    expect(block.blocks.map((b: any) => b.kind)).toEqual(["tool", "text"]);
  });

  it("folds nested text with the same coalescing as the main thread", () => {
    let state = opened();
    for (const text of ["par", "tial ", "answer"]) {
      state = reduce(state, { type: "event", envelope: nested({ type: "text", text }, "sub-1") });
    }
    const block = state.turns[0].blocks[0] as any;
    expect(block.blocks).toEqual([{ kind: "text", text: "partial answer" }]);
  });

  it("completes a nested tool call in place", () => {
    let state = opened();
    state = reduce(state, { type: "event", envelope: nested({ type: "tool_call", call: { id: "c1", name: "read-file", arguments: {} } }, "sub-1") });
    state = reduce(state, { type: "event", envelope: nested({ type: "tool_result", id: "c1", name: "read-file", ok: true, ms: 9, chars: 100 }, "sub-1") });
    const block = state.turns[0].blocks[0] as any;
    expect(block.blocks[0]).toMatchObject({ kind: "tool", ok: true, ms: 9 });
  });

  it("marks the delegation done with its outcome", () => {
    const state = apply([{ type: "subagent_end", id: "sub-1", ok: true, chars: 820, ms: 4100 }], opened());
    expect((state.turns[0].blocks[0] as any).done).toEqual({ ok: true, chars: 820, ms: 4100 });
  });

  it("keeps two concurrent delegations apart", () => {
    let state = apply([
      { type: "turn_start", turn: 1, prompt: "q" },
      { type: "subagent_start", id: "sub-1", task: "one" },
      { type: "subagent_start", id: "sub-2", task: "two" },
    ]);
    state = reduce(state, { type: "event", envelope: nested({ type: "text", text: "from one" }, "sub-1") });
    state = reduce(state, { type: "event", envelope: nested({ type: "text", text: "from two" }, "sub-2") });

    const [a, b] = state.turns[0].blocks as any[];
    expect(a.blocks[0].text).toBe("from one");
    expect(b.blocks[0].text).toBe("from two");
  });

  it("drops an event for a delegation that was never announced", () => {
    // Better than inventing a delegation the session never opened.
    const state = reduce(opened(), { type: "event", envelope: nested({ type: "text", text: "orphan" }, "sub-99") });
    expect((state.turns[0].blocks[0] as any).blocks).toEqual([]);
  });

  it("still advances the cursor for a nested event", () => {
    const state = reduce(opened(), { type: "event", envelope: nested({ type: "text", text: "x" }, "sub-1") });
    // Otherwise a reconnect would replay everything after the first nested event.
    expect(state.cursor).toBe(seq);
  });

  it("does not let a sub-agent's context snapshot overwrite the main window", () => {
    let state = opened();
    state = reduce(state, {
      type: "event",
      envelope: {
        seq: ++seq, ts: "", sessionId: "s1",
        event: {
          type: "context",
          snapshot: { windowTokens: 1000, usedTokens: 900, buckets: { retrieval: 900, files: 0, history: 0, system: 0, tools: 0 }, entries: [] },
        },
      },
    });
    const parentUsed = state.context!.usedTokens;
    state = reduce(state, {
      type: "event",
      envelope: nested({
        type: "context",
        snapshot: { windowTokens: 1000, usedTokens: 5, buckets: { retrieval: 5, files: 0, history: 0, system: 0, tools: 0 }, entries: [] },
      }, "sub-1"),
    });
    // The rail describes the MAIN thread's window; a child's is not it.
    expect(state.context!.usedTokens).toBe(parentUsed);
  });
});

describe("reduce — replay and idempotence", () => {
  it("ignores events at or below the cursor", () => {
    let state = reduce(initialState, { type: "event", envelope: env({ type: "turn_start", turn: 1, prompt: "one" }, 5) });
    expect(state.cursor).toBe(5);
    // A reconnect can overlap; replaying must not duplicate the turn.
    state = reduce(state, { type: "event", envelope: env({ type: "turn_start", turn: 1, prompt: "one" }, 5) });
    state = reduce(state, { type: "event", envelope: env({ type: "turn_start", turn: 1, prompt: "one" }, 3) });
    expect(state.turns).toHaveLength(1);
    expect(state.cursor).toBe(5);
  });

  it("tracks the cursor from the envelope, not from a counter", () => {
    const state = reduce(initialState, { type: "event", envelope: env({ type: "phase", phase: "thinking" }, 42) });
    expect(state.cursor).toBe(42);
  });

  it("clears everything when the client switches session", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "from the old session" },
      { type: "text", text: "old answer" },
      { type: "checkpoint", checkpoint: { seq: 1, hash: "a".repeat(64), prev: "", short: "aaaa", ts: "", label: "x", turn: 1, filesTouched: 0, restorable: false } },
    ]);
    const connected = reduce(state, { type: "connection", connected: true });
    const switched = reduce(connected, { type: "switch-session" });

    // Keeping any of it would splice two conversations together, and the new
    // session's sequence starts from scratch.
    expect(switched.turns).toEqual([]);
    expect(switched.checkpoints).toEqual([]);
    expect(switched.cursor).toBe(-1);
    // Connection is a property of the socket, not of the session.
    expect(switched.connected).toBe(true);
  });

  it("accepts the new session's events immediately after a switch", () => {
    let state = apply([{ type: "turn_start", turn: 1, prompt: "old" }]);
    state = reduce(state, { type: "switch-session" });
    state = reduce(state, { type: "event", envelope: env({ type: "turn_start", turn: 1, prompt: "new" }, 1) });
    expect(state.turns.map(t => t.prompt)).toEqual(["new"]);
  });

  it("records connection state separately from the stream", () => {
    const state = reduce(initialState, { type: "connection", connected: true });
    expect(state.connected).toBe(true);
    expect(state.cursor).toBe(-1);
  });

  it("accepts the seq-0 session snapshot a fresh subscriber receives", () => {
    // The cursor starts at -1 precisely so this is not filtered as a duplicate.
    const meta = {
      id: "s1", title: "t", workspace: "/ws", provider: "openai", model: "gpt-4o",
      mode: "suggest" as const, windowTokens: 1000, indexedChunks: 5,
      searchMode: "hybrid" as const, indexFresh: true, auditing: false, turn: 0, startedAt: "",
    };
    const state = reduce(initialState, { type: "event", envelope: env({ type: "session", meta }, 0) });
    expect(state.meta?.model).toBe("gpt-4o");
    expect(state.cursor).toBe(0);
  });

  it("keeps a local error off the stream cursor", () => {
    // A fake envelope here would advance the cursor and silently swallow every
    // subsequent real event.
    let state = reduce(initialState, { type: "event", envelope: env({ type: "phase", phase: "thinking" }, 7) });
    state = reduce(state, { type: "local-error", message: "Request failed (409)" });
    expect(state.cursor).toBe(7);
    expect(state.notices[0].message).toBe("Request failed (409)");
    state = reduce(state, { type: "event", envelope: env({ type: "text", text: "still arrives" }, 8) });
    expect(state.turns[0].blocks).toEqual([{ kind: "text", text: "still arrives" }]);
  });
});

describe("reduce — context and approvals", () => {
  it("replaces the context snapshot wholesale", () => {
    const state = apply([
      { type: "context", snapshot: { windowTokens: 1000, usedTokens: 400, buckets: { retrieval: 400, files: 0, history: 0, system: 0, tools: 0 }, entries: [] } },
      { type: "context", snapshot: { windowTokens: 1000, usedTokens: 250, buckets: { retrieval: 250, files: 0, history: 0, system: 0, tools: 0 }, entries: [] } },
    ]);
    expect(state.context?.usedTokens).toBe(250);
    expect(budgetPercent(state)).toBe(25);
  });

  it("holds one pending approval and clears it on resolution", () => {
    const request = { id: "ap-1", call: { id: "t", name: "str-replace", arguments: {} }, title: "edit a.ts", preview: "", kind: "edit" as const, risk: 0.3 };
    let state = apply([{ type: "approval_request", request }]);
    expect(state.approval?.id).toBe("ap-1");
    state = apply([{ type: "approval_resolved", id: "ap-1", decision: "allow" }], state);
    expect(state.approval).toBeNull();
  });

  it("ignores a resolution for an approval it is not showing", () => {
    const request = { id: "ap-1", call: { id: "t", name: "str-replace", arguments: {} }, title: "t", preview: "", kind: "edit" as const, risk: 0.3 };
    const state = apply([
      { type: "approval_request", request },
      { type: "approval_resolved", id: "ap-other", decision: "deny" },
    ]);
    expect(state.approval?.id).toBe("ap-1");
  });

  it("accumulates usage across turns", () => {
    const state = apply([
      { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
      { type: "usage", usage: { inputTokens: 50, outputTokens: 10 } },
    ]);
    expect(state.usage).toEqual({ inputTokens: 150, outputTokens: 30 });
  });

  it("sorts evicted entries to the end of the rail", () => {
    const state = apply([{
      type: "context",
      snapshot: {
        windowTokens: 100, usedTokens: 10,
        buckets: { retrieval: 10, files: 0, history: 0, system: 0, tools: 0 },
        entries: [
          { id: "a", bucket: "retrieval", label: "a.ts", tokens: 5, pinned: false, evicted: true, turn: 1 },
          { id: "b", bucket: "retrieval", label: "b.ts", tokens: 5, pinned: false, evicted: false, turn: 1 },
        ],
      },
    }]);
    expect(railEntries(state).map(e => e.id)).toEqual(["b", "a"]);
  });
});

describe("reduce — rewind", () => {
  const checkpoint = (turn: number, hash: string, at: number) => ({
    type: "checkpoint" as const,
    checkpoint: { seq: at, hash, prev: "", short: hash.slice(0, 4), ts: "", label: `t${turn}`, turn, filesTouched: 1, restorable: true },
  });

  it("drops the turns and checkpoints the rewind undid", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "one" },
      checkpoint(1, "aaaa1111", 1),
      { type: "turn_start", turn: 2, prompt: "two" },
      checkpoint(2, "bbbb2222", 2),
      { type: "turn_start", turn: 3, prompt: "three" },
      checkpoint(3, "cccc3333", 3),
      { type: "rewound", toHash: "aaaa1111", turnsDropped: 2, filesRestored: 1 },
    ]);
    expect(state.turns.map(t => t.turn)).toEqual([1]);
    expect(state.checkpoints.map(c => c.hash)).toEqual(["aaaa1111"]);
  });

  it("leaves the transcript alone if the target is unknown", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "one" },
      { type: "rewound", toHash: "missing", turnsDropped: 1, filesRestored: 0 },
    ]);
    expect(state.turns).toHaveLength(1);
  });

  it("clears a pending approval, which cannot survive a rewind", () => {
    const request = { id: "ap-1", call: { id: "t", name: "str-replace", arguments: {} }, title: "t", preview: "", kind: "edit" as const, risk: 0.3 };
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "one" },
      checkpoint(1, "aaaa1111", 1),
      { type: "approval_request", request },
      { type: "rewound", toHash: "aaaa1111", turnsDropped: 0, filesRestored: 0 },
    ]);
    expect(state.approval).toBeNull();
  });
});

describe("reduce — notices", () => {
  it("keeps only the most recent few", () => {
    const state = apply(Array.from({ length: 8 }, (_, i) => ({ type: "notice" as const, level: "info" as const, message: `n${i}` })));
    expect(state.notices).toHaveLength(4);
    expect(state.notices[3].message).toBe("n7");
  });

  it("renders compaction and retries as notices, not transcript blocks", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "x" },
      { type: "compacted", dropped: 3, summarized: true },
      { type: "retry", attempt: 1, delayMs: 2000, reason: "rate limit" },
    ]);
    expect(state.turns[0].blocks).toEqual([]);
    expect(state.notices.map(n => n.message)).toEqual([
      "Compacted 3 messages into a context note.",
      "Retrying (rate limit) in 2.0s…",
    ]);
  });

  it("dismisses one notice by id", () => {
    let state = apply([{ type: "notice", level: "error", message: "boom" }]);
    const id = state.notices[0].id;
    state = reduce(state, { type: "dismiss-notice", id });
    expect(state.notices).toEqual([]);
  });
});

describe("phase labelling", () => {
  it("names retrieving with its query instead of a generic spinner", () => {
    const state = apply([{ type: "phase", phase: "retrieving", detail: "how does search degrade" }]);
    expect(phaseLabel(state)).toBe("retrieving · how does search degrade");
  });

  it("truncates a long detail", () => {
    const state = apply([{ type: "phase", phase: "retrieving", detail: "x".repeat(200) }]);
    expect(phaseLabel(state).length).toBeLessThan(70);
  });

  it("says what it is waiting for when an approval blocks the run", () => {
    const state = apply([{ type: "phase", phase: "awaiting-approval" }]);
    expect(phaseLabel(state)).toBe("waiting on you");
  });

  it("reports ready when idle", () => {
    expect(phaseLabel(initialState)).toBe("ready");
  });
});

describe("session metadata", () => {
  it("applies a mode change without discarding the rest of the session", () => {
    const meta = {
      id: "s1", title: "t", workspace: "/ws", provider: "openai", model: "gpt-4o",
      mode: "suggest" as const, windowTokens: 1000, indexedChunks: 5,
      searchMode: "hybrid" as const, indexFresh: true, auditing: false, turn: 0, startedAt: "",
    };
    const state = apply([{ type: "session", meta }, { type: "mode", mode: "full-auto" }]);
    expect(state.meta?.mode).toBe("full-auto");
    expect(state.meta?.model).toBe("gpt-4o");
  });

  it("records a retrieval block with its trace", () => {
    const state = apply([
      { type: "turn_start", turn: 1, prompt: "why" },
      { type: "retrieval", trace: trace({ graphAdded: 2, chunks: [] }) },
    ]);
    expect(state.turns[0].blocks[0]).toMatchObject({ kind: "retrieval" });
  });
});
