import { describe, it, expect } from "vitest";
import type { SessionMeta, TraceEnvelope, TraceEvent } from "../protocol";
import { initialState, reduce, type ViewState } from "../view-model";
import { renderFrame, railVisible } from "./frame";
import { Theme, stripAnsi, width } from "./theme";

const theme = new Theme({ mono: true });
const colorTheme = new Theme({ truecolor: true });

let seq = 0;
function env(event: TraceEvent): TraceEnvelope {
  return { seq: ++seq, ts: "", sessionId: "s1", event };
}

function apply(events: TraceEvent[], from: ViewState = initialState): ViewState {
  return events.reduce((s, e) => reduce(s, { type: "event", envelope: env(e) }), from);
}

const META: SessionMeta = {
  id: "s1", title: "t", workspace: "/home/dev/open-context-engine",
  provider: "anthropic", model: "claude-opus-5", mode: "suggest",
  windowTokens: 200_000, indexedChunks: 4812, searchMode: "hybrid",
  indexFresh: true, auditing: true, turn: 0, startedAt: "",
};

const SIZE = { columns: 120, rows: 30 };

function plain(lines: string[]): string[] {
  return lines.map(stripAnsi);
}

describe("frame geometry", () => {
  it("returns exactly one line per row, each exactly the terminal width", () => {
    // This is the invariant the whole no-debris rendering strategy rests on.
    const state = apply([{ type: "session", meta: META }]);
    const lines = renderFrame(state, SIZE, theme);
    expect(lines).toHaveLength(SIZE.rows);
    for (const line of lines) expect(width(line)).toBe(SIZE.columns);
  });

  it("holds the invariant at awkward sizes", () => {
    for (const size of [{ columns: 40, rows: 10 }, { columns: 61, rows: 7 }, { columns: 200, rows: 60 }, { columns: 20, rows: 6 }]) {
      const state = apply([{ type: "session", meta: META }, { type: "turn_start", turn: 1, prompt: "x".repeat(300) }]);
      const lines = renderFrame(state, size, colorTheme);
      expect(lines.length, `rows at ${size.columns}x${size.rows}`).toBe(size.rows);
      for (const line of lines) expect(width(line), `width at ${size.columns}`).toBe(size.columns);
    }
  });

  it("keeps colour codes balanced so styling never bleeds past a row", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "why does search degrade" },
      { type: "text", text: "Because **sqlite-vec** failed to load." },
    ]);
    for (const line of renderFrame(state, SIZE, colorTheme)) {
      const opens = (line.match(/\[[0-9;]*m/g) ?? []).filter(c => c !== "[0m").length;
      const resets = (line.match(/\[0m/g) ?? []).length;
      expect(resets).toBeGreaterThanOrEqual(opens > 0 ? 1 : 0);
    }
  });
});

describe("header and status", () => {
  it("names the workspace, index and mode", () => {
    const state = apply([{ type: "session", meta: META }]);
    const header = stripAnsi(renderFrame(state, SIZE, theme)[0]);
    expect(header).toContain("trace");
    expect(header).toContain("open-context-engine");
    expect(header).toContain("4,812 chunks");
    expect(header).toContain("hybrid");
    expect(header).toContain("suggest");
  });

  it("says it is connecting before any session arrives", () => {
    expect(stripAnsi(renderFrame(initialState, SIZE, theme)[0])).toContain("connecting");
  });

  it("names the branch, so sibling sessions are distinguishable", () => {
    // Two terminals running parallel sessions look identical without this.
    const state = apply([{ type: "session", meta: { ...META, branch: "trace/fix-auth" } }]);
    expect(stripAnsi(renderFrame(state, SIZE, theme)[0])).toContain("trace/fix-auth");
  });

  it("omits the branch when there is only one session", () => {
    const state = apply([{ type: "session", meta: META }]);
    const header = stripAnsi(renderFrame(state, SIZE, theme)[0]);
    expect(header).toContain("open-context-engine");
    expect(header).not.toContain("trace/");
  });

  it("shows the model, usage, audit sha and connection in the status row", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "usage", usage: { inputTokens: 18_240, outputTokens: 1_412 } },
      { type: "checkpoint", checkpoint: { seq: 1, hash: "abcd" + "0".repeat(60), prev: "", short: "abcd", ts: "", label: "t", turn: 1, filesTouched: 1, restorable: true } },
    ]);
    const status = stripAnsi(renderFrame(reduce(state, { type: "connection", connected: true }), SIZE, theme).at(-1)!);
    expect(status).toContain("anthropic/claude-opus-5");
    expect(status).toContain("18k in");
    expect(status).toContain("1.4k out");
    expect(status).toContain("audit ✓ abcd");
    expect(status).toContain("live");
  });

  it("says offline when the stream is down", () => {
    const state = reduce(apply([{ type: "session", meta: META }]), { type: "connection", connected: false });
    expect(stripAnsi(renderFrame(state, SIZE, theme).at(-1)!)).toContain("offline");
  });
});

describe("transcript", () => {
  it("shows an empty state that says what the panel is for", () => {
    const body = plain(renderFrame(apply([{ type: "session", meta: META }]), SIZE, theme)).join("\n");
    expect(body).toContain("ranked evidence");
    expect(body).toContain("ctrl+c interrupts");
  });

  it("renders the prompt, the retrieval readout and the answer", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "why does hybrid search fall back?" },
      {
        type: "retrieval",
        trace: {
          id: "r", query: "q", durationMs: 251, searchMode: "hybrid", signals: [],
          graphAdded: 2, droppedChunks: 3, totalChars: 0, stages: [],
          chunks: [{ rank: 1, path: "src/core/retriever.ts", startLine: 118, endLine: 160, score: 0.94, via: "hybrid", preview: "", tokens: 10 }],
        },
      },
      { type: "text", text: "Because sqlite-vec failed to load." },
    ]);
    const body = plain(renderFrame(state, SIZE, theme)).join("\n");
    expect(body).toContain("why does hybrid search fall back?");
    expect(body).toContain("retrieved 1 · top 0.94 · graph +2 · 251ms");
    expect(body).toContain("−3 dropped");
    expect(body).toContain("Because sqlite-vec failed to load.");
  });

  it("warns when ranking is degraded", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "q" },
      {
        type: "retrieval",
        trace: {
          id: "r", query: "q", durationMs: 12, searchMode: "keyword-only", signals: [],
          graphAdded: 0, droppedChunks: 0, totalChars: 0, stages: [], chunks: [],
        },
      },
    ]);
    expect(plain(renderFrame(state, SIZE, theme)).join("\n")).toContain("keyword-only");
  });

  it("renders tool lines with their outcome", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "q" },
      { type: "tool_call", call: { id: "c1", name: "read-file", arguments: {} } },
      { type: "tool_result", id: "c1", name: "read-file", ok: true, ms: 221, chars: 17_000 },
    ]);
    const body = plain(renderFrame(state, SIZE, theme)).join("\n");
    expect(body).toContain("read-file");
    expect(body).toContain("221ms");
    expect(body).toContain("17,000 chars");
  });

  it("shows the live phase instead of a bare spinner", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "q" },
      { type: "phase", phase: "retrieving", detail: "how does search degrade" },
    ]);
    expect(plain(renderFrame(state, SIZE, theme)).join("\n")).toContain("retrieving · how does search degrade");
  });

  it("anchors to the newest output and scrolls back on request", () => {
    let state = apply([{ type: "session", meta: META }]);
    // Comfortably more turns than fit, so there is genuinely something to
    // scroll — otherwise this asserts nothing.
    for (let i = 1; i <= 40; i++) {
      state = apply([
        { type: "turn_start", turn: i, prompt: `question ${i}` },
        { type: "text", text: `answer ${i}` },
      ], state);
    }
    const bottom = plain(renderFrame(state, SIZE, theme)).join("\n");
    expect(bottom).toContain("question 40");
    expect(bottom).not.toContain("question 1\n");

    const scrolled = plain(renderFrame(state, SIZE, theme, { scroll: 9999 })).join("\n");
    expect(scrolled).toContain("question 1");
    expect(scrolled).not.toContain("question 40");
  });

  it("clamps scroll rather than blanking the screen", () => {
    const state = apply([{ type: "session", meta: META }, { type: "turn_start", turn: 1, prompt: "only one" }]);
    const lines = renderFrame(state, SIZE, theme, { scroll: 9999 });
    expect(lines).toHaveLength(SIZE.rows);
    expect(plain(lines).join("\n")).toContain("only one");
  });
});

describe("sub-agents", () => {
  function nested(event: TraceEvent, agentId: string): TraceEnvelope {
    return { seq: ++seq, ts: "", sessionId: "s1", agentId, event };
  }

  const running = () => {
    let state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "map the auth flow" },
      { type: "subagent_start", id: "sub-1", task: "trace login end to end" },
    ]);
    state = reduce(state, { type: "event", envelope: nested({ type: "tool_call", call: { id: "c1", name: "codebase-retrieval", arguments: {} } }, "sub-1") });
    return state;
  };

  it("shows a running delegation and what it is doing", () => {
    const body = plain(renderFrame(running(), SIZE, theme)).join("\n");
    expect(body).toContain("sub-agent");
    expect(body).toContain("trace login end to end");
    expect(body).toContain("working…");
    // The silence during a delegation is the complaint; the child's activity
    // has to be visible while it runs.
    expect(body).toContain("codebase-retrieval");
  });

  it("collapses to a summary once it finishes", () => {
    const state = apply([{ type: "subagent_end", id: "sub-1", ok: true, chars: 820, ms: 4100 }], running());
    const body = plain(renderFrame(state, SIZE, theme)).join("\n");
    expect(body).toContain("1 tool · 4.1s");
    expect(body).not.toContain("working…");
    // By now the report is what matters, not the search that produced it.
    expect(body).not.toContain("codebase-retrieval");
  });

  it("says so when a delegation failed", () => {
    const state = apply([{ type: "subagent_end", id: "sub-1", ok: false, chars: 0, ms: 900 }], running());
    expect(plain(renderFrame(state, SIZE, theme)).join("\n")).toContain("failed");
  });

  it("keeps the frame invariant with a delegation on screen", () => {
    for (const size of [{ columns: 60, rows: 12 }, { columns: 120, rows: 30 }]) {
      for (const line of renderFrame(running(), size, colorTheme)) {
        expect(width(line)).toBe(size.columns);
      }
    }
  });
});

describe("approvals", () => {
  const approval = {
    id: "ap-1",
    call: { id: "t", name: "str-replace", arguments: {} },
    title: "edit src/core/native-binding-error.ts",
    preview: ["--- a/x", "+++ b/x", "@@ -1 +1,2 @@", " const a = 1;", "-old line", "+new line"].join("\n"),
    kind: "edit" as const,
    risk: 0.34,
    callers: 3,
  };

  it("renders the diff, the blast radius and the y/a/n contract", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "edit it" },
      { type: "approval_request", request: approval },
    ]);
    const body = plain(renderFrame(state, SIZE, theme)).join("\n");
    expect(body).toContain("edit src/core/native-binding-error.ts");
    expect(body).toContain("risk 0.34");
    expect(body).toContain("3 callers");
    expect(body).toContain("-old line");
    expect(body).toContain("+new line");
    expect(body).toContain("apply?");
  });

  it("disappears once resolved", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "edit it" },
      { type: "approval_request", request: approval },
      { type: "approval_resolved", id: "ap-1", decision: "allow" },
    ]);
    expect(plain(renderFrame(state, SIZE, theme)).join("\n")).not.toContain("apply?");
  });
});

describe("evidence rail", () => {
  const withContext = () => apply([
    { type: "session", meta: META },
    { type: "turn_start", turn: 1, prompt: "q" },
    {
      type: "context",
      snapshot: {
        windowTokens: 200_000,
        usedTokens: 40_000,
        buckets: { retrieval: 20_000, files: 10_000, history: 6_000, system: 4_000, tools: 0 },
        entries: [
          { id: "a", bucket: "retrieval", label: "src/core/retriever.ts", lines: "118-160", score: 0.94, tokens: 900, pinned: true, evicted: false, turn: 1, edges: [{ kind: "called-by", label: "src/core/search.ts" }] },
          { id: "b", bucket: "retrieval", label: "src/core/embedder.ts", lines: "203-240", score: 0.38, tokens: 400, pinned: false, evicted: true, turn: 1 },
        ],
      },
    },
    { type: "plan", steps: [{ step: "Find the fallback", status: "completed" }, { step: "Explain it", status: "in_progress" }] },
  ]);

  it("shows the budget, plan, ranked chunks and their graph edges", () => {
    const body = plain(renderFrame(withContext(), SIZE, theme)).join("\n");
    expect(body).toContain("context");
    expect(body).toContain("20% of 200k");
    expect(body).toContain("retrieval 20k");
    expect(body).toContain("plan");
    expect(body).toContain("Find the fallback");
    expect(body).toContain("0.94");
    expect(body).toContain("retriever.ts:118-160");
    expect(body).toContain("called by search.ts");
  });

  it("marks pinned and evicted entries", () => {
    const body = plain(renderFrame(withContext(), SIZE, theme)).join("\n");
    expect(body).toMatch(/◆\s+retriever\.ts/);
    expect(body).toMatch(/✕\s+embedder\.ts/);
  });

  it("hides the rail when the terminal is too narrow to earn it", () => {
    expect(railVisible({ columns: 120, rows: 30 })).toBe(true);
    expect(railVisible({ columns: 80, rows: 30 })).toBe(false);
    const narrow = plain(renderFrame(withContext(), { columns: 80, rows: 30 }, theme)).join("\n");
    expect(narrow).not.toContain("in the window now");
  });

  it("opens on a narrow terminal when asked", () => {
    expect(railVisible({ columns: 80, rows: 30 }, true)).toBe(true);
    const opened = plain(renderFrame(withContext(), { columns: 80, rows: 30 }, theme, { railOpen: true })).join("\n");
    expect(opened).toContain("in the window now");
  });

  it("refuses to open the rail on a terminal that cannot fit both", () => {
    expect(railVisible({ columns: 50, rows: 20 }, true)).toBe(false);
  });
});

describe("composer", () => {
  it("prompts when empty and echoes what is typed", () => {
    const state = apply([{ type: "session", meta: META }]);
    const idle = stripAnsi(renderFrame(state, SIZE, theme).at(-2)!);
    expect(idle).toContain("ask, or @file, !shell, /command");

    const typed = stripAnsi(renderFrame(state, SIZE, theme, { input: "why does it degrade" }).at(-2)!);
    expect(typed).toContain("why does it degrade");
  });

  it("says how to interrupt while a turn runs", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "q" },
      { type: "phase", phase: "thinking" },
    ]);
    expect(stripAnsi(renderFrame(state, SIZE, theme).at(-2)!)).toContain("esc interrupts");
  });

  it("keeps the tail visible when input outruns the width", () => {
    const state = apply([{ type: "session", meta: META }]);
    const line = stripAnsi(renderFrame(state, { columns: 40, rows: 20 }, theme, { input: "a".repeat(80) + "END" }).at(-2)!);
    expect(line).toContain("END");
    expect(width(line)).toBe(40);
  });
});

describe("spine gutter", () => {
  it("prints the checkpoint sha beside its turn", () => {
    const state = apply([
      { type: "session", meta: META },
      { type: "turn_start", turn: 1, prompt: "first question" },
      { type: "checkpoint", checkpoint: { seq: 1, hash: "beef" + "0".repeat(60), prev: "", short: "beef", ts: "", label: "first", turn: 1, filesTouched: 2, restorable: true } },
    ]);
    expect(plain(renderFrame(state, SIZE, theme)).join("\n")).toContain("beef");
  });
});
