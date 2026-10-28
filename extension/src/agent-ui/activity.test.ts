import { describe, expect, it } from "vitest";
import type { Block, Turn } from "../../../src/trace/view-model";
import type { RetrievalTrace } from "../../../src/trace/protocol";
import { changedFiles, describeTool, segment, summarize, turnEdits } from "./activity";

const trace = (over: Partial<RetrievalTrace> = {}): RetrievalTrace => ({
  id: "r1", query: "auth", chunks: [], stages: [], durationMs: 12, searchMode: "hybrid",
  signals: [], graphAdded: 0, droppedChunks: 0, totalChars: 0, ...over,
});

describe("describeTool", () => {
  it("says what a call touched, not the tool's internal name", () => {
    expect(describeTool("read-file", { path: "src/a.ts", start_line: 4, end_line: 9 })).toMatchObject({
      verb: "Read", detail: "src/a.ts:4-9", open: { path: "src/a.ts", line: 4 },
    });
    expect(describeTool("codebase-retrieval", { information_request: "token refresh" }, true)).toMatchObject({
      verb: "Searching", detail: "token refresh",
    });
    expect(describeTool("run-command", { command: "npm test" })).toMatchObject({ tool: "shell", detail: "npm test" });
  });
});

describe("segment", () => {
  it("folds consecutive work into one run and keeps text and edits apart", () => {
    const blocks: Block[] = [
      { kind: "tool", id: "c1", name: "codebase-retrieval", args: { information_request: "auth" }, ok: true },
      { kind: "retrieval", trace: trace({ toolCallId: "c1" }) },
      { kind: "tool", id: "c2", name: "read-file", args: { path: "src/auth.ts" }, ok: true },
      { kind: "tool", id: "p1", name: "update-plan", ok: true },
      { kind: "text", text: "Found it." },
      { kind: "edit", edit: { id: "e1", kind: "str-replace", path: "src/auth.ts", diff: "+a\n-b" } },
    ];
    const out = segment(blocks);
    expect(out.map(s => s.kind)).toEqual(["activity", "text", "edit"]);
    const run = out[0] as Extract<(typeof out)[number], { kind: "activity" }>;
    // The ranking rides on the search that produced it; the plan tool is the plan card's.
    expect(run.items).toHaveLength(2);
    expect(run.items[0]).toMatchObject({ kind: "tool", verb: "Searched", retrieval: { toolCallId: "c1" } });
    expect(summarize(run.items)).toBe("1 search · 1 file");
  });

  it("nests a sub-agent's own work under it", () => {
    const out = segment([{
      kind: "subagent", id: "d1", task: "map callers", blocks: [
        { kind: "tool", id: "x", name: "find-symbol-references", args: { symbol: "refresh" } },
        { kind: "text", text: "Two callers." },
      ],
    }]);
    const run = out[0] as Extract<(typeof out)[number], { kind: "activity" }>;
    expect(run.items[0]).toMatchObject({ kind: "subagent", running: true, text: "Two callers.", items: [{ kind: "tool", running: true }] });
  });
});

describe("changedFiles", () => {
  it("lists a file edited twice once, with summed line counts", () => {
    const turn: Turn = {
      turn: 1, prompt: "fix", blocks: [
        { kind: "edit", edit: { id: "e1", kind: "str-replace", path: "a.ts", diff: "--- a\n+++ b\n+x\n-y" } },
        { kind: "edit", edit: { id: "e2", kind: "str-replace", path: "a.ts", diff: "+z" } },
        { kind: "edit", edit: { id: "e3", kind: "create", path: "b.ts", diff: "+1\n+2" } },
      ],
    };
    expect(changedFiles(turnEdits(turn))).toEqual([
      { path: "a.ts", kind: "str-replace", ids: ["e1", "e2"], added: 2, removed: 1 },
      { path: "b.ts", kind: "create", ids: ["e3"], added: 2, removed: 0 },
    ]);
  });
});
