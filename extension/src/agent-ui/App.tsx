/**
 * The agent sidebar.
 *
 * State is the shared Trace reducer — the same fold Studio and the TUI use —
 * plus the few things only this surface tracks: which turn the plan belongs to,
 * per-edit undo state, and which sheet is open. Every action goes through the
 * VsCodeTransport to the TraceSession running in the extension host.
 */

import * as React from "react";
import type { ApprovalMode, TraceEnvelope } from "../../../src/trace/protocol";
import { initialState, railEntries, reduce, type ViewAction, type ViewState } from "../../../src/trace/view-model";
import { parseComposer, SLASH_COMMANDS, type SlashCommandSpec } from "../../../src/trace/composer";
import { basename } from "../../../src/trace/format";
import type { HistoryRow, HostState, SearchHit, SessionRow } from "../trace/protocol";
import type { VsCodeTransport } from "./transport";
import {
  ApprovalDock, Boundary, Composer, ContextMeter, ContextSheet, EmptyState, HistorySheet, Notices, PhaseLine, ReviewSheet,
  SearchResults, SessionBar, SetupCard, TurnView, WorktreeStrip,
  type ComposerHandle, type EditStatus, type SessionReview,
} from "./components";

const MODES: ApprovalMode[] = ["suggest", "auto-edit", "full-auto"];

/** The shared commands, minus the rail (the context sheet is its own button
 *  here), plus the ones only this surface has. */
const COMMANDS: SlashCommandSpec[] = [
  ...SLASH_COMMANDS.filter(c => c.name !== "rail" && c.name !== "sessions"),
  { name: "search", summary: "Search the index for raw snippets", arg: "query" },
  { name: "context", summary: "Show what is in the context window" },
  { name: "history", summary: "Open a saved conversation" },
  { name: "studio", summary: "Open this session in an editor tab" },
];

function matchCommands(query: string): SlashCommandSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMMANDS;
  // Name prefixes first: "/re" should offer /reset, not /compact ("free context").
  const byName = COMMANDS.filter(c => c.name.startsWith(q));
  return [...byName, ...COMMANDS.filter(c => !byName.includes(c) && c.summary.toLowerCase().includes(q))];
}

interface UiState {
  view: ViewState;
  /** The turn the current plan was last updated in. A turn that never calls
   *  update-plan must not inherit the previous turn's checklist. */
  planTurn: number;
  /** When the running turn started, for the elapsed counter. */
  turnStartedAt: number | null;
}

function uiReduce(s: UiState, action: ViewAction): UiState {
  const view = reduce(s.view, action);
  if (action.type === "switch-session") return { view, planTurn: 0, turnStartedAt: null };
  if (action.type !== "event") return view === s.view ? s : { ...s, view };
  const { event, agentId } = action.envelope;
  if (!agentId && event.type === "plan") return { ...s, view, planTurn: view.turns.at(-1)?.turn ?? 0 };
  if (!agentId && event.type === "turn_start") return { ...s, view, turnStartedAt: Date.parse(action.envelope.ts) || Date.now() };
  return view === s.view ? s : { ...s, view };
}

export function App({ transport, bindHandlers }: {
  transport: VsCodeTransport;
  /** Hands the transport this tree's dispatch (it is created before the tree). */
  bindHandlers: (h: { onEvent: (e: TraceEnvelope) => void; onConnection: (c: boolean) => void; onError: (m: string) => void; onReset: () => void }) => void;
}) {
  const [ui, dispatch] = React.useReducer(uiReduce, { view: initialState, planTurn: 0, turnStartedAt: null });
  const state = ui.view;
  const [host, setHost] = React.useState<HostState | null>(null);
  const [sessions, setSessions] = React.useState<SessionRow[]>([]);
  const [parallel, setParallel] = React.useState(false);
  const [viewedId, setViewedId] = React.useState<string | null>(null);
  const [statuses, setStatuses] = React.useState<Record<string, EditStatus>>({});
  const [sheet, setSheet] = React.useState<"context" | "history" | "review" | null>(null);
  const [history, setHistory] = React.useState<HistoryRow[] | null>(null);
  const [review, setReview] = React.useState<{ id: string; title: string; data: SessionReview | null; busy: boolean } | null>(null);
  const [search, setSearch] = React.useState<{ query: string; hits: SearchHit[] | null } | null>(null);
  const composer = React.useRef<ComposerHandle>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);

  React.useEffect(() => {
    bindHandlers({
      onEvent: envelope => dispatch({ type: "event", envelope }),
      onConnection: connected => dispatch({ type: "connection", connected }),
      onError: message => dispatch({ type: "local-error", message }),
      onReset: () => { dispatch({ type: "switch-session" }); setStatuses({}); },
    });
    transport.setHostHandlers({
      onState: setHost,
      onSessions: (rows, p) => { setSessions(rows); setParallel(p); },
      onCompose: (text, send) => { if (send) submitRef.current(text); else composer.current?.set(text); },
      onSessionChanged: id => setViewedId(id),
    });
    transport.connect();
    return () => transport.stop();
  }, [transport, bindHandlers]);

  const running = state.phase !== "idle" && state.phase !== "interrupted";
  const viewed = sessions.find(s => (viewedId ? s.id === viewedId : s.active));
  const lastTurn = state.turns.at(-1)?.turn ?? 0;

  // Follow the stream only while the reader is at the bottom.
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => { pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.turns, state.phase, search]);

  // ─── actions ─────────────────────────────────────────────────────────────

  const selectSession = React.useCallback((id: string) => {
    const current = viewedId ?? sessions.find(s => s.active)?.id;
    if (id === current) return;
    dispatch({ type: "switch-session" });
    setViewedId(id);
    setStatuses({});
    transport.switchTo(id);
  }, [sessions, transport, viewedId]);

  const createSession = React.useCallback(async (preset?: string) => {
    const title = preset ?? await transport.ask("What should the parallel session work on? It gets its own git worktree and branch.", "Fix the flaky auth test");
    if (!title?.trim()) return;
    try {
      const created = await transport.createSession(title.trim());
      if (created?.id) selectSession(created.id);
    } catch { /* surfaced as a notice */ }
  }, [selectSession, transport]);

  const openHistory = React.useCallback(() => {
    setHistory(null);
    setSheet("history");
    void transport.history().then(setHistory);
  }, [transport]);

  const openReview = React.useCallback(async (row: SessionRow) => {
    setReview({ id: row.id, title: row.title || row.branch || "session", data: null, busy: false });
    setSheet("review");
    try {
      const data = await transport.reviewSession(row.id);
      setReview(r => (r && r.id === row.id ? { ...r, data } : r));
    } catch { setSheet(null); }
  }, [transport]);

  const land = React.useCallback(async () => {
    if (!review) return;
    if (!await transport.confirm(`Land "${review.title}"? Its work is committed and merged into your current branch, and the session closes.`, "Land")) return;
    setReview(r => (r ? { ...r, busy: true } : r));
    try {
      await transport.landSession(review.id);
      setSheet(null);
      setReview(null);
      if (viewedId === review.id) { dispatch({ type: "switch-session" }); setViewedId(null); transport.switchTo(null); }
    } catch {
      setReview(r => (r ? { ...r, busy: false } : r));
    }
  }, [review, transport, viewedId]);

  const closeSession = React.useCallback(async (row: SessionRow) => {
    const message = row.changedFiles
      ? `Close "${row.title}"? Its ${row.changedFiles} changed file${row.changedFiles === 1 ? "" : "s"} stay in the worktree.`
      : `Close "${row.title}"?`;
    if (!await transport.confirm(message, "Close")) return;
    try {
      await transport.closeSession(row.id);
      if (viewedId === row.id) { dispatch({ type: "switch-session" }); setViewedId(null); transport.switchTo(null); }
    } catch { /* notice */ }
  }, [transport, viewedId]);

  const rewind = React.useCallback(async (hash: string) => {
    const target = state.checkpoints.find(c => c.hash === hash);
    const later = state.turns.filter(t => target && t.turn > target.turn).length;
    const message = later
      ? `Rewind to checkpoint ${target!.short}? This removes the ${later} later turn${later === 1 ? "" : "s"} and restores the files they changed.`
      : `Rewind to checkpoint ${target?.short}?`;
    if (await transport.confirm(message, "Rewind")) void transport.rewind(hash).catch(() => {});
  }, [state.checkpoints, state.turns, transport]);

  const toggleEdit = React.useCallback(async (id: string) => {
    try {
      const { status } = statuses[id] === "undone" ? await transport.redoEdit(id) : await transport.undoEdit(id);
      setStatuses(s => ({ ...s, [id]: status }));
    } catch { /* notice */ }
  }, [statuses, transport]);

  const setMany = React.useCallback(async (ids: string[], to: EditStatus) => {
    // Undo newest first so a file edited twice unwinds in order.
    const ordered = to === "undone" ? [...ids].reverse() : ids;
    for (const id of ordered) {
      if ((statuses[id] ?? "applied") === to) continue;
      try {
        const { status } = to === "undone" ? await transport.undoEdit(id) : await transport.redoEdit(id);
        setStatuses(s => ({ ...s, [id]: status }));
      } catch { break; }
    }
  }, [statuses, transport]);

  const cycleMode = React.useCallback(() => {
    const current = state.meta?.mode ?? "auto-edit";
    void transport.setMode(MODES[(MODES.indexOf(current) + 1) % MODES.length]).catch(() => {});
  }, [state.meta, transport]);

  const runSearch = React.useCallback((query: string) => {
    if (!query) { dispatch({ type: "local-error", message: "Usage: /search what you are looking for" }); return; }
    setSearch({ query, hits: null });
    void transport.search(query).then(hits => setSearch(s => (s?.query === query ? { query, hits } : s))).catch(() => setSearch(null));
  }, [transport]);

  /** Everything typed into the composer — parsed by the same parseComposer
   *  Studio and the TUI use, so `!npm test` and `/mode` mean one thing. */
  const submit = React.useCallback((text: string) => {
    const intent = parseComposer(text);
    switch (intent.kind) {
      case "empty": return;
      case "shell":
        if (!host?.shellEnabled) {
          dispatch({ type: "local-error", message: "Shell commands are off. Turn on openContext.agent.shell.enabled to run them (they still ask first)." });
          return;
        }
        void transport.shell(intent.command).catch(() => {});
        return;
      case "prompt":
        pinned.current = true;
        setSearch(null);
        void transport.prompt(intent.text).catch(() => {});
        return;
      case "command": {
        const { name, args } = intent;
        if (name === "compact") { void transport.compact().catch(() => {}); return; }
        if (name === "reset") { void transport.reset().catch(() => {}); return; }
        if (name === "search") { runSearch(args); return; }
        if (name === "context") { setSheet("context"); return; }
        if (name === "history") { openHistory(); return; }
        if (name === "studio") { void transport.command("studio"); return; }
        if (name === "new") { void createSession(args || undefined); return; }
        if (name === "review" || name === "land") {
          if (viewed?.branch?.startsWith("trace/")) void openReview(viewed);
          else dispatch({ type: "local-error", message: "Review and land work on a parallel session — start one with /new." });
          return;
        }
        if (name === "exit") { if (viewed?.branch?.startsWith("trace/")) void closeSession(viewed); return; }
        if (name === "mode") {
          const mode = MODES.includes(args as ApprovalMode) ? (args as ApprovalMode) : null;
          if (mode) void transport.setMode(mode).catch(() => {});
          else cycleMode();
          return;
        }
        if (name === "rewind") {
          const target = args ? state.checkpoints.find(c => c.hash.startsWith(args)) : state.checkpoints[state.checkpoints.length - 2];
          if (target) void rewind(target.hash);
          else dispatch({ type: "local-error", message: "No earlier checkpoint to rewind to." });
          return;
        }
        dispatch({ type: "local-error", message: `Unknown command /${name}` });
      }
    }
  }, [closeSession, createSession, cycleMode, host, openHistory, openReview, rewind, runSearch, state.checkpoints, transport, viewed]);
  const submitRef = React.useRef(submit);
  submitRef.current = submit;

  // Global keys: approvals answer to y/a/n while nothing is being typed.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT");
      if (e.key === "Escape" && running && !sheet) { e.preventDefault(); void transport.interrupt().catch(() => {}); return; }
      if (state.approval && !typing && !sheet && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const decision = ({ y: "allow", a: "always", n: "deny" } as Record<string, "allow" | "always" | "deny">)[e.key.toLowerCase()];
        if (decision) { e.preventDefault(); void transport.approve(state.approval.id, decision).catch(() => {}); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, sheet, state.approval, transport]);

  const cite = React.useCallback((path: string, line: number) => void transport.openFile(path, line), [transport]);
  const copy = React.useCallback((text: string) => void transport.copy(text), [transport]);
  const lookupFiles = React.useCallback((q: string) => transport.files(q), [transport]);
  const dismiss = React.useCallback((id: number) => dispatch({ type: "dismiss-notice", id }), []);

  // ─── render ──────────────────────────────────────────────────────────────

  const isWorktree = !!viewed?.branch?.startsWith("trace/");
  const setup = host?.setup ?? null;
  const workspace = state.meta ? basename(state.meta.workspace) : "";

  return (
    <div className="app" data-running={running}>
      <header className="top">
        <SessionBar sessions={sessions} viewedId={viewedId} parallel={parallel && !setup} onSelect={selectSession} onCreate={() => void createSession()} onHistory={openHistory} />
        {isWorktree && viewed && <WorktreeStrip session={viewed} onReview={() => void openReview(viewed)} onClose={() => void closeSession(viewed)} />}
        <ContextMeter context={state.context} onOpen={() => setSheet("context")} />
      </header>

      <main className="scroll" ref={scroller}>
        {setup && state.turns.length === 0
          ? <SetupCard need={setup} onAction={a => void transport.command(a === "llmKey" ? "settings" : a)} />
          : state.turns.length === 0 && !search
            ? <EmptyState workspace={workspace} onPick={prompt => submit(prompt)} />
            : state.turns.map(turn => (
              <Boundary key={turn.turn} label={`turn ${turn.turn}`}>
              <TurnView
                turn={turn}
                live={running && turn.turn === lastTurn}
                plan={turn.turn === ui.planTurn ? state.plan : null}
                isLast={turn.turn === lastTurn}
                statuses={statuses}
                onCite={cite}
                onCopy={copy}
                onOpenEdit={id => void transport.openEdit(id)}
                onToggleEdit={id => void toggleEdit(id)}
                onReview={ids => void transport.openChanges(ids, `Agent changes · turn ${turn.turn}`)}
                onUndoAll={ids => void setMany(ids, "undone")}
                onRedoAll={ids => void setMany(ids, "applied")}
                onRewind={hash => void rewind(hash)}
              />
              </Boundary>
            ))}
        {search && <SearchResults query={search.query} hits={search.hits} onCite={cite} onClose={() => setSearch(null)} />}
        <PhaseLine state={state} startedAt={ui.turnStartedAt} />
        {!state.connected && !setup && state.meta && <p className="muted small reconnect">Reconnecting to the session…</p>}
      </main>

      <footer className="dock">
        <Notices notices={state.notices} onDismiss={dismiss} />
        {state.approval && (
          <ApprovalDock approval={state.approval} onApprove={decision => void transport.approve(state.approval!.id, decision).catch(() => {})} />
        )}
        <Composer
          ref={composer}
          running={running}
          disabled={!!setup && !state.meta}
          mode={state.meta?.mode ?? "auto-edit"}
          model={state.meta?.model || host?.model || ""}
          activeFile={host?.activeFile ?? ""}
          hasSelection={!!host?.hasSelection}
          commands={matchCommands}
          onLookupFiles={lookupFiles}
          onSubmit={submit}
          onInterrupt={() => void transport.interrupt().catch(() => {})}
          onMode={mode => void transport.setMode(mode as ApprovalMode).catch(() => {})}
          onModel={() => void transport.command("settings")}
          onPickFile={() => transport.pickFile()}
        />
      </footer>

      <Boundary label="this panel">
      {sheet === "context" && (
        <ContextSheet
          context={state.context}
          entries={railEntries(state)}
          onAction={(action, id) => void transport.context(action, id).catch(() => {})}
          onCite={cite}
          onCompact={() => void transport.compact().catch(() => {})}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "history" && (
        <HistorySheet
          rows={history}
          onResume={id => { setSheet(null); void transport.resume(id).catch(() => {}); }}
          onDelete={id => { void transport.deleteHistory(id).then(() => transport.history().then(setHistory)).catch(() => {}); }}
          onNew={() => { setSheet(null); void transport.reset().catch(() => {}); }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "review" && review && (
        <ReviewSheet title={review.title} review={review.data} busy={review.busy} onLand={() => void land()} onClose={() => { setSheet(null); setReview(null); }} />
      )}
      </Boundary>
    </div>
  );
}
