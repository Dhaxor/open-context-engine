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
export interface EditScope {
    root: string;
    reindex?: (path: string, contents: string | null) => Promise<void>;
}

export class EditReviewService implements vscode.Disposable {
    private edits = new Map<string, ReviewedEdit>();
    private scopes = new Map<string, EditScope>();
    private order: string[] = [];
    private seq = 0;
    private readonly disposable: vscode.Disposable;

    constructor(private readonly resolveRoot: () => Promise<string>) {
        const provider: vscode.TextDocumentContentProvider = {
            provideTextDocumentContent: (uri) => this.virtualContent(uri),
        };
        this.disposable = vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider);
    }

    /**
     * `scope` is where the edit landed when that is not the indexed workspace —
     * a parallel session's worktree — so undo/redo write (and re-index) there
     * rather than into the main checkout.
     */
    record(edit: EditProposal, scope?: EditScope): ReviewedEdit {
        const reviewed: ReviewedEdit = { ...edit, seq: ++this.seq, status: "applied" };
        this.edits.set(edit.id, reviewed);
        this.order.push(edit.id);
        if (scope) this.scopes.set(edit.id, scope);
        return reviewed;
    }

    /**
     * Every given edit in one multi-file diff editor — how a turn's changes are
     * reviewed as a whole. The latest edit per file wins the "after" side and
     * the earliest supplies "before", so a file edited three times reads as one
     * change, not three.
     */
    async openChanges(ids: string[], title: string): Promise<void> {
        const byPath = new Map<string, { first: ReviewedEdit; last: ReviewedEdit }>();
        for (const id of ids) {
            const edit = this.edits.get(id);
            if (!edit) continue;
            const seen = byPath.get(edit.path);
            if (seen) seen.last = edit; else byPath.set(edit.path, { first: edit, last: edit });
        }
        if (!byPath.size) return;
        if (byPath.size === 1) {
            const [{ first, last }] = byPath.values();
            if (first === last) return this.openDiff(first.id);
        }
        const root = await this.resolveRoot();
        const resources = [...byPath.values()].map(({ first, last }) => [
            vscode.Uri.file(path.resolve(this.scopes.get(last.id)?.root ?? root, last.path)),
            this.virtualUri(first, "before"),
            this.virtualUri(last, "after"),
        ]);
        await vscode.commands.executeCommand("vscode.changes", title, resources);
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
        this.scopes.clear();
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
        const scope = this.scopes.get(edit.id);
        const root = scope?.root ?? await this.resolveRoot();
        const applier = new VSCodeEditApplier(root);
        const reindex = scope?.reindex ?? (async (p: string, contents: string | null) => {
            const ctx = await ContextService.getInstance().getContext();
            if (contents === null) await ctx.removeFromIndex([p]);
            else await ctx.addFiles([{ path: p, contents }]);
        });

        const wantDeleted =
            (direction === "undo" && edit.kind === "create") ||
            (direction === "redo" && edit.kind === "remove");
        const target = direction === "undo" ? edit.oldContents : edit.newContents;

        if (wantDeleted) {
            await applier.removeFile(edit.path);
            try { await reindex(edit.path, null); } catch {}
            return;
        }
        await applier.writeFile(edit.path, target ?? "");
        try { await reindex(edit.path, target ?? ""); } catch {}
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
