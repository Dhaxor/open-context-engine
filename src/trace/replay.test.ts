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
