/**
 * A saved conversation, retold as trace events.
 *
 * SessionStore keeps what the MODEL needs to continue — its messages — not the
 * event stream a UI rendered. Without this, resuming a session (a reloaded VS
 * Code window, `oce trace --continue`) hands the agent its whole history while
 * the transcript on screen is empty: the user cannot see what the agent
 * remembers. Folding the messages back into events gives every surface the
 * same history through the same reducer, with no second rendering path.
 *
 * What cannot be recovered is not invented: retrieval rankings, timings, edits
 * and checkpoints were never persisted, so a replayed turn shows its prompt,
 * the answer, and which tools ran — nothing that would claim more.
 */

import type { AgentMessage } from "../agent/types";
import type { TraceEvent } from "./protocol";

export function transcriptEvents(messages: readonly AgentMessage[]): { events: TraceEvent[]; turns: number } {
  const events: TraceEvent[] = [];
  let turns = 0;
  for (const m of messages) {
    if (m.role === "user") {
      turns++;
      events.push({ type: "turn_start", turn: turns, prompt: m.content });
    } else if (m.role === "assistant") {
      if (m.content?.trim()) events.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) events.push({ type: "tool_call", call });
    } else if (m.role === "tool" && m.toolCallId) {
      events.push({
        type: "tool_result",
        id: m.toolCallId,
        name: m.toolName ?? "",
        ok: !/^error\b/i.test(m.content ?? ""),
        chars: m.content?.length ?? 0,
      });
    }
  }
  return { events, turns };
}
