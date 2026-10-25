import * as fs from "fs";
import * as path from "path";
import { OpenContext } from "../core/context";
import { unifiedDiff, countOccurrences, replaceAll } from "../core/diff";
import { PathOutsideWorkspaceError, resolveWorkspacePath } from "../core/utils";
import { EditProposal, ToolDefinition } from "./types";

export interface EditApplier {
  readFile(relPath: string): Promise<string | null>;
  writeFile(relPath: string, contents: string): Promise<void>;
  removeFile(relPath: string): Promise<boolean>;
  fileExists(relPath: string): Promise<boolean>;
  onEditProposed?: (edit: EditProposal) => void;
}

export class FsEditApplier implements EditApplier {
  constructor(private workspaceRoot: string) {}
  // Containment: model-supplied paths must stay inside the workspace.
  private abs(p: string): string { return resolveWorkspacePath(this.workspaceRoot, p); }
  async readFile(rel: string): Promise<string | null> {
    try { return await fs.promises.readFile(this.abs(rel), "utf8"); } catch (err) {
      if (err instanceof PathOutsideWorkspaceError) throw err;
      return null;
    }
  }
  async writeFile(rel: string, contents: string): Promise<void> {
    const abs = this.abs(rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, contents, "utf8");
  }
  async removeFile(rel: string): Promise<boolean> {
    try { await fs.promises.unlink(this.abs(rel)); return true; } catch (err) {
      if (err instanceof PathOutsideWorkspaceError) throw err;
      return false;
    }
  }
  async fileExists(rel: string): Promise<boolean> {
    try { await fs.promises.access(this.abs(rel)); return true; } catch (err) {
      if (err instanceof PathOutsideWorkspaceError) throw err;
      return false;
    }
  }
}

export interface EditToolsOptions {
  context: OpenContext;
  applier: EditApplier;
  reindexOnEdit?: boolean;
  onEdit?: (edit: EditProposal) => void;
}

function mkEditId(): string { return "edit_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export function editTools(opts: EditToolsOptions): ToolDefinition[] {
  const { context, applier, onEdit } = opts;
  const reindex = opts.reindexOnEdit ?? true;
  const emit = (e: EditProposal) => { try { onEdit?.(e); applier.onEditProposed?.(e); } catch {} };
  const afterWrite = async (relPath: string, contents: string) => {
    if (reindex) { try { await context.addFiles([{ path: relPath, contents }]); } catch {} }
  };

  return [
    {
      name: "str-replace",
      mutates: true,
      description: "Replace an exact substring in a file. old_str must uniquely match existing file contents. Use for surgical edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          old_str: { type: "string", description: "Exact text to replace (must match verbatim including whitespace)" },
          new_str: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "If true, replace every occurrence; otherwise require a unique match (default false)" },
        },
        required: ["path", "old_str", "new_str"],
      },
      handler: async (args) => {
        const rel = String(args.path);
        const oldStr = String(args.old_str);
        const newStr = String(args.new_str ?? "");
        if (!oldStr) return "Error: old_str must be non-empty";
        let current: string | null;
        try { current = await applier.readFile(rel); } catch (err) {
          if (err instanceof PathOutsideWorkspaceError) return `Error: path outside workspace: ${rel}`;
          throw err;
        }
        if (current == null) return `Error: file not found: ${rel}`;
        const occurrences = countOccurrences(current, oldStr);
        if (occurrences === 0) return `Error: old_str not found in ${rel}`;
        if (!args.replace_all && occurrences > 1) return `Error: old_str matches ${occurrences} locations in ${rel}. Provide more context to make it unique, or pass replace_all=true.`;
        const { text: updated, count } = replaceAll(current, oldStr, newStr);
        const diff = unifiedDiff(current, updated, { fromLabel: rel, toLabel: rel });
        await applier.writeFile(rel, updated);
        const edit: EditProposal = { id: mkEditId(), kind: "str-replace", path: rel, oldContents: current, newContents: updated, diff, replacedOccurrences: count };
        emit(edit);
        await afterWrite(rel, updated);
        return `Edited ${rel}: replaced ${count} occurrence${count === 1 ? "" : "s"}`;
      },
    },
    {
      name: "create-file",
      mutates: true,
      description: "Create a new file with the given contents. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to workspace root" },
          contents: { type: "string", description: "Full file contents" },
        },
        required: ["path", "contents"],
      },
      handler: async (args) => {
        const rel = String(args.path);
        const contents = String(args.contents ?? "");
        try {
          if (await applier.fileExists(rel)) return `Error: file already exists: ${rel}`;
        } catch (err) {
          if (err instanceof PathOutsideWorkspaceError) return `Error: path outside workspace: ${rel}`;
          throw err;
        }
        const diff = unifiedDiff("", contents, { fromLabel: "/dev/null", toLabel: rel });
        await applier.writeFile(rel, contents);
        const edit: EditProposal = { id: mkEditId(), kind: "create", path: rel, oldContents: "", newContents: contents, diff };
        emit(edit);
        await afterWrite(rel, contents);
        return `Created ${rel} (${contents.length} bytes)`;
      },
    },
    {
      name: "remove-file",
      mutates: true,
      description: "Delete a file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path relative to workspace root" } },
        required: ["path"],
      },
      handler: async (args) => {
        const rel = String(args.path);
        let current: string | null;
        try { current = await applier.readFile(rel); } catch (err) {
          if (err instanceof PathOutsideWorkspaceError) return `Error: path outside workspace: ${rel}`;
          throw err;
        }
        if (current == null) return `Error: file not found: ${rel}`;
        const diff = unifiedDiff(current, "", { fromLabel: rel, toLabel: "/dev/null" });
        const removed = await applier.removeFile(rel);
        if (!removed) return `Error: failed to remove ${rel}`;
        const edit: EditProposal = { id: mkEditId(), kind: "remove", path: rel, oldContents: current, newContents: "", diff };
        emit(edit);
        if (reindex) { try { await context.removeFromIndex([rel]); } catch {} }
        return `Removed ${rel}`;
      },
    },
    {
      name: "view-range",
      description: "View a specific line range of a file. start_line/end_line are 1-based and inclusive.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "number" },
          end_line: { type: "number" },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const rel = String(args.path);
        let full: string | null;
        try { full = await applier.readFile(rel); } catch (err) {
          if (err instanceof PathOutsideWorkspaceError) return `Error: path outside workspace: ${rel}`;
          throw err;
        }
        if (full == null) return `Error: file not found: ${rel}`;
        const lines = full.split("\n");
        const s = Math.max(1, Number(args.start_line ?? 1));
        const e = Math.min(lines.length, Number(args.end_line ?? lines.length));
        const numbered = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join("\n");
        return `${rel} (${s}-${e} of ${lines.length}):\n${numbered}`;
      },
    },
  ];
}
