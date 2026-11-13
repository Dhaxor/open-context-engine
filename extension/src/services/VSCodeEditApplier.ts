import * as path from "path";
import * as vscode from "vscode";
import { EditApplier } from "../../../src/agent/edit-tools";
import { resolveWorkspacePath } from "../../../src/core/utils";

export class VSCodeEditApplier implements EditApplier {
    constructor(private workspaceRoot: string) {}

    private uri(rel: string): vscode.Uri {
        // Containment: model-supplied paths must stay inside the workspace.
        return vscode.Uri.file(resolveWorkspacePath(this.workspaceRoot, rel));
    }

    async readFile(rel: string): Promise<string | null> {
        try {
            const uri = this.uri(rel);
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
            if (doc) return doc.getText();
            const bytes = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(bytes);
        } catch {
            return null;
        }
    }

    async writeFile(rel: string, contents: string): Promise<void> {
        const uri = this.uri(rel);
        const dir = path.dirname(uri.fsPath);
        try { await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir)); } catch {}
        const existingDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
        // Read BEFORE the edit: applying it always leaves the buffer dirty, so
        // "is it dirty?" afterwards cannot tell the user's unsaved work apart
        // from the agent's own change.
        const userHadUnsavedChanges = existingDoc?.isDirty ?? false;
        let exists = true;
        try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
        const edit = new vscode.WorkspaceEdit();
        if (!exists) {
            edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
            edit.insert(uri, new vscode.Position(0, 0), contents);
        } else if (existingDoc) {
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                existingDoc.lineAt(existingDoc.lineCount - 1).range.end,
            );
            edit.replace(uri, fullRange, contents);
        } else {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const currentLen = new TextDecoder().decode(bytes).length;
            const endPos = offsetToPosition(new TextDecoder().decode(bytes), currentLen);
            edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), endPos), contents);
        }
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) throw new Error(`Failed to apply edit to ${rel}`);
        // Persist the edit: tests, builds, git, and the agent's own shell
        // commands read the disk, not the buffer. The one exception is a buffer
        // the user was already editing — saving would commit their unsaved
        // work for them, so the agent's change stays in it, unsaved, beside it.
        if (userHadUnsavedChanges) return;
        const doc = existingDoc ?? await vscode.workspace.openTextDocument(uri);
        if (doc.isDirty && !(await doc.save())) {
            throw new Error(`Edited ${rel} but could not save it to disk`);
        }
    }

    async removeFile(rel: string): Promise<boolean> {
        try {
            const uri = this.uri(rel);
            const edit = new vscode.WorkspaceEdit();
            edit.deleteFile(uri, { ignoreIfNotExists: true });
            return await vscode.workspace.applyEdit(edit);
        } catch {
            return false;
        }
    }

    async fileExists(rel: string): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(this.uri(rel));
            return true;
        } catch {
            return false;
        }
    }
}

function offsetToPosition(text: string, offset: number): vscode.Position {
    let line = 0, col = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === "\n") { line++; col = 0; }
        else col++;
    }
    return new vscode.Position(line, col);
}
