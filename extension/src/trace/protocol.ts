/**
 * The wire between an agent webview (sidebar or editor tab) and the extension
 * host. Types only — imported by both sides, so it must not touch `vscode`.
 *
 * Trace envelopes cross unchanged: the webview folds them with the same
 * reducer Studio and the TUI use. Everything else is request/response RPC, plus
 * a few pushes for state only the host can see (the active editor, the model,
 * the session roster).
 */

import type { TraceEnvelope } from "../../../src/trace/protocol";

export type Surface = "sidebar" | "studio";

/** A parallel session, as the switcher shows it. */
export interface SessionRow {
  id: string;
  title: string;
  status: "starting" | "ready" | "failed" | "closed";
  workspace: string;
  branch?: string;
  error?: string;
  changedFiles: number;
  running: boolean;
  turn: number;
  active: boolean;
}

export interface HistoryRow {
  id: string;
  title: string;
  turns: number;
  updatedAt: string;
}

/** What has to happen before the agent can run, when something does. */
export interface SetupNeed {
  kind: "no-workspace" | "llm-key" | "error";
  message: string;
}

export interface HostState {
  setup: SetupNeed | null;
  provider: string;
  model: string;
  /** License plan: "free" | "pro" | "team" | "enterprise". */
  plan: string;
  /** Workspace-relative path of the active editor, when it is inside the workspace. */
  activeFile: string;
  hasSelection: boolean;
  /** Git worktree-isolated parallel sessions are available. */
  parallel: boolean;
  shellEnabled: boolean;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  contents: string;
}

export type WebviewMessage =
  | { kind: "ready"; surface: Surface }
  /** Stream a session's envelopes after `since` (0 = snapshot + full buffer). */
  | { kind: "subscribe"; sessionId: string | null; since: number }
  | { kind: "rpc"; id: number; method: string; params?: Record<string, unknown> };

export type HostMessage =
  | { kind: "rpc-result"; id: number; ok: true; value: unknown }
  | { kind: "rpc-result"; id: number; ok: false; error: string }
  | { kind: "trace"; envelope: TraceEnvelope }
  /** The session behind the stream was rebuilt or replaced: drop view state and
   *  resubscribe from zero (its sequence restarted). */
  | { kind: "reset"; sessionId: string | null }
  | { kind: "connection"; connected: boolean }
  | { kind: "sessions"; sessions: SessionRow[]; parallel: boolean }
  | { kind: "state"; state: HostState }
  /** A command put text in the composer (e.g. "Explain with context"). */
  | { kind: "compose"; text: string; send: boolean };
