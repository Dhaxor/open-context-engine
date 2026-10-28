/**
 * What a Trace front end needs from whatever carries its events and commands.
 *
 * Studio in a browser talks to `oce trace` over HTTP + EventSource (client.ts).
 * The VS Code extension runs the very same TraceSession in its extension host
 * and carries the same envelopes over webview postMessage. Both are this
 * interface, so a surface never knows — or cares — which wire it is on.
 */

import type { ApprovalDecision, ApprovalMode, TraceEnvelope } from "../protocol";

export interface TraceTransportHandlers {
  onEvent: (envelope: TraceEnvelope) => void;
  onConnectionChange: (connected: boolean) => void;
  onError?: (message: string) => void;
  /** The session behind the stream was replaced (a rebuilt or new conversation)
   *  and its sequence restarted: drop view state before the replay arrives. */
  onReset?: () => void;
}

export type ContextAction = "pin" | "unpin" | "evict" | "restore";

export interface TraceTransport {
  connect(): void;
  stop(): void;
  /** Point at a different session (null = the host's active one). The cursor
   *  resets: each session numbers its own events. */
  switchTo(sessionId: string | null): void;
  getSessionId(): string | null;

  sessions(): Promise<{ sessions: any[]; parallel: boolean }>;
  createSession(title: string): Promise<any>;
  reviewSession(id: string): Promise<any>;
  landSession(id: string): Promise<any>;
  closeSession(id: string, discardChanges?: boolean): Promise<any>;

  files(query: string): Promise<string[]>;
  prompt(text: string): Promise<any>;
  shell(command: string): Promise<any>;
  mention(paths: string[]): Promise<any>;
  interrupt(): Promise<any>;
  approve(id: string, decision: ApprovalDecision): Promise<any>;
  setMode(mode: ApprovalMode): Promise<any>;
  compact(): Promise<any>;
  reset(): Promise<any>;
  rewind(hash: string): Promise<any>;
  context(action: ContextAction, entryId: string): Promise<any>;
}

/**
 * The few things a surface has to ask of its container rather than do itself.
 *
 * A browser tab can `window.confirm` and has a clipboard; a VS Code webview can
 * do neither (both are silently unavailable there) but can open a file at a
 * line, which is what a citation should do. Defaults are the browser's.
 */
export interface StudioHost {
  confirm(message: string): Promise<boolean>;
  ask(message: string, placeholder?: string): Promise<string | null>;
  /** A `path:line` citation was clicked. */
  openFile(path: string, line: number): void;
}

export const browserHost: StudioHost = {
  confirm: async message => window.confirm(message),
  ask: async (message, placeholder = "") => window.prompt(message, placeholder),
  // Nothing owns "open in editor" in a browser; the path is what a user
  // actually wants on the clipboard, so give them that rather than a dead click.
  openFile: (path, line) => {
    void navigator.clipboard?.writeText(line ? `${path}:${line}` : path).catch(() => {});
  },
};
