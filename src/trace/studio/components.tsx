/**
 * Studio's presentational layer.
 *
 * Every component here takes data and callbacks and renders — no fetching, no
 * subscriptions. State lives in the reducer, transport lives in the client.
 *
 * The two components that make this product what it is are EvidenceRail and
 * Spine. Everything else is a competent transcript; those two are the argument.
 */

import * as React from "react";
import type {
  Checkpoint, ContextEntry, ContextSnapshot, EditProposal, PendingApproval,
  PlanStep, RetrievalTrace, SessionMeta,
} from "../protocol";
import type { Block, Notice, ViewState, Turn } from "../view-model";
import { phaseLabel } from "../view-model";
import { parseMarkdown, type MdBlock, type MdNode } from "../markdown";
import { activeToken, applyCompletion, matchCommands } from "../composer";
import {
  basename, budgetSegments, diffStat, duration, edgeLabel, parseDiff,
  retrievalSummary, riskColor, score, scoreColor, tokens, truncate,
} from "../format";

// ─── sessions ────────────────────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  title: string;
  status: "starting" | "ready" | "failed" | "closed";
  branch?: string;
  error?: string;
  changedFiles: number;
  running: boolean;
  active: boolean;
}

/**
 * Parallel sessions, stacked at the top of the spine.
 *
 * Sessions and checkpoints are two different axes — which conversation, and
 * when within it — so they share the gutter but not the same run of dots. A
 * rule separates them. Each session is a chip carrying its branch initial, a
 * dot for "running", and a count of files it has changed, because the question
 * you actually have about a background session is "is it working, and has it
 * touched anything yet".
 */
export function SessionSwitcher({ sessions, onSelect, onCreate, onClose }: {
  sessions: SessionSummary[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
}) {
  if (sessions.length <= 1) {
    return (
      <div className="sessions">
        <button type="button" className="session-add" title="New parallel session" aria-label="New parallel session" onClick={onCreate}>＋</button>
        <span className="sessions-rule" />
      </div>
    );
  }
  return (
    <div className="sessions">
      {sessions.map(s => (
        <button
          key={s.id}
          type="button"
          className="session-chip"
          data-active={s.active}
          data-status={s.status}
          aria-current={s.active}
          title={`${s.title}${s.branch ? ` · ${s.branch}` : ""}${s.error ? ` · ${s.error}` : ""}${s.changedFiles ? ` · ${s.changedFiles} changed` : ""}`}
          onClick={() => onSelect(s.id)}
          onAuxClick={e => { if (e.button === 1) onClose(s.id); }}
        >
          <span className="session-mark">{initialOf(s)}</span>
          {s.running && <span className="session-run" aria-label="running" />}
          {s.changedFiles > 0 && <span className="session-count">{s.changedFiles}</span>}
        </button>
      ))}
      <button type="button" className="session-add" title="New parallel session" aria-label="New parallel session" onClick={onCreate}>＋</button>
      <span className="sessions-rule" />
    </div>
  );
}

function initialOf(s: SessionSummary): string {
  const source = (s.branch?.replace(/^trace\//, "") || s.title).trim();
  return (source[0] ?? "?").toUpperCase();
}

// ─── spine ───────────────────────────────────────────────────────────────────

export function Spine({ checkpoints, currentTurn, onRewind, children }: {
  checkpoints: Checkpoint[];
  currentTurn: number;
  onRewind: (hash: string) => void;
  /** The session switcher, stacked above the timeline. */
  children?: React.ReactNode;
}) {
  return (
    <nav className="spine" aria-label="Sessions and timeline">
      {children}
      {checkpoints.length === 0 && <span className="spine-sha" aria-hidden="true">—</span>}
      {checkpoints.map((c, i) => (
        <React.Fragment key={c.hash}>
          <button
            type="button"
            className="spine-node"
            data-current={c.turn === currentTurn}
            data-restorable={c.restorable}
            disabled={!c.restorable}
            onClick={() => c.restorable && onRewind(c.hash)}
            title={
              c.restorable
                ? `Rewind to ${c.short} — turn ${c.turn}, ${c.filesTouched} file${c.filesTouched === 1 ? "" : "s"} changed`
                : `${c.short} — turn ${c.turn}, no file changes to undo`
            }
            aria-label={`Turn ${c.turn}, checkpoint ${c.short}${c.restorable ? ", rewind here" : ""}`}
          >
            <span className="spine-sha">{c.short}</span>
            <span className="spine-dot" />
          </button>
          {i < checkpoints.length - 1 && <span className="spine-thread" />}
        </React.Fragment>
      ))}
    </nav>
  );
}

// ─── transcript ──────────────────────────────────────────────────────────────

export function Transcript({ state, onCite, onApprove }: {
  state: ViewState;
  onCite: (path: string, line: number) => void;
  onApprove: (id: string, decision: "allow" | "always" | "deny") => void;
}) {
  const endRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pinnedToBottom = React.useRef(true);

  // Follow the stream only while the reader is already at the bottom. Yanking
  // someone back down while they are reading history is the single most
  // irritating thing a streaming transcript can do.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    if (pinnedToBottom.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [state.turns, state.approval]);

  return (
    <div className="transcript" ref={scrollRef}>
      {state.turns.length === 0 && <EmptyTranscript meta={state.meta} />}
      {state.turns.map(turn => (
        <TurnView key={turn.turn} turn={turn} onCite={onCite} />
      ))}
      {state.phase !== "idle" && state.phase !== "awaiting-approval" && (
        <div className="readout" aria-live="polite">
          <span className="glyph">⟐</span>
          <span>{phaseLabel(state)}</span>
        </div>
      )}
      {state.approval && <ApprovalCard approval={state.approval} onApprove={onApprove} />}
      <div ref={endRef} />
    </div>
  );
}

function EmptyTranscript({ meta }: { meta: SessionMeta | null }) {
  return (
    <div className="turn">
      <p className="answer" style={{ color: "var(--ink3)" }}>
        Ask anything about {meta ? basename(meta.workspace) : "this workspace"}.
        Every retrieval shows its ranked evidence on the right — you can see what
        the model saw, and drop what it should not have.
      </p>
      <p className="empty">⌘K for commands · @ to reference a file · Enter to send</p>
    </div>
  );
}

function TurnView({ turn, onCite }: { turn: Turn; onCite: (p: string, l: number) => void }) {
  return (
    <article className="turn">
      {turn.prompt && (
        <h2 className="turn-prompt">
          <span className="caret" aria-hidden="true">›</span>
          <span>{turn.prompt}</span>
        </h2>
      )}
      {turn.blocks.map((block, i) => <BlockView key={i} block={block} onCite={onCite} />)}
      {turn.stats && (
        <p className="toolline">
          {turn.stats.steps} step{turn.stats.steps === 1 ? "" : "s"} ·{" "}
          {turn.stats.toolCalls} tool{turn.stats.toolCalls === 1 ? "" : "s"} ·{" "}
          {tokens(turn.stats.usage.inputTokens)}→{tokens(turn.stats.usage.outputTokens)} tok ·{" "}
          {duration(turn.stats.durationMs)}
        </p>
      )}
    </article>
  );
}

function BlockView({ block, onCite }: { block: Block; onCite: (p: string, l: number) => void }) {
  switch (block.kind) {
    case "text": return <Answer text={block.text} onCite={onCite} />;
    case "retrieval": return <RetrievalReadout trace={block.trace} />;
    case "tool": return <ToolLine block={block} />;
    case "edit": return <EditSummary edit={block.edit} />;
    case "subagent": return <SubagentBlock block={block} onCite={onCite} />;
  }
}

/**
 * A delegation, with the child's own work nested inside.
 *
 * Open while it runs — a sub-agent working in silence for minutes is the thing
 * people complain about — and collapsed once it finishes, because by then the
 * report is what matters and the search it did to get there is detail.
 */
function SubagentBlock({ block, onCite }: {
  block: Extract<Block, { kind: "subagent" }>;
  onCite: (p: string, l: number) => void;
}) {
  const running = !block.done;
  const [open, setOpen] = React.useState(true);
  React.useEffect(() => { if (block.done) setOpen(false); }, [block.done]);

  const tools = block.blocks.filter(b => b.kind === "tool").length;
  return (
    <section className="subagent" data-running={running}>
      <button
        type="button"
        className="subagent-head"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="glyph" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="subagent-label">sub-agent</span>
        <span className="subagent-task">{truncate(block.task, 68)}</span>
        <span className="subagent-meta">
          {running
            ? "working…"
            : `${tools} tool${tools === 1 ? "" : "s"} · ${duration(block.done!.ms)}${block.done!.ok ? "" : " · failed"}`}
        </span>
      </button>
      {open && (
        <div className="subagent-body">
          {block.blocks.length === 0 && <p className="empty">Starting…</p>}
          {block.blocks.map((child, i) => <BlockView key={i} block={child} onCite={onCite} />)}
        </div>
      )}
    </section>
  );
}

export function RetrievalReadout({ trace }: { trace: RetrievalTrace }) {
  return (
    <div className="readout">
      <span className="glyph" aria-hidden="true">⟐</span>
      <span>{retrievalSummary(trace.chunks, trace.graphAdded, trace.durationMs)}</span>
      {trace.searchMode === "keyword-only" && (
        <span className="degraded" title="sqlite-vec is unavailable, so ranking is BM25 only">
          keyword-only
        </span>
      )}
      {trace.droppedChunks > 0 && (
        <span title={`${trace.droppedChunks} results did not fit the context budget`}>
          −{trace.droppedChunks} dropped
        </span>
      )}
    </div>
  );
}

function ToolLine({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const pending = block.ok === undefined;
  return (
    <div className="toolline">
      <span className={pending ? "" : block.ok ? "ok" : "fail"} aria-hidden="true">
        {pending ? "◦" : block.ok ? "✓" : "✗"}
      </span>
      <span>{block.name}</span>
      {block.ms !== undefined && <span>{duration(block.ms)}</span>}
      {block.chars !== undefined && <span>{block.chars.toLocaleString()} chars</span>}
    </div>
  );
}

function EditSummary({ edit }: { edit: EditProposal }) {
  const { added, removed } = diffStat(edit.diff);
  return (
    <div className="toolline">
      <span className="ok" aria-hidden="true">±</span>
      <span>{edit.path}</span>
      <span className="ok">+{added}</span>
      <span className="fail">−{removed}</span>
    </div>
  );
}

// ─── answer rendering ────────────────────────────────────────────────────────

function Answer({ text, onCite }: { text: string; onCite: (p: string, l: number) => void }) {
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  return <div className="answer">{blocks.map((b, i) => <MdBlockView key={i} block={b} onCite={onCite} />)}</div>;
}

function MdBlockView({ block, onCite }: { block: MdBlock; onCite: (p: string, l: number) => void }) {
  switch (block.kind) {
    case "heading":
      return <h3><Inline nodes={block.nodes} onCite={onCite} /></h3>;
    case "list":
      return (
        <ul style={{ margin: "var(--s2) 0", paddingLeft: "var(--s4)" }}>
          {block.items.map((nodes, i) => <li key={i}><Inline nodes={nodes} onCite={onCite} /></li>)}
        </ul>
      );
    case "fence":
      return (
        <pre>
          {block.path && <div className="toolline" style={{ marginBottom: 4 }}>{block.path}</div>}
          <code>{block.code}</code>
        </pre>
      );
    case "paragraph":
      return <p style={{ margin: "var(--s2) 0" }}><Inline nodes={block.nodes} onCite={onCite} /></p>;
  }
}

function Inline({ nodes, onCite }: { nodes: MdNode[]; onCite: (p: string, l: number) => void }) {
  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === "strong") return <strong key={i}>{node.text}</strong>;
        if (node.kind === "text") return <React.Fragment key={i}>{node.text}</React.Fragment>;
        // Inline code that looks like `path:line` becomes a jump to the file.
        const cite = /^([\w./-]+\.\w{1,5}):(\d+)/.exec(node.text);
        if (!cite) return <code key={i}>{node.text}</code>;
        return (
          <code
            key={i}
            role="button"
            tabIndex={0}
            style={{ cursor: "pointer" }}
            onClick={() => onCite(cite[1], Number(cite[2]))}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCite(cite[1], Number(cite[2])); } }}
          >
            {node.text}
          </code>
        );
      })}
    </>
  );
}

// ─── approvals ───────────────────────────────────────────────────────────────

export function ApprovalCard({ approval, onApprove }: {
  approval: PendingApproval;
  onApprove: (id: string, decision: "allow" | "always" | "deny") => void;
}) {
  const lines = React.useMemo(() => parseDiff(approval.preview), [approval.preview]);
  const allowRef = React.useRef<HTMLButtonElement>(null);

  // The agent is blocked until this is answered, so the primary action takes
  // focus — y/a/n also work, wired at the app level.
  React.useEffect(() => { allowRef.current?.focus(); }, [approval.id]);

  return (
    <section className="patch" aria-label={`Approve: ${approval.title}`}>
      <header className="patch-head">
        <span>{approval.title}</span>
        <span className="patch-risk">
          {approval.callers !== undefined && approval.callers > 0 && (
            <span title="Indexed references to this file">{approval.callers} caller{approval.callers === 1 ? "" : "s"}</span>
          )}
          <span>risk {approval.risk.toFixed(2)}</span>
          <span className="bar"><i style={{ width: `${approval.risk * 100}%`, background: riskColor(approval.risk) }} /></span>
        </span>
      </header>
      <div className="patch-body">
        {lines.map((line, i) => <div key={i} className={line.kind}>{line.text || " "}</div>)}
      </div>
      <footer className="patch-ask">
        <span>Apply this {approval.kind === "shell" ? "command" : "change"}?</span>
        <button ref={allowRef} type="button" className="btn" data-variant="primary" onClick={() => onApprove(approval.id, "allow")}>
          Yes <kbd>y</kbd>
        </button>
        <button type="button" className="btn" onClick={() => onApprove(approval.id, "always")}>
          Always <kbd>a</kbd>
        </button>
        <button type="button" className="btn" data-variant="danger" onClick={() => onApprove(approval.id, "deny")}>
          No <kbd>n</kbd>
        </button>
      </footer>
    </section>
  );
}

// ─── evidence rail ───────────────────────────────────────────────────────────

export function EvidenceRail({ open, context, entries, plan, onContext, onCite }: {
  /** Narrow viewports collapse the rail; this opens it as an overlay. */
  open?: boolean;
  context: ContextSnapshot | null;
  entries: ContextEntry[];
  plan: PlanStep[];
  onContext: (action: "pin" | "unpin" | "evict" | "restore", id: string) => void;
  onCite: (path: string, line: number) => void;
}) {
  const segments = budgetSegments(context);
  const percent = context && context.windowTokens
    ? Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))
    : 0;

  return (
    <aside className="rail" data-open={open ? "true" : "false"} aria-label="Context">
      <div className="rail-section">
        <div className="label">
          <span>context</span>
          <span className="num">{percent}% of {tokens(context?.windowTokens ?? 0)}</span>
        </div>
        <div
          className="budget"
          role="img"
          aria-label={`Context window ${percent} percent full`}
          title={segments.map(s => `${s.bucket} ${tokens(s.tokens)}`).join(" · ")}
        >
          {segments.map(s => (
            <i key={s.bucket} style={{ width: `${s.percent}%`, background: s.color }} />
          ))}
        </div>
        <div className="legend">
          {segments.map(s => (
            <span key={s.bucket}>
              <i className="sw" style={{ background: s.color }} />
              {s.bucket} {tokens(s.tokens)}
            </span>
          ))}
          {!segments.length && <span>nothing retrieved yet</span>}
        </div>
      </div>

      {plan.length > 0 && (
        <div className="rail-section">
          <div className="label"><span>plan</span></div>
          <div className="plan">
            {plan.map((step, i) => (
              <div key={i} className="plan-step" data-status={step.status}>
                <span className="glyph" aria-hidden="true">
                  {step.status === "completed" ? "✔" : step.status === "in_progress" ? "▸" : "○"}
                </span>
                <span>{step.step}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rail-scroll">
        <div className="label" style={{ marginBottom: "var(--s2)" }}>
          <span>in the window now</span>
          <span className="num">{entries.filter(e => !e.evicted).length}</span>
        </div>
        {entries.length === 0 && (
          <p className="empty">
            Retrieved code appears here with its fusion score, ranked. Pin what
            matters; evict what does not.
          </p>
        )}
        {entries.map(entry => (
          <ChunkRow key={entry.id} entry={entry} onContext={onContext} onCite={onCite} />
        ))}
      </div>

      <div className="rail-section" style={{ borderBottom: 0, borderTop: "1px solid var(--edge)" }}>
        <div className="legend"><span>◆ pinned · ✕ evict · click to open</span></div>
      </div>
    </aside>
  );
}

function ChunkRow({ entry, onContext, onCite }: {
  entry: ContextEntry;
  onContext: (action: "pin" | "unpin" | "evict" | "restore", id: string) => void;
  onCite: (path: string, line: number) => void;
}) {
  const startLine = Number(entry.lines?.split("-")[0] ?? 0);
  const hasScore = typeof entry.score === "number";
  const color = hasScore ? scoreColor(entry.score!) : "var(--ink4)";

  return (
    <>
      <div className="chunk" data-evicted={entry.evicted} data-pinned={entry.pinned}>
        <span className="chunk-score" style={{ color }}>{hasScore ? score(entry.score!) : "—"}</span>
        <span className="chunk-meter" aria-hidden="true">
          <i style={{ width: `${Math.round((entry.score ?? 0) * 100)}%`, background: color }} />
        </span>
        <button
          type="button"
          className="chunk-path"
          title={`${entry.label}${entry.lines ? `:${entry.lines}` : ""} · ${tokens(entry.tokens)} tokens${entry.via ? ` · via ${entry.via}` : ""}`}
          onClick={() => onCite(entry.label, startLine)}
        >
          {basename(entry.label)}
          {entry.lines && <span className="lines">:{entry.lines}</span>}
        </button>
        <span className="chunk-actions">
          <button
            type="button"
            className="icon-btn"
            data-active={entry.pinned}
            aria-label={entry.pinned ? `Unpin ${entry.label}` : `Pin ${entry.label}`}
            title={entry.pinned ? "Unpin — stops surviving compaction" : "Pin — survives compaction"}
            onClick={() => onContext(entry.pinned ? "unpin" : "pin", entry.id)}
          >
            ◆
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={entry.evicted ? `Restore ${entry.label}` : `Evict ${entry.label}`}
            title={entry.evicted ? "Restore to the context window" : "Evict — removes it from the model's next request"}
            onClick={() => onContext(entry.evicted ? "restore" : "evict", entry.id)}
          >
            {entry.evicted ? "↺" : "✕"}
          </button>
        </span>
      </div>
      {entry.edges?.length ? (
        <div className="edge-chip" title="Why this chunk was pulled in">
          {edgeLabel(entry.edges[0])}
        </div>
      ) : null}
    </>
  );
}

// ─── composer + status ───────────────────────────────────────────────────────

export function Composer({ disabled, onSubmit, onInterrupt, running, onLookupFiles }: {
  disabled: boolean;
  running: boolean;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  /** Ranked indexed paths for the `@` menu. */
  onLookupFiles: (query: string) => Promise<string[]>;
}) {
  const [value, setValue] = React.useState("");
  const [caret, setCaret] = React.useState(0);
  const [options, setOptions] = React.useState<{ value: string; hint?: string }[]>([]);
  const [highlight, setHighlight] = React.useState(0);
  const ref = React.useRef<HTMLTextAreaElement>(null);

  const token = React.useMemo(() => activeToken(value, caret), [value, caret]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.3)}px`;
  }, [value]);

  // Menu contents follow the token under the caret. File lookup is async and
  // can land out of order, so a stale response is discarded rather than
  // flashing the wrong list.
  React.useEffect(() => {
    let live = true;
    if (!token) { setOptions([]); return; }
    setHighlight(0);
    if (token.trigger === "/") {
      setOptions(matchCommands(token.query).map(c => ({ value: c.name, hint: c.summary })));
      return;
    }
    void onLookupFiles(token.query).then(files => {
      if (live) setOptions(files.map(f => ({ value: f })));
    }).catch(() => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [token, onLookupFiles]);

  const sync = (el: HTMLTextAreaElement) => {
    setValue(el.value);
    setCaret(el.selectionStart ?? el.value.length);
  };

  const accept = (choice: string) => {
    if (!token) return;
    const next = applyCompletion(value, token, choice);
    setValue(next.text);
    setCaret(next.caret);
    setOptions([]);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue("");
    setOptions([]);
    onSubmit(text);
  };

  const open = options.length > 0 && !!token;

  return (
    <div className="composer-wrap">
      {open && (
        <ul className="completions" role="listbox" aria-label={token!.trigger === "@" ? "Files" : "Commands"}>
          {options.slice(0, 8).map((option, i) => (
            <li
              key={option.value}
              role="option"
              aria-selected={i === highlight}
              data-selected={i === highlight}
              onMouseDown={e => { e.preventDefault(); accept(option.value); }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span className="completion-value">{token!.trigger}{option.value}</span>
              {option.hint && <span className="completion-hint">{option.hint}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="composer">
        <span className="caret" aria-hidden="true">›</span>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder={running ? "Running — Esc interrupts" : "Ask, or @file, !shell, /command"}
          aria-label="Message"
          aria-expanded={open}
          onChange={e => sync(e.currentTarget)}
          onKeyUp={e => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={e => setCaret(e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setOptions([])}
          onKeyDown={e => {
            if (open) {
              // While the menu is up it owns the arrows, Tab, and Enter —
              // otherwise Enter would send a half-typed mention.
              if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(h => (h + 1) % Math.min(options.length, 8)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(h => (h - 1 + Math.min(options.length, 8)) % Math.min(options.length, 8)); return; }
              if (e.key === "Tab") { e.preventDefault(); accept(options[highlight].value); return; }
              // Enter still submits when the highlighted entry is already what
              // was typed — otherwise every complete command needs two presses.
              if (e.key === "Enter" && options[highlight].value !== token!.query) {
                e.preventDefault();
                accept(options[highlight].value);
                return;
              }
              if (e.key === "Escape") { e.preventDefault(); setOptions([]); return; }
            }
            // Enter sends; Shift+Enter is a newline. Reversing these is a
            // reliable way to make a chat feel wrong.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        {running
          ? <button type="button" className="btn" onClick={onInterrupt}>Stop <kbd>esc</kbd></button>
          : <button type="button" className="btn" data-variant="primary" disabled={!value.trim()} onClick={submit}>Send</button>}
      </div>
    </div>
  );
}

export function StatusBar({ state, onCycleMode, onOpenPalette, onToggleRail }: {
  state: ViewState;
  onCycleMode: () => void;
  onOpenPalette: () => void;
  onToggleRail: () => void;
}) {
  const meta = state.meta;
  const checkpoint = state.checkpoints[state.checkpoints.length - 1];
  return (
    <footer className="statusbar">
      <span>{meta ? `${meta.provider}/${meta.model}` : "connecting…"}</span>
      <span>
        <b>{tokens(state.usage.inputTokens)}</b> in · <b>{tokens(state.usage.outputTokens)}</b> out
      </span>
      {meta && (
        <span title={meta.searchMode === "hybrid" ? "Semantic + keyword ranking" : "sqlite-vec unavailable — BM25 only"}>
          <b>{meta.indexedChunks.toLocaleString()}</b> chunks · {meta.searchMode}
        </span>
      )}
      {meta?.branch && (
        <span title={`This session works in ${meta.workspace}`}>
          <b>{meta.branch}</b>
        </span>
      )}
      <button type="button" className="mode-btn" onClick={onCycleMode} title="Cycle approval mode">
        {meta?.mode ?? "suggest"}
      </button>
      <span className="spacer" />
      {/* Below the breakpoint the rail is hidden, and it is the whole point of
          this product — it needs a visible way back, not just a palette entry. */}
      <button type="button" className="mode-btn rail-toggle" onClick={onToggleRail} title="Show the evidence rail">
        context{state.context ? ` ${state.context.entries.filter(e => !e.evicted).length}` : ""}
      </button>
      <button type="button" className="mode-btn" onClick={onOpenPalette}>⌘K</button>
      {meta?.auditing && checkpoint && <span className="audit" title="Tamper-evident audit chain">audit ✓ {checkpoint.short}</span>}
      <span className={state.connected ? "live" : "offline"}>
        {state.connected ? "live" : "reconnecting…"}
      </span>
    </footer>
  );
}

export interface SessionReview {
  files: string[];
  untracked: string[];
  diff: string;
  stat: { files: number; added: number; removed: number };
}

/**
 * What a parallel session changed, before it lands.
 *
 * Parallel sessions are only half a feature without this: work isolated in a
 * worktree has to be reviewable and mergeable, or it is stranded. The diff is
 * read-only on purpose — landing is one decision about the whole session, and
 * a per-hunk staging UI here would duplicate what git already does better.
 */
export function ReviewPanel({ title, review, busy, onLand, onClose }: {
  title: string;
  review: SessionReview | null;
  busy: boolean;
  onLand: () => void;
  onClose: () => void;
}) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const lines = React.useMemo(() => (review ? parseDiff(review.diff, 600) : []), [review]);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const empty = review && !review.files.length && !review.untracked.length;

  return (
    <dialog ref={dialogRef} className="review-backdrop" onClose={onClose} onClick={e => { if (e.target === dialogRef.current) onClose(); }}>
      <section className="review" onClick={e => e.stopPropagation()} aria-label={`Review ${title}`}>
        <header className="review-head">
          <span className="review-title">{title}</span>
          {review && (
            <span className="review-stat">
              {review.stat.files} file{review.stat.files === 1 ? "" : "s"}
              {" · "}<span className="ok">+{review.stat.added}</span>
              {" "}<span className="fail">−{review.stat.removed}</span>
            </span>
          )}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </header>

        <div className="review-body">
          {!review && <p className="empty">Reading the worktree…</p>}
          {empty && <p className="empty">This session has not changed anything yet.</p>}
          {review?.untracked.length ? (
            <p className="toolline" style={{ padding: "var(--s2) var(--s3)" }}>
              new: {review.untracked.join(", ")}
            </p>
          ) : null}
          {lines.map((line, i) => <div key={i} className={line.kind}>{line.text || " "}</div>)}
        </div>

        <footer className="review-foot">
          <span className="empty" style={{ padding: 0 }}>
            Landing commits the work, merges the branch, and closes the session.
          </span>
          <button type="button" className="btn" onClick={onClose}>Not yet</button>
          <button type="button" className="btn" data-variant="primary" disabled={busy || !!empty} onClick={onLand}>
            {busy ? "Landing…" : "Land it"}
          </button>
        </footer>
      </section>
    </dialog>
  );
}

export function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  if (!notices.length) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map(n => (
        <div key={n.id} className="notice" data-level={n.level}>
          <span>{n.message}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => onDismiss(n.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
