/**
 * The view model — a pure fold over the TraceEvent stream, shared by every
 * renderer.
 *
 * Studio (browser) and the TUI (terminal) both reduce with this. That is what
 * keeps them from drifting: turn grouping, streamed-text coalescing, the
 * approval lifecycle, and reconnect behaviour are decided once, in one place,
 * and a discrepancy between the two surfaces would have to be a rendering bug
 * rather than a logic one.
 *
 * Free of React and of the DOM on purpose. The whole contract is
 * `(state, event) => state`, so all of the above is testable in Node — a UI bug
 * here is a failing assertion, not something you have to notice by eye.
 */

import type {
  Checkpoint, ContextSnapshot, EditProposal, PendingApproval, PlanStep, RetrievalTrace,
  RunPhase, RunStats, SessionMeta, TokenUsage, TraceEnvelope, TraceEvent,
} from "./protocol";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "retrieval"; trace: RetrievalTrace }
  | { kind: "tool"; id: string; name: string; ok?: boolean; ms?: number; chars?: number }
  | { kind: "edit"; edit: EditProposal }
  /** A delegation, with the child's own activity nested inside it. */
  | {
    kind: "subagent";
    id: string;
    task: string;
    blocks: Block[];
    done?: { ok: boolean; chars: number; ms: number };
  };

export interface Turn {
  turn: number;
  prompt: string;
  blocks: Block[];
  stats?: RunStats;
  checkpoint?: Checkpoint;
}

export interface Notice {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface ViewState {
  meta: SessionMeta | null;
  phase: RunPhase;
  phaseDetail: string;
  turns: Turn[];
  context: ContextSnapshot | null;
  checkpoints: Checkpoint[];
  plan: PlanStep[];
  approval: PendingApproval | null;
  notices: Notice[];
  usage: TokenUsage;
  /** Last seq applied — the cursor a reconnect resumes from. */
  cursor: number;
  connected: boolean;
}

export const initialState: ViewState = {
  meta: null,
  phase: "idle",
  phaseDetail: "",
  turns: [],
  context: null,
  checkpoints: [],
  plan: [],
  approval: null,
  notices: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  // -1, not 0: the session snapshot a fresh subscriber receives is numbered 0,
  // and starting at 0 would make the dedupe guard drop it.
  cursor: -1,
  connected: false,
};

export type ViewAction =
  | { type: "event"; envelope: TraceEnvelope }
  | { type: "connection"; connected: boolean }
  | { type: "dismiss-notice"; id: number }
  /** Now viewing a different session. Everything is per-session, including the
   *  cursor — carrying any of it across would splice two conversations. */
  | { type: "switch-session" }
  /** A client-side problem (a failed POST). Kept off the event path so it
   *  cannot disturb the cursor the stream depends on. */
  | { type: "local-error"; message: string };

let localNoticeId = -1;

export function reduce(state: ViewState, action: ViewAction): ViewState {
  if (action.type === "switch-session") return { ...initialState, connected: state.connected };
  if (action.type === "connection") return { ...state, connected: action.connected };
  if (action.type === "dismiss-notice") {
    return { ...state, notices: state.notices.filter(n => n.id !== action.id) };
  }
  if (action.type === "local-error") {
    return pushNotice(state, localNoticeId--, "error", action.message);
  }

  const { envelope } = action;
  // Replay can overlap what we already applied; events are idempotent by seq,
  // so dropping the duplicates is simpler and safer than deduping downstream.
  if (envelope.seq <= state.cursor) return state;
  const next = envelope.agentId
    ? applyNested(state, envelope.event, envelope.agentId)
    : applyEvent(state, envelope.event, envelope.seq);
  return { ...next, cursor: envelope.seq };
}

/**
 * Route a sub-agent's event into its delegation block.
 *
 * Nested events are folded with the SAME applyEvent, against a scratch state
 * whose only turn holds the delegation's blocks. One implementation of "what
 * does this event mean", used at both levels — a second copy would drift, and
 * the nested one would be the one nobody notices is wrong.
 */
function applyNested(state: ViewState, event: TraceEvent, agentId: string): ViewState {
  return mapLastTurn(state, turn => {
    const index = turn.blocks.findIndex(b => b.kind === "subagent" && b.id === agentId);
    // A late or orphaned nested event has nowhere sensible to go; dropping it
    // is better than inventing a delegation the session never announced.
    if (index === -1) return turn;
    const block = turn.blocks[index] as Extract<Block, { kind: "subagent" }>;
    const scratch: ViewState = { ...state, turns: [{ turn: 0, prompt: "", blocks: block.blocks }] };
    const folded = applyEvent(scratch, event, 0);
    const blocks = turn.blocks.slice();
    blocks[index] = { ...block, blocks: folded.turns[0].blocks };
    return { ...turn, blocks };
  });
}

function applyEvent(state: ViewState, event: TraceEvent, seq: number): ViewState {
  switch (event.type) {
    case "session":
      return { ...state, meta: event.meta };

    case "turn_start":
      return {
        ...state,
        turns: [...state.turns, { turn: event.turn, prompt: event.prompt, blocks: [] }],
      };

    case "phase":
      return { ...state, phase: event.phase, phaseDetail: event.detail ?? "" };

    case "text":
      // Streamed deltas coalesce into one block; a block per token would make
      // markdown rendering and text selection unusable.
      return appendBlock(state, block =>
        block?.kind === "text"
          ? { ...block, text: block.text + event.text }
          : { kind: "text", text: event.text });

    case "tool_call":
      return pushBlock(state, { kind: "tool", id: event.call.id, name: event.call.name });

    case "tool_result":
      return mapLastTurn(state, turn => ({
        ...turn,
        blocks: turn.blocks.map(b =>
          b.kind === "tool" && b.id === event.id
            ? { ...b, ok: event.ok, ms: event.ms, chars: event.chars }
            : b),
      }));

    case "retrieval":
      return pushBlock(state, { kind: "retrieval", trace: event.trace });

    case "edit":
      return pushBlock(state, { kind: "edit", edit: event.edit });

    case "subagent_start":
      return pushBlock(state, { kind: "subagent", id: event.id, task: event.task, blocks: [] });

    case "subagent_end":
      return mapLastTurn(state, turn => ({
        ...turn,
        blocks: turn.blocks.map(b =>
          b.kind === "subagent" && b.id === event.id
            ? { ...b, done: { ok: event.ok, chars: event.chars, ms: event.ms } }
            : b),
      }));

    case "context":
      return { ...state, context: event.snapshot };

    case "checkpoint":
      return {
        ...state,
        checkpoints: upsertCheckpoint(state.checkpoints, event.checkpoint),
        turns: state.turns.map(t => t.turn === event.checkpoint.turn ? { ...t, checkpoint: event.checkpoint } : t),
      };

    case "plan":
      return { ...state, plan: event.steps };

    case "approval_request":
      return { ...state, approval: event.request };

    case "approval_resolved":
      return state.approval?.id === event.id ? { ...state, approval: null } : state;

    case "usage":
      return {
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + event.usage.inputTokens,
          outputTokens: state.usage.outputTokens + event.usage.outputTokens,
        },
      };

    case "mode":
      return state.meta ? { ...state, meta: { ...state.meta, mode: event.mode } } : state;

    case "turn_end":
      return mapLastTurn(state, turn => ({ ...turn, stats: event.stats }));

    case "rewound": {
      // Drop the turns the rewind undid. The server is authoritative about how
      // far back it went, so the transcript follows rather than guessing.
      const target = state.checkpoints.find(c => c.hash === event.toHash);
      if (!target) return state;
      return {
        ...state,
        turns: state.turns.filter(t => t.turn <= target.turn),
        checkpoints: state.checkpoints.filter(c => c.seq <= target.seq),
        approval: null,
      };
    }

    case "compacted":
      return pushNotice(state, seq, "info", `Compacted ${event.dropped} message${event.dropped === 1 ? "" : "s"}${event.summarized ? " into a context note" : ""}.`);

    case "retry":
      return pushNotice(state, seq, "warn", `Retrying (${event.reason}) in ${(event.delayMs / 1000).toFixed(1)}s…`);

    case "notice":
      return pushNotice(state, seq, event.level, event.message);

    case "model":
      return pushNotice(state, seq, "info", `Routed to ${event.tier.model}.`);

    default:
      return state;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Events can arrive before any turn exists (a resumed session). Rather than
 *  drop them, open an implicit turn so nothing is invisible. */
function ensureTurn(state: ViewState): ViewState {
  if (state.turns.length) return state;
  return { ...state, turns: [{ turn: 1, prompt: "", blocks: [] }] };
}

function mapLastTurn(state: ViewState, fn: (turn: Turn) => Turn): ViewState {
  const withTurn = ensureTurn(state);
  const turns = withTurn.turns.slice();
  turns[turns.length - 1] = fn(turns[turns.length - 1]);
  return { ...withTurn, turns };
}

function pushBlock(state: ViewState, block: Block): ViewState {
  return mapLastTurn(state, turn => ({ ...turn, blocks: [...turn.blocks, block] }));
}

/** Merge into the trailing block when `fn` returns a modified one, else append. */
function appendBlock(state: ViewState, fn: (last: Block | undefined) => Block): ViewState {
  return mapLastTurn(state, turn => {
    const last = turn.blocks[turn.blocks.length - 1];
    const next = fn(last);
    if (last && next.kind === "text" && last.kind === "text") {
      return { ...turn, blocks: [...turn.blocks.slice(0, -1), next] };
    }
    return { ...turn, blocks: [...turn.blocks, next] };
  });
}

function upsertCheckpoint(list: Checkpoint[], checkpoint: Checkpoint): Checkpoint[] {
  const index = list.findIndex(c => c.hash === checkpoint.hash);
  if (index === -1) return [...list, checkpoint];
  const next = list.slice();
  next[index] = checkpoint;
  return next;
}

const MAX_NOTICES = 4;

function pushNotice(state: ViewState, id: number, level: Notice["level"], message: string): ViewState {
  return { ...state, notices: [...state.notices, { id, level, message }].slice(-MAX_NOTICES) };
}

// ─── derived ─────────────────────────────────────────────────────────────────

/** Entries the rail shows: addressable, evicted last so they read as struck out. */
export function railEntries(state: ViewState) {
  const entries = state.context?.entries ?? [];
  return [...entries].sort((a, b) => Number(a.evicted) - Number(b.evicted));
}

export function budgetPercent(state: ViewState): number {
  const ctx = state.context;
  if (!ctx || !ctx.windowTokens) return 0;
  return Math.min(100, Math.round((ctx.usedTokens / ctx.windowTokens) * 100));
}

/** Human phase label. "thinking…" is what everything else shows; the retrieving
 *  and approval states are the ones worth naming. */
export function phaseLabel(state: ViewState): string {
  switch (state.phase) {
    case "retrieving": return state.phaseDetail ? `retrieving · ${truncate(state.phaseDetail, 48)}` : "retrieving";
    case "calling-tool": return state.phaseDetail ? `${state.phaseDetail}` : "running a tool";
    case "awaiting-approval": return "waiting on you";
    case "interrupted": return "interrupted";
    case "thinking": return "thinking";
    default: return "ready";
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
