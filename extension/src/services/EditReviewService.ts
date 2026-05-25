import * as path from "path";
import * as vscode from "vscode";
import { EditProposal } from "../../../src/agent/types";
import { ContextService } from "./ContextService";
import { VSCodeEditApplier } from "./VSCodeEditApplier";

export type EditStatus = "applied" | "undone";

export interface ReviewedEdit extends EditProposal {
    seq: number;
    status: EditStatus;
}

const DIFF_SCHEME = "open-context-diff";

/**
 * Tracks the file edits an agent turn applied and lets the user review them:
 * open a native before/after diff, undo (revert/delete/restore), and redo.
 *
 * EditProposal already carries oldContents/newContents, so undo/redo are exact
 * inverses applied through the same VS Code edit path used by the agent, and the
 * index is kept in sync after every revert.
 */
export class EditReviewService implements vscode.Disposable {
    private edits = new Map<string, ReviewedEdit>();
    private order: string[] = [];
    private seq = 0;
    private readonly disposable: vscode.Disposable;

    constructor(private readonly resolveRoot: () => Promise<string>) {
        const provider: vscode.TextDocumentContentProvider = {
            provideTextDocumentContent: (uri) => this.virtualContent(uri),
        };
        this.disposable = vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider);
    }

    record(edit: EditProposal): ReviewedEdit {
        const reviewed: ReviewedEdit = { ...edit, seq: ++this.seq, status: "applied" };
        this.edits.set(edit.id, reviewed);
        this.order.push(edit.id);
        return reviewed;
    }

    get(id: string): ReviewedEdit | undefined {
        return this.edits.get(id);
    }

    /** Applied edits in chronological order. */
    appliedEdits(): ReviewedEdit[] {
        return this.order.map(id => this.edits.get(id)!).filter(e => e && e.status === "applied");
    }

    /** Open a native side-by-side diff of the edit's before/after contents. */
    async openDiff(id: string): Promise<void> {
        const edit = this.edits.get(id);
        if (!edit) return;
        const left = this.virtualUri(edit, "before");
        const right = this.virtualUri(edit, "after");
        const title = `${path.basename(edit.path)} — agent edit (before ↔ after)`;
        await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
    }

    async undo(id: string): Promise<void> {
        const edit = this.edits.get(id);
        if (!edit || edit.status === "undone") return;
        await this.applyState(edit, "undo");
        edit.status = "undone";
    }

    async redo(id: string): Promise<void> {
        const edit = this.edits.get(id);
        if (!edit || edit.status === "applied") return;
        await this.applyState(edit, "redo");
        edit.status = "applied";
    }

    /** Undo every still-applied edit, most recent first. Returns how many were reverted. */
    async undoAll(): Promise<number> {
        return this.undoMany(this.order);
    }

    /** Undo the given edits (most recent first). Returns how many were reverted. */
    async undoMany(ids: string[]): Promise<number> {
        const set = new Set(ids);
        let n = 0;
        for (const id of [...this.order].reverse()) {
            if (!set.has(id)) continue;
            const edit = this.edits.get(id);
            if (edit && edit.status === "applied") { await this.undo(id); n++; }
        }
        return n;
    }

    /** Undo the most recent still-applied edit. Returns its path, or null if none. */
    async undoLast(): Promise<string | null> {
        for (const id of [...this.order].reverse()) {
            const edit = this.edits.get(id);
            if (edit && edit.status === "applied") { await this.undo(id); return edit.path; }
        }
        return null;
    }

    /** Forget tracked edits (e.g. on a new chat session). Does not touch files. */
    clear(): void {
        this.edits.clear();
        this.order = [];
    }

    dispose(): void {
        this.disposable.dispose();
    }

    /**
     * Materialize the target file state for an undo/redo and keep the index in sync.
     * undo  -> restore oldContents (or delete a created file).
     * redo  -> reapply newContents (or re-delete a removed file).
     */
    private async applyState(edit: ReviewedEdit, direction: "undo" | "redo"): Promise<void> {
        const root = await this.resolveRoot();
        const applier = new VSCodeEditApplier(root);
        const ctx = await ContextService.getInstance().getContext();

        const wantDeleted =
            (direction === "undo" && edit.kind === "create") ||
            (direction === "redo" && edit.kind === "remove");
        const target = direction === "undo" ? edit.oldContents : edit.newContents;

        if (wantDeleted) {
            await applier.removeFile(edit.path);
            try { await ctx.removeFromIndex([edit.path]); } catch {}
            return;
        }
        await applier.writeFile(edit.path, target ?? "");
        try { await ctx.addFiles([{ path: edit.path, contents: target ?? "" }]); } catch {}
    }

    private virtualUri(edit: ReviewedEdit, side: "before" | "after"): vscode.Uri {
        // Keep the real filename (with extension) last so VS Code infers the language.
        return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${side}/${edit.id}/${edit.path}` });
    }

    private virtualContent(uri: vscode.Uri): string {
        const parts = uri.path.replace(/^\//, "").split("/");
        const side = parts[0];
        const id = parts[1];
        const edit = this.edits.get(id);
        if (!edit) return "";
        return (side === "before" ? edit.oldContents : edit.newContents) ?? "";
    }
}
