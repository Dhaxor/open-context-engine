/**
 * How a turn's raw blocks read in a narrow sidebar.
 *
 * The reducer (src/trace/view-model.ts) keeps blocks in the order they
 * happened. A sidebar cannot show a 40-line tool log between two sentences, so
 * consecutive tool / retrieval / sub-agent blocks fold into one "activity" run
 * with a one-line summary, and every tool line says WHAT it touched — the file,
 * the query, the command — rather than the tool's internal name.
 *
 * Pure and DOM-free so it is tested without rendering.
 */

import type { EditProposal, RetrievalTrace } from "../../../src/trace/protocol";
import type { Block, Turn } from "../../../src/trace/view-model";
import type { IconName } from "./icons";

/** Tools whose work another block already shows (the plan card, the sub-agent block). */
const SHOWN_ELSEWHERE = new Set(["update-plan", "delegate"]);
const EDIT_TOOLS = new Set(["str-replace", "create-file", "remove-file"]);

/** The innermost thing running right now — inside a sub-agent, its own step. */
export function currentStep(items: readonly ActivityItem[]): ToolItem | SubagentItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "retrieval" || !item.running) continue;
    if (item.kind === "subagent") return currentStep(item.items) ?? item;
    return item;
  }
  return undefined;
}

export type ToolKind = "search" | "read" | "list" | "symbol" | "edit" | "shell" | "web" | "other";

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  tool: ToolKind;
  icon: IconName;
  verb: string;
  detail: string;
  /** For openable details: the path and the first line to reveal. */
  open?: { path: string; line: number };
  running: boolean;
  ok?: boolean;
  ms?: number;
  /** The ranking that answered a codebase-retrieval call. */
  retrieval?: RetrievalTrace;
  /** Direct `!` shell output. */
  result?: string;
}

export interface RetrievalItem { kind: "retrieval"; trace: RetrievalTrace }
export interface SubagentItem {
  kind: "subagent";
  id: string;
  task: string;
  running: boolean;
  ok?: boolean;
  ms?: number;
  items: ActivityItem[];
  /** The sub-agent's own report text, when it streamed any. */
  text: string;
}
export type ActivityItem = ToolItem | RetrievalItem | SubagentItem;

export type Segment =
  | { kind: "activity"; items: ActivityItem[] }
  | { kind: "text"; text: string }
  | { kind: "edit"; edit: EditProposal };

const pick = (args: Record<string, unknown> | undefined, ...keys: string[]): string => {
  for (const k of keys) {
    const v = args?.[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return "";
};

export function describeTool(name: string, args?: Record<string, unknown>, running = false): Pick<ToolItem, "tool" | "icon" | "verb" | "detail" | "open"> {
  const path = pick(args, "path");
  const start = Number(args?.start_line ?? args?.startLine ?? 0) || 0;
  const end = Number(args?.end_line ?? args?.endLine ?? 0) || 0;
  const range = path && start ? `${path}:${start}${end ? `-${end}` : ""}` : path;
  const v = (now: string, done: string) => (running ? now : done);
  switch (name) {
    case "codebase-retrieval":
      return { tool: "search", icon: "search", verb: v("Searching", "Searched"), detail: pick(args, "information_request", "query") };
    case "read-file":
    case "view-range":
      return { tool: "read", icon: "file", verb: v("Reading", "Read"), detail: range, ...(path ? { open: { path, line: start } } : {}) };
    case "list-files":
      return { tool: "list", icon: "list", verb: v("Listing", "Listed"), detail: pick(args, "pattern", "directory") || "files" };
    case "find-symbol-definition":
      return { tool: "symbol", icon: "symbol", verb: v("Finding", "Found"), detail: `definition of ${pick(args, "symbol")}` };
    case "find-symbol-references":
      return { tool: "symbol", icon: "symbol", verb: v("Finding", "Found"), detail: `references to ${pick(args, "symbol")}` };
    case "str-replace":
      return { tool: "edit", icon: "edit", verb: v("Editing", "Edited"), detail: path, ...(path ? { open: { path, line: 0 } } : {}) };
    case "create-file":
      return { tool: "edit", icon: "plus", verb: v("Creating", "Created"), detail: path, ...(path ? { open: { path, line: 0 } } : {}) };
    case "remove-file":
      return { tool: "edit", icon: "trash", verb: v("Deleting", "Deleted"), detail: path };
    case "run-command":
      return { tool: "shell", icon: "terminal", verb: v("Running", "Ran"), detail: pick(args, "command") };
    case "web-search":
      return { tool: "web", icon: "globe", verb: v("Searching the web", "Searched the web"), detail: pick(args, "query") };
    default:
      return { tool: "other", icon: "layers", verb: name, detail: pick(args, "query", "path", "symbol", "command") };
  }
}

function toolItem(block: Extract<Block, { kind: "tool" }>): ToolItem {
  const running = block.ok === undefined;
  return {
    kind: "tool",
    id: block.id,
    name: block.name,
    ...describeTool(block.name, block.args, running),
    running,
    ...(block.ok !== undefined ? { ok: block.ok } : {}),
    ...(block.ms !== undefined ? { ms: block.ms } : {}),
    ...(block.result !== undefined ? { result: block.result } : {}),
  };
}

/** Fold a block list into segments; retrievals attach to the call they answered. */
export function segment(blocks: readonly Block[]): Segment[] {
  const out: Segment[] = [];
  const byCall = new Map<string, RetrievalTrace>();
  for (const b of blocks) if (b.kind === "retrieval" && b.trace.toolCallId) byCall.set(b.trace.toolCallId, b.trace);

  const activity = (): ActivityItem[] => {
    const last = out[out.length - 1];
    if (last?.kind === "activity") return last.items;
    const run: Segment = { kind: "activity", items: [] };
    out.push(run);
    return run.items;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case "text":
        if (b.text.trim()) out.push({ kind: "text", text: b.text });
        break;
      case "edit":
        out.push({ kind: "edit", edit: b.edit });
        break;
      case "retrieval":
        if (!b.trace.toolCallId) activity().push({ kind: "retrieval", trace: b.trace });
        break;
      case "tool": {
        if (SHOWN_ELSEWHERE.has(b.name)) break;
        // A successful edit is shown by its edit row (diff, undo); the tool
        // line only earns a place while pending or when it failed.
        if (EDIT_TOOLS.has(b.name) && b.ok === true) break;
        const item = toolItem(b);
        const trace = byCall.get(b.id);
        activity().push(trace ? { ...item, retrieval: trace } : item);
        break;
      }
      case "subagent": {
        const inner = segment(b.blocks);
        activity().push({
          kind: "subagent",
          id: b.id,
          task: b.task,
          running: !b.done,
          ...(b.done ? { ok: b.done.ok, ms: b.done.ms } : {}),
          items: inner.flatMap(s => (s.kind === "activity" ? s.items : [])),
          text: inner.filter(s => s.kind === "text").map(s => (s as { text: string }).text).join("\n\n"),
        });
        break;
      }
    }
  }
  return out;
}

/** "3 searches · 4 files · 1 command" — what a collapsed run did. */
export function summarize(items: readonly ActivityItem[]): string {
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const item of items) {
    if (item.kind === "retrieval") bump("search");
    else if (item.kind === "subagent") bump("sub-agent");
    else if (item.tool === "search" || item.tool === "web") bump("search");
    else if (item.tool === "read") bump("file");
    else if (item.tool === "list") bump("listing");
    else if (item.tool === "symbol") bump("lookup");
    else if (item.tool === "shell") bump("command");
    else if (item.tool === "edit") bump("edit");
    else bump("step");
  }
  const order = ["search", "file", "lookup", "listing", "command", "edit", "sub-agent", "step"];
  const plural = (k: string, n: number) => (n === 1 ? k : k === "search" ? "searches" : `${k}s`);
  return order.filter(k => counts.has(k)).map(k => `${counts.get(k)} ${plural(k, counts.get(k)!)}`).join(" · ");
}

/** Every edit the turn made, in order — what its changes tray lists. */
export function turnEdits(turn: Turn): EditProposal[] {
  const edits: EditProposal[] = [];
  for (const b of turn.blocks) if (b.kind === "edit") edits.push(b.edit);
  return edits;
}

/** One row per file: a file edited three times is one change, not three. */
export function changedFiles(edits: readonly EditProposal[]): { path: string; kind: EditProposal["kind"]; ids: string[]; added: number; removed: number }[] {
  const byPath = new Map<string, { path: string; kind: EditProposal["kind"]; ids: string[]; added: number; removed: number }>();
  for (const e of edits) {
    const { added, removed } = lineStat(e.diff);
    const row = byPath.get(e.path);
    if (row) { row.ids.push(e.id); row.added += added; row.removed += removed; if (e.kind === "remove") row.kind = "remove"; }
    else byPath.set(e.path, { path: e.path, kind: e.kind, ids: [e.id], added, removed });
  }
  return [...byPath.values()];
}

function lineStat(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of (diff ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
