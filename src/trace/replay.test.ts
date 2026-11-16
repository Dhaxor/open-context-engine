import { describe, it, expect } from "vitest";
import type { AgentMessage } from "../agent/types";
import { transcriptEvents } from "./replay";
import { initialState, reduce } from "./view-model";

const messages: AgentMessage[] = [
  { role: "user", content: "where is auth?" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "codebase-retrieval", arguments: { information_request: "auth" } }] },
  { role: "tool", content: "src/auth.ts:1-20 ...", toolCallId: "c1", toolName: "codebase-retrieval" },
  { role: "assistant", content: "In `src/auth.ts:4`." },
  { role: "user", content: "and tests?" },
  { role: "assistant", content: "None yet." },
];

describe("transcriptEvents", () => {
  it("retells saved messages as turns the shared reducer can render", () => {
    const { events, turns } = transcriptEvents(messages);
    expect(turns).toBe(2);
    const state = events.reduce(
      (s, event, i) => reduce(s, { type: "event", envelope: { seq: i + 1, ts: "", sessionId: "s", event } }),
      initialState,
    );
    expect(state.turns.map(t => t.prompt)).toEqual(["where is auth?", "and tests?"]);
    expect(state.turns[0].blocks).toMatchObject([
      { kind: "tool", id: "c1", name: "codebase-retrieval", ok: true },
      { kind: "text", text: "In `src/auth.ts:4`." },
    ]);
    expect(state.turns[1].blocks).toEqual([{ kind: "text", text: "None yet." }]);
  });

  it("marks a tool result that reported an error as failed", () => {
    const { events } = transcriptEvents([
      { role: "user", content: "read it" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read-file", arguments: { path: "x" } }] },
      { role: "tool", content: "Error: no such file", toolCallId: "c1", toolName: "read-file" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "tool_result", ok: false });
  });
});

describe("transcriptEvents with a saved timeline", () => {
  const checkpoint = (turn: number, edits: any[] = []) => ({
    seq: turn, hash: `h${turn}`, prev: "", short: `h${turn}`, ts: "", label: `t${turn}`, turn,
    filesTouched: edits.length, restorable: edits.length > 0, edits,
  });

  it("retells each turn's edits and checkpoint where that turn ends", () => {
    const e = { id: "e1", kind: "create" as const, path: "new.ts", newContents: "x", diff: "+x" };
    const { events } = transcriptEvents(messages, { checkpoints: [checkpoint(1), checkpoint(2, [e])] });
    const state = events.reduce(
      (s, event, i) => reduce(s, { type: "event", envelope: { seq: i + 1, ts: "", sessionId: "s", event } }),
      initialState,
    );
    expect(state.turns[0].checkpoint?.hash).toBe("h1");
    expect(state.turns[1].blocks.at(-1)).toMatchObject({ kind: "edit", edit: { path: "new.ts" } });
    expect(state.turns[1].checkpoint).toMatchObject({ hash: "h2", restorable: true });
    expect(state.checkpoints.map(c => c.hash)).toEqual(["h1", "h2"]);
  });

  it("numbers turns after the ones compaction removed, so they meet their checkpoints", () => {
    const { events, turns } = transcriptEvents(messages, { turnOffset: 5, checkpoints: [checkpoint(7)] });
    expect(turns).toBe(2);
    expect(events.filter(e => e.type === "turn_start").map(e => (e as any).turn)).toEqual([6, 7]);
    expect(events.filter(e => e.type === "checkpoint")).toHaveLength(1);
  });
});
