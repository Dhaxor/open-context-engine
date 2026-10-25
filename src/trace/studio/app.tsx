/**
 * Studio — the workspace shell.
 *
 * Owns exactly three things: the reducer, the transport, and the keyboard. The
 * layout is three zones — spine, transcript, evidence rail — and the
 * proportions are the argument: a 44px gutter for time, the transcript taking
 * the remainder, and a 320px rail that is nearly a peer of the conversation
 * because the evidence is the point of this product.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalMode } from "../protocol";
import { parseComposer } from "../composer";
import { TraceClient } from "./client";
import { initialState, railEntries, reduce, type ViewState } from "../view-model";
import {
  Composer, EvidenceRail, Notices, ReviewPanel, SessionSwitcher, Spine, StatusBar, Transcript,
  type SessionReview, type SessionSummary,
} from "./components";
import { CommandPalette, type PaletteAction } from "./palette";

const MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];

function Studio() {
  const [state, dispatch] = React.useReducer(reduce, initialState);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [railOpen, setRailOpen] = React.useState(false);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  /** Which session THIS client is looking at, which is not the same as the
   *  server's active session — another window may be viewing a different one. */
  const [viewedId, setViewedId] = React.useState<string | null>(null);
  const [reviewing, setReviewing] = React.useState<{ id: string; title: string; review: SessionReview | null } | null>(null);
  const [landing, setLanding] = React.useState(false);

  const client = React.useMemo(() => {
    const token = TraceClient.tokenFromLocation();
    return new TraceClient(token, {
      onEvent: envelope => dispatch({ type: "event", envelope }),
      onConnectionChange: connected => dispatch({ type: "connection", connected }),
      // Surfaces in the same notice strip as server-side problems, but through
      // its own action — a fake envelope would move the stream cursor.
      onError: message => dispatch({ type: "local-error", message }),
    });
  }, []);

  React.useEffect(() => {
    client.connect();
    return () => client.stop();
  }, [client]);

  const running = state.phase !== "idle" && state.phase !== "interrupted";
  const currentTurn = state.turns[state.turns.length - 1]?.turn ?? 0;

  // The registry has no push channel — a session's own stream carries its
  // events, not the roster. Polling is the honest mechanism, and it only runs
  // while there is more than one session to watch.
  const refreshSessions = React.useCallback(async () => {
    try { setSessions((await client.sessions()).sessions); } catch { /* offline */ }
  }, [client]);

  React.useEffect(() => {
    void refreshSessions();
    if (sessions.length <= 1) return;
    const timer = setInterval(refreshSessions, 3000);
    return () => clearInterval(timer);
  }, [refreshSessions, sessions.length]);

  const selectSession = React.useCallback((id: string) => {
    if (id === viewedId) return;
    // Clear first: the new session has its own sequence, and keeping the old
    // transcript would splice two conversations into one.
    dispatch({ type: "switch-session" });
    setViewedId(id);
    client.switchTo(id);
    void refreshSessions();
  }, [client, refreshSessions, viewedId]);

  const createSession = React.useCallback(async (preset?: string) => {
    const title = preset ?? window.prompt("What is this session for?", "");
    if (title === null) return;
    try {
      const created = await client.createSession(title.trim() || "Untitled session");
      await refreshSessions();
      if (created?.id) selectSession(created.id);
    } catch { /* surfaced as a notice by the client */ }
  }, [client, refreshSessions, selectSession]);

  // The highlighted chip is what this window shows, not what the server calls
  // active — two windows can watch different sessions at the same time.
  const viewedSessions = React.useMemo(
    () => (viewedId ? sessions.map(s => ({ ...s, active: s.id === viewedId })) : sessions),
    [sessions, viewedId],
  );

  const openReview = React.useCallback(async (id: string) => {
    setReviewing({ id, title: sessions.find(s => s.id === id)?.title ?? "session", review: null });
    try {
      const review = await client.reviewSession(id);
      setReviewing(r => (r && r.id === id ? { ...r, review } : r));
    } catch {
      setReviewing(null);
    }
  }, [client, sessions]);

  const landSession = React.useCallback(async () => {
    if (!reviewing) return;
    setLanding(true);
    try {
      await client.landSession(reviewing.id);
      setReviewing(null);
      // The landed session is gone; fall back to whatever the server now
      // considers active rather than streaming from a closed one.
      if (viewedId === reviewing.id) { dispatch({ type: "switch-session" }); setViewedId(null); client.switchTo(null); }
      await refreshSessions();
    } catch { /* the error arrives as a notice */ } finally {
      setLanding(false);
    }
  }, [client, refreshSessions, reviewing, viewedId]);

  const closeSession = React.useCallback(async (id: string) => {
    // Uncommitted work in a session's worktree is kept unless it is explicitly
    // discarded; the confirm says which is about to happen.
    const target = sessions.find(s => s.id === id);
    const changed = target?.changedFiles ?? 0;
    const message = changed
      ? `Close "${target?.title}"? Its ${changed} changed file${changed === 1 ? "" : "s"} stay in the worktree.`
      : `Close "${target?.title}"?`;
    if (!window.confirm(message)) return;
    try { await client.closeSession(id); } catch { /* surfaced as a notice */ }
    await refreshSessions();
  }, [client, refreshSessions, sessions]);

  const rewind = React.useCallback((hash: string) => {
    const target = state.checkpoints.find(c => c.hash === hash);
    const turns = state.turns.filter(t => target && t.turn > target.turn).length;
    const message = turns
      ? `Rewind to ${target!.short}? This undoes ${turns} turn${turns === 1 ? "" : "s"} and the file changes they made.`
      : `Rewind to ${target?.short}?`;
    // Rewinding rewrites files. It is reversible in principle and alarming in
    // practice, so it asks — the one destructive action in the UI that does.
    if (window.confirm(message)) void client.rewind(hash).catch(() => {});
  }, [client, state.checkpoints, state.turns]);

  const cite = React.useCallback((path: string, line: number) => {
    // Nothing owns "open in editor" yet; the path is what a user actually wants
    // on the clipboard, so give them that rather than a dead click.
    void navigator.clipboard?.writeText(line ? `${path}:${line}` : path).catch(() => {});
  }, []);

  const cycleMode = React.useCallback(() => {
    const current = state.meta?.mode ?? "suggest";
    const next = MODES[(MODES.indexOf(current) + 1) % MODES.length];
    void client.setMode(next).catch(() => {});
  }, [client, state.meta]);

  const actions = React.useMemo<PaletteAction[]>(() => [
    { id: "interrupt", label: "Interrupt the current turn", hint: "esc", run: () => void client.interrupt() },
    { id: "compact", label: "Compact the conversation", keywords: "context shrink summarize", run: () => void client.compact() },
    { id: "reset", label: "Clear the conversation", keywords: "new reset", run: () => { if (window.confirm("Clear this conversation?")) void client.reset(); } },
    ...MODES.map(mode => ({
      id: `mode-${mode}`,
      label: `Approval mode: ${mode}`,
      keywords: "permissions approve",
      run: () => void client.setMode(mode),
    })),
    { id: "rail", label: "Toggle the evidence rail", run: () => setRailOpen(o => !o) },
    { id: "new-parallel", label: "New parallel session", keywords: "worktree branch fork", run: () => void createSession() },
    ...(viewedId ? [{
      id: "review",
      label: "Review this session's changes",
      keywords: "diff merge land worktree",
      run: () => void openReview(viewedId),
    }] : []),
    ...viewedSessions.filter(s => !s.active).map(s => ({
      id: `switch-${s.id}`,
      label: `Switch to: ${s.title}`,
      keywords: `session ${s.branch ?? ""}`,
      run: () => selectSession(s.id),
    })),
  ], [client, createSession, openReview, selectSession, viewedId, viewedSessions]);

  /**
   * One entry point for everything typed into the composer.
   *
   * The parser decides what it was; this only dispatches. Both surfaces route
   * through the same `parseComposer`, so `!npm test` and `/mode full-auto` mean
   * the same thing in the browser and the terminal.
   */
  const submitComposer = React.useCallback((text: string) => {
    const intent = parseComposer(text);
    switch (intent.kind) {
      case "empty":
        return;
      case "shell":
        void client.shell(intent.command).catch(() => {});
        return;
      case "prompt":
        void client.prompt(intent.text).catch(() => {});
        return;
      case "command": {
        const { name, args } = intent;
        if (name === "compact") { void client.compact().catch(() => {}); return; }
        if (name === "reset") { void client.reset().catch(() => {}); return; }
        if (name === "rail") { setRailOpen(o => !o); return; }
        if (name === "sessions") { void refreshSessions(); setPaletteOpen(true); return; }
        if (name === "review" || name === "land") {
          if (viewedId) void openReview(viewedId);
          else dispatch({ type: "local-error", message: "Switch to a parallel session first." });
          return;
        }
        if (name === "new") { void createSession(args); return; }
        if (name === "mode") {
          const mode = MODES.includes(args as ApprovalMode) ? (args as ApprovalMode) : null;
          if (mode) void client.setMode(mode).catch(() => {});
          else cycleMode();
          return;
        }
        if (name === "rewind") {
          const target = args
            ? state.checkpoints.find(c => c.hash.startsWith(args))
            : state.checkpoints[state.checkpoints.length - 2];
          if (target) rewind(target.hash);
          return;
        }
        if (name === "exit") {
          const id = viewedId;
          if (id) void closeSession(id);
          return;
        }
        dispatch({ type: "local-error", message: `Unknown command /${name}` });
      }
    }
  }, [client, createSession, closeSession, cycleMode, refreshSessions, rewind, state.checkpoints, viewedId]);

  // Desktop menu and deep-link actions arrive as ordinary DOM events (see
  // desktop/preload.js). In a browser they simply never fire, so Studio needs
  // no notion of whether it is running inside a shell.
  React.useEffect(() => {
    const handlers: Record<string, (e: Event) => void> = {
      "trace:command-palette": () => setPaletteOpen(o => !o),
      "trace:toggle-rail": () => setRailOpen(o => !o),
      "trace:interrupt": () => void client.interrupt().catch(() => {}),
      "trace:new-session": () => void client.reset().catch(() => {}),
      "trace:rewind": (e) => {
        const hash = (e as CustomEvent<string>).detail;
        if (hash) void client.rewind(hash).catch(() => {});
      },
    };
    for (const [channel, fn] of Object.entries(handlers)) window.addEventListener(channel, fn);
    return () => {
      for (const [channel, fn] of Object.entries(handlers)) window.removeEventListener(channel, fn);
    };
  }, [client]);

  // Global keys. Approval shortcuts only bind while an approval is pending, so
  // y/a/n never steal a keystroke from the composer.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement
        && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT");

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(o => !o);
        return;
      }
      if (e.key === "Escape" && running && !paletteOpen) {
        e.preventDefault();
        void client.interrupt();
        return;
      }
      if (state.approval && !typing && !paletteOpen) {
        const decision = { y: "allow", a: "always", n: "deny" }[e.key.toLowerCase()];
        if (decision) {
          e.preventDefault();
          void client.approve(state.approval.id, decision as "allow" | "always" | "deny");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client, running, state.approval, paletteOpen]);

  return (
    <div className="shell">
      <Spine checkpoints={state.checkpoints} currentTurn={currentTurn} onRewind={rewind}>
        <SessionSwitcher
          sessions={viewedSessions}
          onSelect={selectSession}
          onCreate={() => void createSession()}
          onClose={id => void closeSession(id)}
        />
      </Spine>

      <div className="main">
        {!state.connected && <div className="reconnecting">Reconnecting — the session is intact and will resume where it left off.</div>}
        <Transcript
          state={state}
          onCite={cite}
          onApprove={(id, decision) => void client.approve(id, decision).catch(() => {})}
        />
        <Composer
          running={running}
          disabled={running}
          onSubmit={submitComposer}
          onInterrupt={() => void client.interrupt()}
          onLookupFiles={q => client.files(q)}
        />
      </div>

      <EvidenceRail
        open={railOpen}
        context={state.context}
        entries={railEntries(state)}
        plan={state.plan}
        onContext={(action, id) => void client.context(action, id).catch(() => {})}
        onCite={cite}
      />

      <StatusBar
        state={state}
        onCycleMode={cycleMode}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleRail={() => setRailOpen(o => !o)}
      />
      {reviewing && (
        <ReviewPanel
          title={reviewing.title}
          review={reviewing.review}
          busy={landing}
          onLand={() => void landSession()}
          onClose={() => setReviewing(null)}
        />
      )}
      <Notices notices={state.notices} onDismiss={id => dispatch({ type: "dismiss-notice", id })} />
      <CommandPalette open={paletteOpen} actions={actions} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

export function mount(container: HTMLElement): void {
  createRoot(container).render(<Studio />);
}

export type { ViewState };
