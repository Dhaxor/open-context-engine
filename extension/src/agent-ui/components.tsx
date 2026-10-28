/**
 * The agent sidebar's presentational layer. Data and callbacks in, markup out —
 * state lives in the shared reducer (src/trace/view-model.ts), transport in
 * transport.ts. Model output is rendered from a parsed structure, never as HTML.
 */

import * as React from "react";
import type {
  ContextEntry, ContextSnapshot, EditProposal, PendingApproval, PlanStep, RetrievalTrace,
} from "../../../src/trace/protocol";
import type { Notice, Turn, ViewState } from "../../../src/trace/view-model";
import { phaseLabel } from "../../../src/trace/view-model";
import { parseMarkdown, type MdBlock, type MdNode } from "../../../src/trace/markdown";
import { activeToken, applyCompletion, type ActiveToken, type SlashCommandSpec } from "../../../src/trace/composer";
import { basename, budgetSegments, duration, edgeLabel, parseDiff, score, tokens, truncate } from "../../../src/trace/format";
import type { HistoryRow, SearchHit, SessionRow, SetupNeed } from "../trace/protocol";
import { changedFiles, currentStep, segment, summarize, turnEdits, type ActivityItem, type SubagentItem, type ToolItem } from "./activity";
import { Icon, Spinner, type IconName } from "./icons";

type Cite = (path: string, line: number) => void;
export type EditStatus = "applied" | "undone";

/**
 * One view that throws on unexpected data must not blank the whole agent — the
 * conversation, the composer, and the Stop button stay usable around it.
 */
export class Boundary extends React.Component<{ label: string; children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) { return { error: String((err as Error)?.message ?? err) }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice" data-level="error">
        <Icon name="warning" />
        <span>Couldn't show {this.props.label}: {this.state.error}</span>
        <button type="button" className="link-btn" onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}

// ─── header ──────────────────────────────────────────────────────────────────

export function SessionBar({ sessions, viewedId, parallel, onSelect, onCreate, onHistory }: {
  sessions: SessionRow[];
  viewedId: string | null;
  parallel: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onHistory: () => void;
}) {
  const current = viewedId ?? sessions.find(s => s.active)?.id ?? null;
  return (
    <div className="sessionbar" role="tablist" aria-label="Agent sessions">
      <div className="tabs">
        {sessions.map(s => (
          <button
            key={s.id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={s.id === current}
            data-status={s.status}
            title={`${s.title}${s.branch ? ` · ${s.branch}` : ""}${s.error ? ` · ${s.error}` : ""}${s.changedFiles ? ` · ${s.changedFiles} changed` : ""}`}
            onClick={() => onSelect(s.id)}
          >
            {s.status === "starting" || s.running ? <Spinner /> : s.status === "failed" ? <Icon name="warning" /> : s.branch && !s.branch.startsWith("trace/") ? <Icon name="branch" /> : <Icon name="robot" />}
            <span className="tab-title">{tabTitle(s)}</span>
            {s.changedFiles > 0 && <span className="count">{s.changedFiles}</span>}
          </button>
        ))}
      </div>
      {parallel && (
        <button type="button" className="icon-btn" title="New parallel session in its own git worktree" aria-label="New parallel session" onClick={onCreate}>
          <Icon name="add" />
        </button>
      )}
      <button type="button" className="icon-btn" title="Conversation history" aria-label="Conversation history" onClick={onHistory}>
        <Icon name="history" />
      </button>
    </div>
  );
}

function tabTitle(s: SessionRow): string {
  return s.title || s.branch?.replace(/^trace\//, "") || "session";
}

/** A worktree session's own strip: where it runs, what it changed, how to land it. */
export function WorktreeStrip({ session, onReview, onClose }: {
  session: SessionRow;
  onReview: () => void;
  onClose: () => void;
}) {
  return (
    <div className="worktree-strip">
      <Icon name="branch" />
      <span className="mono truncate" title={session.workspace}>{session.branch}</span>
      <span className="muted">{session.changedFiles ? `${session.changedFiles} changed` : "no changes yet"}</span>
      <span className="spacer" />
      <button type="button" className="link-btn" onClick={onReview}>Review and land</button>
      <button type="button" className="icon-btn" title="Close this session" aria-label="Close this session" onClick={onClose}><Icon name="close" /></button>
    </div>
  );
}

export function ContextMeter({ context, onOpen }: { context: ContextSnapshot | null; onOpen: () => void }) {
  if (!context || !context.windowTokens) return null;
  const percent = Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100));
  const segments = budgetSegments(context);
  const level = percent >= 85 ? "high" : percent >= 60 ? "mid" : "low";
  return (
    <button type="button" className="meter" data-level={level} onClick={onOpen} title={`${segments.map(s => `${s.bucket} ${tokens(s.tokens)}`).join(" · ")} — click to see what is in the window`}>
      <span className="meter-bar" aria-hidden="true">
        {segments.map(s => (
          <i key={s.bucket} className={`b-${s.bucket}`} style={{ width: `${(s.tokens / context.windowTokens) * 100}%` }} />
        ))}
      </span>
      <span className="meter-label">{percent}% of {tokens(context.windowTokens)} context</span>
    </button>
  );
}

// ─── transcript ──────────────────────────────────────────────────────────────

export function TurnView({ turn, live, plan, isLast, statuses, onCite, onOpenEdit, onToggleEdit, onReview, onUndoAll, onRedoAll, onRewind, onCopy }: {
  turn: Turn;
  /** This turn is the one running now. */
  live: boolean;
  plan: PlanStep[] | null;
  isLast: boolean;
  statuses: Record<string, EditStatus>;
  onCite: Cite;
  onOpenEdit: (id: string) => void;
  onToggleEdit: (id: string) => void;
  onReview: (ids: string[]) => void;
  onUndoAll: (ids: string[]) => void;
  onRedoAll: (ids: string[]) => void;
  onRewind: (hash: string) => void;
  onCopy: (text: string) => void;
}) {
  const segments = React.useMemo(() => segment(turn.blocks), [turn.blocks]);
  const edits = React.useMemo(() => turnEdits(turn), [turn]);
  const lastActivity = segments.map(s => s.kind).lastIndexOf("activity");
  const answer = segments.filter(s => s.kind === "text").map(s => (s as { text: string }).text).join("\n\n");
  return (
    <article className="turn" data-live={live}>
      {turn.prompt && (
        <div className="prompt">
          <p>{turn.prompt}</p>
        </div>
      )}
      {plan && plan.length > 0 && <PlanCard steps={plan} />}
      {segments.map((s, i) => {
        if (s.kind === "activity") return <ActivityRun key={i} items={s.items} live={live && i === lastActivity} onCite={onCite} />;
        if (s.kind === "text") return <Markdown key={i} text={s.text} onCite={onCite} onCopy={onCopy} />;
        return <EditRow key={i} edit={s.edit} status={statuses[s.edit.id] ?? "applied"} onOpen={() => onOpenEdit(s.edit.id)} onToggle={() => onToggleEdit(s.edit.id)} />;
      })}
      {!live && edits.length > 0 && (
        <ChangesTray edits={edits} statuses={statuses} onCite={onCite} onReview={onReview} onUndoAll={onUndoAll} onRedoAll={onRedoAll} />
      )}
      {!live && (turn.stats || turn.checkpoint) && (
        <footer className="turn-foot">
          {turn.stats && (
            <span title={`${tokens(turn.stats.usage.inputTokens)} in · ${tokens(turn.stats.usage.outputTokens)} out · ${turn.stats.llmCalls} model calls`}>
              {duration(turn.stats.durationMs)} · {turn.stats.steps} step{turn.stats.steps === 1 ? "" : "s"} · {turn.stats.toolCalls} tool{turn.stats.toolCalls === 1 ? "" : "s"} · {tokens(turn.stats.usage.inputTokens + turn.stats.usage.outputTokens)} tokens
            </span>
          )}
          <span className="spacer" />
          {answer && (
            <button type="button" className="icon-btn" title="Copy answer" aria-label="Copy answer" onClick={() => onCopy(answer)}><Icon name="copy" /></button>
          )}
          {turn.checkpoint?.restorable && !isLast && (
            <button type="button" className="link-btn" title={`Checkpoint ${turn.checkpoint.short}: undo every later turn and the file changes they made`} onClick={() => onRewind(turn.checkpoint!.hash)}>
              <Icon name="rewind" /> Rewind here
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

export function PlanCard({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter(s => s.status === "completed").length;
  return (
    <section className="card plan" aria-label="Plan">
      <header className="card-head">
        <span className="label">Plan</span>
        <span className="muted">{done}/{steps.length}</span>
      </header>
      <ol>
        {steps.map((s, i) => (
          <li key={i} data-status={s.status}>
            {s.status === "completed" ? <Icon name="check" className="ok" /> : s.status === "in_progress" ? <Spinner /> : <Icon name="circle" className="muted" />}
            <span>{s.step}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * A run of tool work. Open while it runs, so you can watch what the agent is
 * doing; collapsed to one summary line once the turn moves on.
 */
function ActivityRun({ items, live, onCite }: { items: ActivityItem[]; live: boolean; onCite: Cite }) {
  const [open, setOpen] = React.useState<boolean | null>(null);
  const expanded = open ?? live;
  const running = items.some(i => i.kind !== "retrieval" && i.running);
  const failed = items.filter(i => i.kind === "tool" && i.ok === false).length;
  const current = currentStep(items);
  const headline = running && current
    ? current.kind === "subagent" ? `Sub-agent: ${truncate(current.task, 60)}` : `${current.verb} ${current.detail}`
    : summarize(items);
  return (
    <section className="activity" data-open={expanded}>
      <button type="button" className="activity-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        {running ? <Spinner /> : failed ? <Icon name="warning" className="warn" /> : <Icon name="check" className="ok" />}
        <span className="truncate">{headline || "Working"}</span>
        {failed > 0 && !running && <span className="warn">{failed} failed</span>}
        <Icon name="chevron" className="chev" />
      </button>
      {expanded && (
        <div className="activity-body">
          {items.map((item, i) => <ActivityRow key={i} item={item} onCite={onCite} />)}
        </div>
      )}
    </section>
  );
}

function ActivityRow({ item, onCite }: { item: ActivityItem; onCite: Cite }) {
  if (item.kind === "retrieval") return <RetrievalRow trace={item.trace} onCite={onCite} />;
  if (item.kind === "subagent") return <SubagentRow item={item} onCite={onCite} />;
  return <ToolRow item={item} onCite={onCite} />;
}

function ToolRow({ item, onCite }: { item: ToolItem; onCite: Cite }) {
  const [open, setOpen] = React.useState(false);
  const expandable = !!item.retrieval?.chunks.length || !!item.result;
  const status = item.running ? <Spinner /> : item.ok === false ? <Icon name="warning" className="warn" /> : <Icon name={item.icon} className="muted" />;
  return (
    <div className="row" data-failed={item.ok === false}>
      <div className="row-line">
        {status}
        <span className="verb">{item.verb}</span>
        {item.open
          ? <button type="button" className="detail mono link" title={item.detail} onClick={() => onCite(item.open!.path, item.open!.line)}>{item.detail}</button>
          : <span className="detail mono" title={item.detail}>{item.detail}</span>}
        <span className="spacer" />
        {item.retrieval && <span className="muted nowrap">{item.retrieval.chunks.length} chunks</span>}
        {item.ms !== undefined && !item.retrieval && <span className="muted nowrap">{duration(item.ms)}</span>}
        {expandable && (
          <button type="button" className="icon-btn small" aria-expanded={open} aria-label={open ? "Hide details" : "Show details"} onClick={() => setOpen(o => !o)}>
            <Icon name="chevron" className={open ? "chev open" : "chev"} />
          </button>
        )}
      </div>
      {open && item.retrieval && <ChunkList trace={item.retrieval} onCite={onCite} />}
      {open && item.result && <pre className="output">{truncate(item.result, 4000)}</pre>}
    </div>
  );
}

function RetrievalRow({ trace, onCite }: { trace: RetrievalTrace; onCite: Cite }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="row">
      <div className="row-line">
        <Icon name="search" className="muted" />
        <span className="verb">Retrieved</span>
        <span className="detail mono">{truncate(trace.query, 60)}</span>
        <span className="spacer" />
        <span className="muted nowrap">{trace.chunks.length} chunks</span>
        <button type="button" className="icon-btn small" aria-expanded={open} aria-label="Show ranking" onClick={() => setOpen(o => !o)}>
          <Icon name="chevron" className={open ? "chev open" : "chev"} />
        </button>
      </div>
      {open && <ChunkList trace={trace} onCite={onCite} />}
    </div>
  );
}

/** Why each chunk is here: its score and how it was found. */
function ChunkList({ trace, onCite }: { trace: RetrievalTrace; onCite: Cite }) {
  return (
    <div className="chunks">
      {trace.searchMode === "keyword-only" && <p className="muted small">Keyword-only ranking — semantic search is unavailable.</p>}
      {trace.chunks.slice(0, 12).map(c => (
        <button key={`${c.path}:${c.startLine}`} type="button" className="chunk" title={c.preview} onClick={() => onCite(c.path, c.startLine)}>
          <span className="score mono">{score(c.score)}</span>
          <span className="mono truncate">{c.path}:{c.startLine}-{c.endLine}</span>
          <span className={`via via-${c.via}`}>{c.edges?.length ? edgeLabel(c.edges[0]) : c.via}</span>
        </button>
      ))}
      {trace.chunks.length > 12 && <p className="muted small">+{trace.chunks.length - 12} more</p>}
      {trace.droppedChunks > 0 && <p className="muted small">{trace.droppedChunks} dropped to fit the budget</p>}
    </div>
  );
}

function SubagentRow({ item, onCite }: { item: SubagentItem; onCite: Cite }) {
  const [open, setOpen] = React.useState<boolean | null>(null);
  const expanded = open ?? item.running;
  return (
    <div className="row subagent">
      <button type="button" className="row-line" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        {item.running ? <Spinner /> : item.ok === false ? <Icon name="warning" className="warn" /> : <Icon name="robot" className="muted" />}
        <span className="verb">Sub-agent</span>
        <span className="detail" title={item.task}>{item.task}</span>
        <span className="spacer" />
        <span className="muted nowrap">{item.running ? `${item.items.length} steps` : `${item.items.length} steps · ${duration(item.ms)}`}</span>
        <Icon name="chevron" className={expanded ? "chev open" : "chev"} />
      </button>
      {expanded && (
        <div className="nested">
          {item.items.length === 0 && <p className="muted small">Starting…</p>}
          {item.items.map((child, i) => <ActivityRow key={i} item={child} onCite={onCite} />)}
          {item.text && !item.running && <p className="muted small report">{truncate(item.text, 400)}</p>}
        </div>
      )}
    </div>
  );
}

function EditRow({ edit, status, onOpen, onToggle }: { edit: EditProposal; status: EditStatus; onOpen: () => void; onToggle: () => void }) {
  const { added, removed } = changedFiles([edit])[0];
  const icon: IconName = edit.kind === "create" ? "plus" : edit.kind === "remove" ? "trash" : "edit";
  const verb = edit.kind === "create" ? "Created" : edit.kind === "remove" ? "Deleted" : "Edited";
  return (
    <div className="edit-row" data-undone={status === "undone"}>
      <Icon name={icon} className="muted" />
      <span className="verb">{status === "undone" ? "Reverted" : verb}</span>
      <button type="button" className="detail mono link" title="Open the diff" onClick={onOpen}>{edit.path}</button>
      <span className="spacer" />
      <span className="stat"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
      <button type="button" className="icon-btn small" title={status === "undone" ? "Redo this edit" : "Undo this edit"} aria-label={status === "undone" ? "Redo" : "Undo"} onClick={onToggle}>
        <Icon name={status === "undone" ? "redo" : "undo"} />
      </button>
    </div>
  );
}

function ChangesTray({ edits, statuses, onCite, onReview, onUndoAll, onRedoAll }: {
  edits: EditProposal[];
  statuses: Record<string, EditStatus>;
  onCite: Cite;
  onReview: (ids: string[]) => void;
  onUndoAll: (ids: string[]) => void;
  onRedoAll: (ids: string[]) => void;
}) {
  const files = changedFiles(edits);
  const ids = edits.map(e => e.id);
  const allUndone = ids.every(id => statuses[id] === "undone");
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <section className="card changes" aria-label="Changes this turn">
      <header className="card-head">
        <span className="label">{allUndone ? "Reverted" : `${files.length} file${files.length === 1 ? "" : "s"} changed`}</span>
        <span className="stat"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>
      </header>
      <ul>
        {files.map(f => (
          <li key={f.path} data-undone={f.ids.every(id => statuses[id] === "undone")}>
            <Icon name={f.kind === "create" ? "plus" : f.kind === "remove" ? "trash" : "file"} className="muted" />
            <button type="button" className="mono link truncate" onClick={() => onCite(f.path, 0)}>{f.path}</button>
            <span className="spacer" />
            <span className="stat muted"><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span></span>
          </li>
        ))}
      </ul>
      <footer className="card-actions">
        <button type="button" className="btn" onClick={() => onReview(ids)}><Icon name="diff" /> Review</button>
        {allUndone
          ? <button type="button" className="btn secondary" onClick={() => onRedoAll(ids)}><Icon name="redo" /> Reapply</button>
          : <button type="button" className="btn secondary" onClick={() => onUndoAll(ids)}><Icon name="undo" /> Undo all</button>}
      </footer>
    </section>
  );
}

// ─── markdown ────────────────────────────────────────────────────────────────

export function Markdown({ text, onCite, onCopy }: { text: string; onCite: Cite; onCopy: (t: string) => void }) {
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  return <div className="answer">{blocks.map((b, i) => <MdBlockView key={i} block={b} onCite={onCite} onCopy={onCopy} />)}</div>;
}

function MdBlockView({ block, onCite, onCopy }: { block: MdBlock; onCite: Cite; onCopy: (t: string) => void }) {
  switch (block.kind) {
    case "heading": return <h3><Inline nodes={block.nodes} onCite={onCite} /></h3>;
    case "list": return <ul>{block.items.map((nodes, i) => <li key={i}><Inline nodes={nodes} onCite={onCite} /></li>)}</ul>;
    case "paragraph": return <p><Inline nodes={block.nodes} onCite={onCite} /></p>;
    case "fence":
      return (
        <div className="fence">
          <div className="fence-head">
            {block.path
              ? <button type="button" className="mono link" onClick={() => onCite(block.path, 0)}>{block.path}</button>
              : <span className="mono muted">{block.lang || "code"}</span>}
            <span className="spacer" />
            <button type="button" className="icon-btn small" title="Copy" aria-label="Copy code" onClick={() => onCopy(block.code)}><Icon name="copy" /></button>
          </div>
          <pre><code>{block.code}</code></pre>
        </div>
      );
  }
}

function Inline({ nodes, onCite }: { nodes: MdNode[]; onCite: Cite }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === "strong") return <strong key={i}>{node.text}</strong>;
        if (node.kind === "text") return <React.Fragment key={i}>{node.text}</React.Fragment>;
        // Inline code that looks like `path:line` (or a bare path) jumps to the file.
        const cite = /^([\w./@-]+\.\w{1,6})(?::(\d+))?/.exec(node.text);
        if (!cite || !cite[1].includes("/") && !cite[2]) return <code key={i}>{node.text}</code>;
        return (
          <code key={i} className="cite" role="button" tabIndex={0} title="Open in editor"
            onClick={() => onCite(cite[1], Number(cite[2] ?? 0))}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCite(cite[1], Number(cite[2] ?? 0)); } }}>
            {node.text}
          </code>
        );
      })}
    </>
  );
}

// ─── live state ──────────────────────────────────────────────────────────────

export function PhaseLine({ state, startedAt }: { state: ViewState; startedAt: number | null }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (state.phase === "idle" || state.phase === "awaiting-approval" || state.phase === "interrupted") return null;
  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  return (
    <div className="phase" aria-live="polite">
      <Spinner />
      <span className="truncate">{capitalize(phaseLabel(state))}</span>
      {elapsed > 0 && <span className="muted">{elapsed}s</span>}
    </div>
  );
}

function capitalize(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }

export function ApprovalDock({ approval, onApprove }: {
  approval: PendingApproval;
  onApprove: (decision: "allow" | "always" | "deny") => void;
}) {
  const lines = React.useMemo(() => parseDiff(approval.preview, 80), [approval.preview]);
  const allowRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { allowRef.current?.focus(); }, [approval.id]);
  const risk = approval.risk >= 0.6 ? "high" : approval.risk >= 0.35 ? "medium" : "low";
  const what = approval.kind === "shell" ? "Run this command?" : approval.kind === "remove" ? "Delete this file?" : approval.kind === "create" ? "Create this file?" : "Apply this edit?";
  return (
    <section className="approval" data-risk={risk} aria-label={`Approval needed: ${approval.title}`}>
      <header>
        <Icon name="hand" />
        <span className="approval-title">{what}</span>
        <span className="spacer" />
        {approval.callers !== undefined && approval.callers > 0 && (
          <span className="pill" title="Indexed references to what this edit touches">{approval.callers} caller{approval.callers === 1 ? "" : "s"}</span>
        )}
        <span className="pill" data-risk={risk} title={`Blast radius ${approval.risk.toFixed(2)}`}>{risk} risk</span>
      </header>
      <p className="mono truncate approval-target" title={approval.title}>{approval.title}</p>
      {approval.preview && (
        <div className="diff" role="region" aria-label="Preview">
          {lines.map((l, i) => <div key={i} className={l.kind}>{l.text || " "}</div>)}
        </div>
      )}
      <footer>
        <button ref={allowRef} type="button" className="btn" onClick={() => onApprove("allow")}>Allow <kbd>y</kbd></button>
        <button type="button" className="btn secondary" onClick={() => onApprove("always")} title={approval.kind === "shell" ? "Allow this tool for the rest of the session" : "Allow edits for the rest of the session"}>Always <kbd>a</kbd></button>
        <button type="button" className="btn secondary danger" onClick={() => onApprove("deny")}>Deny <kbd>n</kbd></button>
      </footer>
    </section>
  );
}

export function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  React.useEffect(() => {
    // Errors stay until dismissed; everything else clears itself.
    const timers = notices.filter(n => n.level !== "error").map(n => setTimeout(() => onDismiss(n.id), 7000));
    return () => timers.forEach(clearTimeout);
  }, [notices, onDismiss]);
  if (!notices.length) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map(n => (
        <div key={n.id} className="notice" data-level={n.level}>
          <Icon name={n.level === "info" ? "sparkle" : "warning"} />
          <span>{n.message}</span>
          <button type="button" className="icon-btn small" aria-label="Dismiss" onClick={() => onDismiss(n.id)}><Icon name="close" /></button>
        </div>
      ))}
    </div>
  );
}

// ─── composer ────────────────────────────────────────────────────────────────

export const MODE_LABELS: Record<string, { label: string; hint: string }> = {
  "suggest": { label: "Ask first", hint: "Ask before every edit and command" },
  "auto-edit": { label: "Auto-edit", hint: "Apply edits, ask before commands" },
  "full-auto": { label: "Full auto", hint: "Never ask" },
};

export interface ComposerHandle { set(text: string): void; focus(): void }

export const Composer = React.forwardRef<ComposerHandle, {
  running: boolean;
  disabled: boolean;
  mode: string;
  model: string;
  activeFile: string;
  hasSelection: boolean;
  commands: (query: string) => SlashCommandSpec[];
  onLookupFiles: (query: string) => Promise<string[]>;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onMode: (mode: string) => void;
  onModel: () => void;
  onPickFile: () => Promise<string | null>;
}>(function Composer(props, ref) {
  const { running, disabled, mode, model, activeFile, hasSelection, commands, onLookupFiles, onSubmit, onInterrupt, onMode, onModel, onPickFile } = props;
  const [value, setValue] = React.useState("");
  const [caret, setCaret] = React.useState(0);
  const [options, setOptions] = React.useState<{ value: string; hint?: string }[]>([]);
  const [highlight, setHighlight] = React.useState(0);
  const area = React.useRef<HTMLTextAreaElement>(null);
  const token: ActiveToken | null = React.useMemo(() => activeToken(value, caret), [value, caret]);

  React.useImperativeHandle(ref, () => ({
    set: (text: string) => { setValue(text); setCaret(text.length); requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(text.length, text.length); }); },
    focus: () => area.current?.focus(),
  }), []);

  React.useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  React.useEffect(() => {
    let live = true;
    if (!token) { setOptions([]); return; }
    setHighlight(0);
    if (token.trigger === "/") {
      setOptions(commands(token.query).map(c => ({ value: c.name, hint: c.arg ? `${c.summary} · ${c.arg}` : c.summary })));
      return;
    }
    void onLookupFiles(token.query).then(files => { if (live) setOptions(files.map(f => ({ value: f }))); });
    return () => { live = false; };
  }, [token, commands, onLookupFiles]);

  const insert = (text: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const pad = start > 0 && !/\s$/.test(value.slice(0, start)) ? " " : "";
    const next = value.slice(0, start) + pad + text + " " + value.slice(end);
    const pos = start + pad.length + text.length + 1;
    setValue(next);
    setCaret(pos);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  };

  const accept = (choice: string) => {
    if (!token) return;
    const next = applyCompletion(value, token, choice);
    setValue(next.text);
    setCaret(next.caret);
    setOptions([]);
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(next.caret, next.caret); });
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue("");
    setOptions([]);
    onSubmit(text);
  };

  const open = options.length > 0 && !!token;
  const shown = options.slice(0, 8);
  return (
    <div className="composer">
      {open && (
        <ul className="completions" role="listbox" aria-label={token!.trigger === "@" ? "Files" : "Commands"}>
          {shown.map((o, i) => (
            <li key={o.value} role="option" aria-selected={i === highlight} data-selected={i === highlight}
              onMouseDown={e => { e.preventDefault(); accept(o.value); }} onMouseEnter={() => setHighlight(i)}>
              <span className="mono">{token!.trigger}{o.value}</span>
              {o.hint && <span className="muted truncate">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="chips">
        {activeFile && (
          <button type="button" className="chip" title={`Mention ${activeFile}`} onClick={() => insert(`@${activeFile}`)}>
            <Icon name="file" /><span className="truncate">{basename(activeFile)}</span>{hasSelection && <span className="muted">· selection</span>}
          </button>
        )}
        <button type="button" className="chip ghost" title="Mention a file" onClick={() => void onPickFile().then(p => { if (p) insert(`@${p}`); })}>
          <Icon name="add" /><span>File</span>
        </button>
      </div>
      <textarea
        ref={area}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={running ? "The agent is working — Esc stops it" : "Ask or describe a change · @ file · ! command · / more"}
        aria-label="Message the agent"
        onChange={e => { setValue(e.currentTarget.value); setCaret(e.currentTarget.selectionStart ?? 0); }}
        onKeyUp={e => setCaret(e.currentTarget.selectionStart ?? 0)}
        onClick={e => setCaret(e.currentTarget.selectionStart ?? 0)}
        onBlur={() => setOptions([])}
        onKeyDown={e => {
          if (open) {
            const n = shown.length;
            if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(h => (h + 1) % n); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(h => (h - 1 + n) % n); return; }
            if (e.key === "Tab") { e.preventDefault(); accept(shown[highlight].value); return; }
            if (e.key === "Enter" && shown[highlight].value !== token!.query) { e.preventDefault(); accept(shown[highlight].value); return; }
            if (e.key === "Escape") { e.preventDefault(); setOptions([]); return; }
          }
          if (e.key === "Escape" && running) { e.preventDefault(); onInterrupt(); return; }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
        }}
      />
      <div className="composer-bar">
        <label className="mode" title={MODE_LABELS[mode]?.hint}>
          <span className="sr-only">Approval mode</span>
          <select value={mode} onChange={e => onMode(e.currentTarget.value)}>
            {Object.entries(MODE_LABELS).map(([value, m]) => <option key={value} value={value}>{m.label}</option>)}
          </select>
        </label>
        <button type="button" className="chip ghost model" title="Change model" onClick={onModel}>
          <span className="truncate">{model || "model"}</span>
        </button>
        <span className="spacer" />
        {running
          ? <button type="button" className="send stop" title="Stop (Esc)" aria-label="Stop" onClick={onInterrupt}><Icon name="stop" /></button>
          : <button type="button" className="send" title="Send (Enter)" aria-label="Send" disabled={!value.trim() || disabled} onClick={submit}><Icon name="send" /></button>}
      </div>
    </div>
  );
});

// ─── empty / setup ───────────────────────────────────────────────────────────

const QUICK_STARTS: { icon: IconName; label: string; prompt: string }[] = [
  { icon: "layers", label: "Explain this codebase", prompt: "Give me a high-level tour of this codebase: the main modules, how they fit together, and where to start reading." },
  { icon: "search", label: "Trace a feature", prompt: "Trace how authentication works end to end and list the key entry points with file:line references." },
  { icon: "warning", label: "Find likely bugs", prompt: "Look for likely bugs in the code I have open and explain each one with evidence." },
  { icon: "edit", label: "Add tests", prompt: "Add focused unit tests for the file I have open, following the project's existing test patterns." },
];

export function EmptyState({ workspace, onPick }: { workspace: string; onPick: (prompt: string) => void }) {
  return (
    <div className="empty">
      <div className="empty-mark"><Icon name="sparkle" /></div>
      <h2>What should we work on{workspace ? ` in ${workspace}` : ""}?</h2>
      <p className="muted">The agent plans, searches your index, and edits with checkpoints you can rewind.</p>
      <div className="starts">
        {QUICK_STARTS.map(q => (
          <button key={q.label} type="button" className="start" onClick={() => onPick(q.prompt)}>
            <Icon name={q.icon} /><span>{q.label}</span>
          </button>
        ))}
      </div>
      <p className="muted small tips"><kbd>@</kbd> add a file · <kbd>!</kbd> run a command · <kbd>/</kbd> commands</p>
    </div>
  );
}

export function SetupCard({ need, onAction }: { need: SetupNeed; onAction: (action: "llmKey" | "settings" | "folder" | "health") => void }) {
  return (
    <div className="empty setup">
      <div className="empty-mark"><Icon name={need.kind === "llm-key" ? "key" : need.kind === "no-workspace" ? "folder" : "warning"} /></div>
      <h2>{need.kind === "llm-key" ? "Connect a model" : need.kind === "no-workspace" ? "Open a folder" : "The agent couldn't start"}</h2>
      <p className="muted">{need.message}</p>
      <div className="setup-actions">
        {need.kind === "llm-key" && <button type="button" className="btn" onClick={() => onAction("settings")}><Icon name="key" /> Add API key</button>}
        {need.kind === "no-workspace" && <button type="button" className="btn" onClick={() => onAction("folder")}><Icon name="folder" /> Open folder</button>}
        {need.kind === "error" && <button type="button" className="btn" onClick={() => onAction("health")}>Check index health</button>}
        <button type="button" className="btn secondary" onClick={() => onAction("settings")}><Icon name="gear" /> Settings</button>
      </div>
    </div>
  );
}

// ─── sheets ──────────────────────────────────────────────────────────────────

function Sheet({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="sheet" role="dialog" aria-label={title}>
        <header className="sheet-head">
          <span className="label">{title}</span>
          <span className="spacer" />
          {actions}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}

export function ContextSheet({ context, entries, onAction, onCite, onCompact, onClose }: {
  context: ContextSnapshot | null;
  entries: ContextEntry[];
  onAction: (action: "pin" | "unpin" | "evict" | "restore", id: string) => void;
  onCite: Cite;
  onCompact: () => void;
  onClose: () => void;
}) {
  const segments = budgetSegments(context);
  const percent = context?.windowTokens ? Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100)) : 0;
  return (
    <Sheet title="Context window" onClose={onClose} actions={<button type="button" className="link-btn" onClick={onCompact}>Compact</button>}>
      <p className="muted small">{percent}% of {tokens(context?.windowTokens ?? 0)} · {segments.map(s => `${s.bucket} ${tokens(s.tokens)}`).join(" · ") || "nothing retrieved yet"}</p>
      {entries.length === 0 && <p className="muted">Retrieved code shows up here, ranked, with why it was pulled in. Pin what matters; evict what doesn't.</p>}
      <ul className="entries">
        {entries.map(e => (
          <li key={e.id} data-evicted={e.evicted} data-pinned={e.pinned}>
            <span className="score mono">{typeof e.score === "number" ? score(e.score) : "—"}</span>
            <button type="button" className="mono link truncate" title={`${e.label}${e.lines ? `:${e.lines}` : ""} · ${tokens(e.tokens)} tokens${e.via ? ` · via ${e.via}` : ""}`} onClick={() => onCite(e.label, Number(e.lines?.split("-")[0] ?? 0))}>
              {basename(e.label)}{e.lines && <span className="muted">:{e.lines}</span>}
            </button>
            <span className="muted small nowrap">{e.edges?.length ? edgeLabel(e.edges[0]) : e.via ?? e.bucket}</span>
            <span className="spacer" />
            <button type="button" className="icon-btn small" data-active={e.pinned} title={e.pinned ? "Unpin" : "Pin: survives compaction"} aria-label={e.pinned ? "Unpin" : "Pin"} onClick={() => onAction(e.pinned ? "unpin" : "pin", e.id)}><Icon name="pin" /></button>
            <button type="button" className="icon-btn small" title={e.evicted ? "Restore to the window" : "Evict from the next request"} aria-label={e.evicted ? "Restore" : "Evict"} onClick={() => onAction(e.evicted ? "restore" : "evict", e.id)}><Icon name={e.evicted ? "restore" : "eject"} /></button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export function HistorySheet({ rows, currentTitle, onResume, onDelete, onNew, onClose }: {
  rows: HistoryRow[] | null;
  currentTitle?: string;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Conversations" onClose={onClose} actions={<button type="button" className="link-btn" onClick={onNew}><Icon name="add" /> New</button>}>
      {rows === null && <p className="muted">Loading…</p>}
      {rows?.length === 0 && <p className="muted">Your conversations are saved here as you go.</p>}
      <ul className="history">
        {rows?.map(r => (
          <li key={r.id}>
            <button type="button" className="history-item" onClick={() => onResume(r.id)} aria-current={r.title === currentTitle}>
              <span className="truncate">{r.title || "Untitled"}</span>
              <span className="muted small">{r.turns} turn{r.turns === 1 ? "" : "s"} · {relTime(r.updatedAt)}</span>
            </button>
            <button type="button" className="icon-btn small" title="Delete" aria-label={`Delete ${r.title}`} onClick={() => onDelete(r.id)}><Icon name="trash" /></button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export interface SessionReview { files: string[]; untracked: string[]; diff: string; stat: { files: number; added: number; removed: number } }

export function ReviewSheet({ title, review, busy, onLand, onClose }: {
  title: string;
  review: SessionReview | null;
  busy: boolean;
  onLand: () => void;
  onClose: () => void;
}) {
  const lines = React.useMemo(() => (review ? parseDiff(review.diff, 800) : []), [review]);
  const empty = review && !review.files.length && !review.untracked.length;
  return (
    <Sheet title={`Review: ${title}`} onClose={onClose}>
      {!review && <p className="muted">Reading the worktree…</p>}
      {review && (
        <p className="small">
          {review.stat.files} file{review.stat.files === 1 ? "" : "s"} · <span className="add">+{review.stat.added}</span> <span className="del">−{review.stat.removed}</span>
          {review.untracked.length > 0 && <span className="muted"> · new: {review.untracked.join(", ")}</span>}
        </p>
      )}
      {empty && <p className="muted">This session hasn't changed anything yet.</p>}
      {lines.length > 0 && <div className="diff tall">{lines.map((l, i) => <div key={i} className={l.kind}>{l.text || " "}</div>)}</div>}
      <footer className="card-actions">
        <span className="muted small">Landing commits the work, merges the branch, and closes the session.</span>
        <span className="spacer" />
        <button type="button" className="btn" disabled={busy || !review || !!empty} onClick={onLand}>{busy ? "Landing…" : "Land it"}</button>
      </footer>
    </Sheet>
  );
}

export function SearchResults({ query, hits, onCite, onClose }: { query: string; hits: SearchHit[] | null; onCite: Cite; onClose: () => void }) {
  return (
    <section className="card search">
      <header className="card-head">
        <Icon name="search" />
        <span className="label truncate">Index search: {query}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn small" aria-label="Close search" onClick={onClose}><Icon name="close" /></button>
      </header>
      {hits === null && <p className="muted small">Searching…</p>}
      {hits?.length === 0 && <p className="muted small">No matches.</p>}
      {hits?.map(h => (
        <details key={`${h.path}:${h.startLine}`} className="hit">
          <summary>
            <span className="score mono">{score(h.score)}</span>
            <button type="button" className="mono link truncate" onClick={e => { e.preventDefault(); onCite(h.path, h.startLine); }}>{h.path}:{h.startLine}-{h.endLine}</button>
          </summary>
          <pre>{truncate(h.contents, 2400)}</pre>
        </details>
      ))}
    </section>
  );
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
