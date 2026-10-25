/**
 * The Trace TUI frame — a pure function from view state to screen lines.
 *
 * `renderFrame(state, size, …)` returns exactly `size.rows` strings, each
 * exactly `size.columns` visible columns wide. Nothing here touches a TTY, so
 * the entire terminal layout — wrapping, truncation, the rail appearing and
 * disappearing with width, scroll position — is asserted in ordinary tests
 * rather than eyeballed.
 *
 * Fixed-width lines are also what makes the screen driver safe: a frame can be
 * diffed line by line and only the changed rows rewritten, with no possibility
 * of leftover debris from a longer previous line.
 *
 * The layout mirrors Studio, adapted to a terminal's proportions:
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ header: session identity                                  │
 *   │ ┌────┬──────────────────────────┬───────────────────────┐ │
 *   │ │sha │ transcript               │ evidence rail         │ │
 *   │ └────┴──────────────────────────┴───────────────────────┘ │
 *   │ composer                                                  │
 *   │ status                                                    │
 *   └───────────────────────────────────────────────────────────┘
 */

import type { ContextEntry, PendingApproval } from "../protocol";
import type { Block, ViewState } from "../view-model";
import { phaseLabel, railEntries } from "../view-model";
import {
  basename, budgetSegments, diffStat, duration, edgeLabel, parseDiff,
  retrievalSummary, score as fmtScore, tokens,
} from "../format";
import { parseMarkdown } from "../markdown";
import { Theme, fit, padStart, truncate, width, wrap } from "./theme";

export interface Size { columns: number; rows: number; }

export interface FrameOptions {
  /** Rows scrolled up from the bottom of the transcript. */
  scroll?: number;
  /** Current composer text. */
  input?: string;
  /** Show the rail even on a narrow terminal (Ctrl+R). */
  railOpen?: boolean;
  /** Open completion menu for the token being typed. */
  completions?: string[];
  /** Highlighted entry in `completions`. */
  selected?: number;
}

/** Below this the rail costs more than it gives, so the transcript takes all. */
const RAIL_MIN_COLUMNS = 100;
const RAIL_WIDTH = 34;
const GUTTER = 5;

export function railVisible(size: Size, railOpen = false): boolean {
  if (size.columns < RAIL_MIN_COLUMNS) return railOpen && size.columns >= 60;
  return true;
}

export function renderFrame(state: ViewState, size: Size, theme: Theme, opts: FrameOptions = {}): string[] {
  const rows = Math.max(6, size.rows);
  const columns = Math.max(20, size.columns);
  const showRail = railVisible({ columns, rows }, opts.railOpen);
  const railWidth = showRail ? Math.min(RAIL_WIDTH, Math.floor(columns * 0.4)) : 0;
  const bodyRows = rows - 3; // header, composer, status
  const mainWidth = columns - GUTTER - railWidth;

  // The menu eats transcript rows rather than overlaying them: a terminal has
  // no z-axis, and a menu drawn over the answer would corrupt the frame diff.
  const menu = renderCompletions(opts, theme, columns, Math.max(0, Math.min(6, bodyRows - 2)));
  const body = renderBody(state, { columns, rows }, theme, opts, {
    mainWidth, railWidth, bodyRows: bodyRows - menu.length,
  });

  return [
    fit(renderHeader(state, theme, columns), columns),
    ...body,
    ...menu.map(line => fit(line, columns)),
    fit(renderComposer(state, theme, opts.input ?? "", columns), columns),
    fit(renderStatus(state, theme, columns), columns),
  ];
}

// ─── header ──────────────────────────────────────────────────────────────────

function renderHeader(state: ViewState, theme: Theme, columns: number): string {
  const meta = state.meta;
  const brand = theme.accent("trace") + theme.ink4(" ▍");
  if (!meta) return ` ${brand} ${theme.ink4("connecting…")}`;
  // The branch names WHICH parallel session this is; without it two terminals
  // running sibling sessions are indistinguishable.
  const left = ` ${brand} ${theme.ink2(basename(meta.workspace))}${meta.branch ? " " + theme.accent(meta.branch) : ""}`;
  const right = theme.ink4(
    `${meta.indexedChunks.toLocaleString()} chunks · ${meta.searchMode} · ${meta.mode}`,
  );
  const gap = Math.max(1, columns - width(left) - width(right) - 1);
  return left + " ".repeat(gap) + right + " ";
}

// ─── body ────────────────────────────────────────────────────────────────────

function renderBody(
  state: ViewState,
  size: Size,
  theme: Theme,
  opts: FrameOptions,
  layout: { mainWidth: number; railWidth: number; bodyRows: number },
): string[] {
  const { mainWidth, railWidth, bodyRows } = layout;
  const { lines: transcript, marks } = renderTranscript(state, mainWidth, theme);

  // Anchor to the bottom: a session is read from its newest end. `scroll`
  // walks backwards from there.
  const maxScroll = Math.max(0, transcript.length - bodyRows);
  const offset = Math.min(maxScroll, Math.max(0, opts.scroll ?? 0));
  const start = Math.max(0, transcript.length - bodyRows - offset);
  const visible = transcript.slice(start, start + bodyRows);
  while (visible.length < bodyRows) visible.push("");

  const gutter = renderGutter(state, marks, start, bodyRows, theme);
  const rail = railWidth ? renderRail(state, railWidth, bodyRows, theme) : [];

  return visible.map((line, i) => {
    const left = fit(gutter[i] ?? "", GUTTER);
    const main = fit(line, mainWidth);
    return railWidth ? left + main + fit(rail[i] ?? "", railWidth) : left + main;
  });
}

/**
 * The spine, compressed to five columns: a checkpoint sha printed on the row
 * where its turn begins. Navigation by time, in the space a terminal can spare.
 */
function renderGutter(state: ViewState, marks: Map<number, number>, start: number, bodyRows: number, theme: Theme): string[] {
  const out = new Array<string>(bodyRows).fill("");
  for (const [row, turn] of marks) {
    const visibleRow = row - start;
    if (visibleRow < 0 || visibleRow >= bodyRows) continue;
    const checkpoint = state.checkpoints.find(c => c.turn === turn);
    const label = checkpoint ? checkpoint.short : String(turn).padStart(2, "0");
    const current = turn === state.turns[state.turns.length - 1]?.turn;
    out[visibleRow] = " " + (current ? theme.accent(label) : theme.ink4(label));
  }
  return out;
}

// ─── transcript ──────────────────────────────────────────────────────────────

interface Transcript {
  lines: string[];
  /** Row index to turn number, for the gutter. Returned explicitly rather than
   *  smuggled through the line array as a sentinel string: that needs a
   *  decoding step, and a decoding step is something to forget — which is what
   *  happened, leaving the spine permanently blank. */
  marks: Map<number, number>;
}

function renderTranscript(state: ViewState, w: number, theme: Theme): Transcript {
  const lines: string[] = [];
  const marks = new Map<number, number>();
  const push = (s = "") => lines.push(s);

  if (!state.turns.length) {
    push();
    for (const line of wrap("Ask anything about this workspace. Every retrieval shows its ranked evidence, so you can see what the model saw — and drop what it should not have.", w - 2)) {
      push("  " + theme.ink3(line));
    }
    push();
    push("  " + theme.ink4("enter sends · ctrl+r rail · ctrl+c interrupts"));
    return { lines, marks };
  }

  for (const turn of state.turns) {
    push();
    // The sha sits beside the prompt that opened the turn.
    marks.set(lines.length, turn.turn);
    if (turn.prompt) {
      const wrapped = wrap(turn.prompt, w - 4);
      wrapped.forEach((line, i) => push(`  ${i === 0 ? theme.accent("›") : " "} ${theme.ink(line)}`));
    }
    for (const block of turn.blocks) renderBlock(block, w, theme, push);
    if (turn.stats) {
      const s = turn.stats;
      push("  " + theme.ink4(
        `${s.steps} step${s.steps === 1 ? "" : "s"} · ${s.toolCalls} tool${s.toolCalls === 1 ? "" : "s"} · ` +
        `${tokens(s.usage.inputTokens)}→${tokens(s.usage.outputTokens)} tok · ${duration(s.durationMs)}`,
      ));
    }
  }

  if (state.phase !== "idle" && state.phase !== "awaiting-approval") {
    push();
    push("  " + theme.accent("⟐") + " " + theme.ink3(phaseLabel(state)));
  }
  if (state.approval) {
    push();
    renderApproval(state.approval, w, theme, push);
  }
  for (const notice of state.notices.slice(-2)) {
    push();
    const color = notice.level === "error" ? theme.del : notice.level === "warn" ? theme.warn : theme.ink3;
    for (const line of wrap(notice.message, w - 4)) push("  " + color(line));
  }
  push();
  return { lines, marks };
}

function renderBlock(block: Block, w: number, theme: Theme, push: (s?: string) => void): void {
  switch (block.kind) {
    case "text": {
      push();
      renderAnswer(block.text, w, theme, push);
      break;
    }
    case "retrieval": {
      const t = block.trace;
      let line = "  " + theme.accent("⟐") + " " + theme.ink3(retrievalSummary(t.chunks, t.graphAdded, t.durationMs));
      if (t.searchMode === "keyword-only") line += " " + theme.warn("keyword-only");
      if (t.droppedChunks > 0) line += " " + theme.ink4(`−${t.droppedChunks} dropped`);
      push(line);
      break;
    }
    case "tool": {
      const mark = block.ok === undefined ? theme.ink4("◦") : block.ok ? theme.ok("✓") : theme.del("✗");
      const detail = [block.ms !== undefined ? duration(block.ms) : "", block.chars !== undefined ? `${block.chars.toLocaleString()} chars` : ""]
        .filter(Boolean).join(" · ");
      push(`  ${mark} ${theme.ink3(block.name)}${detail ? " " + theme.ink4(detail) : ""}`);
      break;
    }
    case "edit": {
      const { added, removed } = diffStat(block.edit.diff);
      push(`  ${theme.ok("±")} ${theme.ink3(truncate(block.edit.path, w - 16))} ${theme.ok(`+${added}`)} ${theme.del(`−${removed}`)}`);
      break;
    }
    case "subagent": {
      const running = !block.done;
      const marker = running ? theme.accent("▾") : theme.ink4("▸");
      const tools = block.blocks.filter(b => b.kind === "tool").length;
      const meta = running
        ? "working…"
        : `${tools} tool${tools === 1 ? "" : "s"} · ${duration(block.done!.ms)}${block.done!.ok ? "" : " · failed"}`;
      push(`  ${marker} ${theme.accent("sub-agent")} ${theme.ink3(truncate(block.task, w - 30))} ${theme.ink4(meta)}`);
      // Expanded while it runs, collapsed once the report is what matters.
      if (running) {
        for (const child of block.blocks.slice(-6)) {
          renderBlock(child, w - 4, theme, line => push(theme.ink4("  │") + (line ?? "").slice(1)));
        }
      }
      break;
    }
  }
}

function renderAnswer(text: string, w: number, theme: Theme, push: (s?: string) => void): void {
  for (const block of parseMarkdown(text)) {
    switch (block.kind) {
      case "heading":
        push("  " + theme.bold(theme.ink(inline(block.nodes))));
        break;
      case "list":
        for (const item of block.items) {
          const lines = wrap(inline(item), w - 6);
          lines.forEach((line, i) => push(`  ${i === 0 ? theme.ink4("•") : " "} ${theme.ink2(line)}`));
        }
        break;
      case "fence": {
        if (block.path) push("  " + theme.ink4(block.path));
        for (const line of block.code.split("\n")) {
          push("  " + theme.ink4("│ ") + theme.color("#a8b3c0", truncate(line, w - 6)));
        }
        break;
      }
      case "paragraph":
        for (const line of wrap(inline(block.nodes), w - 4)) push("  " + theme.ink2(line));
        push();
        break;
    }
  }
}

/** Markdown inline nodes flattened; emphasis is dropped rather than faked with
 *  asterisks, which read as noise in a terminal. */
function inline(nodes: { kind: string; text: string }[]): string {
  return nodes.map(n => n.text).join("");
}

function renderApproval(approval: PendingApproval, w: number, theme: Theme, push: (s?: string) => void): void {
  const risk = approval.risk >= 0.6 ? theme.del : approval.risk >= 0.35 ? theme.warn : theme.ok;
  const callers = approval.callers ? ` · ${approval.callers} caller${approval.callers === 1 ? "" : "s"}` : "";
  push("  " + theme.ink4("┌ ") + theme.ink(truncate(approval.title, w - 26)) + "  " + risk(`risk ${approval.risk.toFixed(2)}`) + theme.ink4(callers));
  for (const line of parseDiff(approval.preview, 24)) {
    const body = truncate(line.text || " ", w - 6);
    const styled = line.kind === "add" ? theme.ok(body)
      : line.kind === "rem" ? theme.del(body)
      : line.kind === "hunk" ? theme.accent(body)
      : theme.ink4(body);
    push("  " + theme.ink4("│ ") + styled);
  }
  push("  " + theme.ink4("└ ") + theme.ink3("apply? ") + theme.accent("y") + theme.ink4("es · ") + theme.ink2("a") + theme.ink4("lways · ") + theme.ink2("n") + theme.ink4("o"));
}

// ─── evidence rail ───────────────────────────────────────────────────────────

function renderRail(state: ViewState, w: number, rows: number, theme: Theme): string[] {
  const lines: string[] = [];
  const inner = w - 3;
  const push = (s = "") => lines.push(theme.ink4("│ ") + s);

  const ctx = state.context;
  const percent = ctx && ctx.windowTokens ? Math.min(100, Math.round((ctx.usedTokens / ctx.windowTokens) * 100)) : 0;
  push(theme.ink3("context") + " " + theme.ink4(`${percent}% of ${tokens(ctx?.windowTokens ?? 0)}`));
  push(renderMeter(state, inner, theme));

  const segments = budgetSegments(ctx);
  if (segments.length) {
    const legend = segments.slice(0, 3).map(s => `${s.bucket} ${tokens(s.tokens)}`).join(" · ");
    for (const line of wrap(legend, inner)) push(theme.ink4(line));
  }

  if (state.plan.length) {
    push();
    push(theme.ink3("plan"));
    for (const step of state.plan) {
      const glyph = step.status === "completed" ? theme.ok("✔") : step.status === "in_progress" ? theme.accent("▸") : theme.ink4("○");
      const color = step.status === "in_progress" ? theme.ink2 : theme.ink4;
      const wrapped = wrap(step.step, inner - 2);
      wrapped.forEach((line, i) => push(`${i === 0 ? glyph : " "} ${color(line)}`));
    }
  }

  push();
  const entries = railEntries(state);
  push(theme.ink3("in the window now") + " " + theme.ink4(String(entries.filter(e => !e.evicted).length)));
  if (!entries.length) {
    for (const line of wrap("Retrieved code appears here with its fusion score.", inner)) push(theme.ink4(line));
  }
  for (const entry of entries) {
    if (lines.length >= rows) break;
    push(renderChunk(entry, inner, theme));
    if (entry.edges?.length && lines.length < rows) {
      push("     " + theme.ink4(truncate(edgeLabel(entry.edges[0]), inner - 5)));
    }
  }

  while (lines.length < rows) lines.push(theme.ink4("│"));
  return lines.slice(0, rows);
}

/** The segmented budget bar, drawn with block characters. */
function renderMeter(state: ViewState, w: number, theme: Theme): string {
  const segments = budgetSegments(state.context);
  if (!segments.length) return theme.ink4("─".repeat(Math.max(0, w)));
  let out = "";
  let used = 0;
  segments.forEach((segment, i) => {
    const cells = i === segments.length - 1
      ? Math.max(0, w - used)
      : Math.max(1, Math.round((segment.percent / 100) * w));
    const take = Math.min(cells, w - used);
    if (take > 0) out += theme.color(segment.color, "█".repeat(take));
    used += take;
  });
  return out;
}

function renderChunk(entry: ContextEntry, w: number, theme: Theme): string {
  const hasScore = typeof entry.score === "number";
  const scoreText = hasScore ? fmtScore(entry.score!) : "  —";
  const scoreCell = hasScore ? theme.score(entry.score!, padStart(scoreText, 4)) : theme.ink4(padStart(scoreText, 4));
  const marker = entry.pinned ? theme.accent("◆") : entry.evicted ? theme.ink4("✕") : " ";
  const label = `${basename(entry.label)}${entry.lines ? `:${entry.lines}` : ""}`;
  const path = entry.evicted ? theme.ink4(label) : theme.ink2(label);
  return `${scoreCell} ${marker} ${truncate(path, Math.max(0, w - 7))}`;
}

// ─── composer + status ───────────────────────────────────────────────────────

/** The completion menu, drawn just above the composer, newest-relevant first. */
function renderCompletions(opts: FrameOptions, theme: Theme, columns: number, maxRows: number): string[] {
  const items = opts.completions ?? [];
  if (!items.length || maxRows <= 0) return [];
  const selected = Math.max(0, Math.min(opts.selected ?? 0, items.length - 1));
  // Keep the highlighted row on screen when the list is longer than the space.
  const start = Math.max(0, Math.min(selected - maxRows + 1, items.length - maxRows));
  return items.slice(start, start + maxRows).map((item, i) => {
    const isSelected = start + i === selected;
    const label = truncate(item, columns - 6);
    return isSelected
      ? ` ${theme.accent("›")} ${theme.ink(label)}`
      : `   ${theme.ink3(label)}`;
  });
}

function renderComposer(state: ViewState, theme: Theme, input: string, columns: number): string {
  const running = state.phase !== "idle" && state.phase !== "interrupted";
  const caret = theme.accent("›");
  if (!input && running) return ` ${caret} ${theme.ink4("running — esc interrupts")}`;
  if (!input) return ` ${caret} ${theme.ink4("ask, or @file, !shell, /command")}`;
  // Keep the tail visible while typing past the edge.
  const room = columns - 4;
  const shown = width(input) > room ? input.slice(input.length - room) : input;
  return ` ${caret} ${theme.ink(shown)}${theme.accent("▌")}`;
}

function renderStatus(state: ViewState, theme: Theme, columns: number): string {
  const meta = state.meta;
  const checkpoint = state.checkpoints[state.checkpoints.length - 1];
  const left = [
    meta ? `${meta.provider}/${meta.model}` : "…",
    `${tokens(state.usage.inputTokens)} in · ${tokens(state.usage.outputTokens)} out`,
  ].join("  ");
  const right = [
    meta?.auditing && checkpoint ? `audit ✓ ${checkpoint.short}` : "",
    state.connected ? "live" : "offline",
  ].filter(Boolean).join("  ");
  const gap = Math.max(1, columns - width(left) - width(right) - 2);
  const rightStyled = state.connected ? theme.accent(right) : theme.warn(right);
  return " " + theme.ink4(left) + " ".repeat(gap) + rightStyled + " ";
}
