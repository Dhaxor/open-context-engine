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
 * Checkpoints are saved beside the conversation (SessionStore's timeline), so
 * each turn's edits and its checkpoint are retold where the turn ends — the
 * changes tray, per-edit undo, and "Rewind here" come back with it. What was
 * never persisted is not invented: retrieval rankings and timings are gone, so
 * a replayed turn shows its prompt, the answer, which tools ran, and what it
 * changed — nothing that would claim more.
 */

import type { AgentMessage } from "../agent/types";
import type { CheckpointRecord } from "./checkpoints";
import type { TraceEvent } from "./protocol";

export interface ReplayOptions {
  /** Turns that came before the first remaining user message — compaction
   *  summarised them away — so replayed turns keep their original numbers and
   *  line up with the checkpoints saved under those numbers. */
  turnOffset?: number;
  checkpoints?: readonly CheckpointRecord[];
}

export function transcriptEvents(messages: readonly AgentMessage[], opts: ReplayOptions = {}): { events: TraceEvent[]; turns: number } {
  const events: TraceEvent[] = [];
  const offset = Math.max(0, opts.turnOffset ?? 0);
  const byTurn = new Map<number, CheckpointRecord>();
  for (const c of opts.checkpoints ?? []) byTurn.set(c.turn, c);
  let turns = 0;
  const closeTurn = () => {
    const record = turns ? byTurn.get(offset + turns) : undefined;
    if (!record) return;
    const { edits, ...checkpoint } = record;
    for (const edit of edits) events.push({ type: "edit", edit });
    events.push({ type: "checkpoint", checkpoint });
  };
  for (const m of messages) {
    if (m.role === "user") {
      closeTurn();
      turns++;
      events.push({ type: "turn_start", turn: offset + turns, prompt: m.content });
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
  closeTurn();
  return { events, turns };
}
