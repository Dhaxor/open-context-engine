import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { VSCodeEditApplier } from "./VSCodeEditApplier";

// the applier canonicalizes the root with realpath, so it must exist on every OS
const root = fs.mkdtempSync(path.join(os.tmpdir(), "oce-applier-"));
beforeEach(() => { vscode.workspace._files = new Map(); vscode.workspace._stats = new Set(); vscode.workspace.textDocuments = []; vscode.workspace._applyEditResult = true; vscode.workspace._dirty = new Set(); vscode.workspace._saves = []; vscode.workspace._saveResult = true; });

describe("VSCodeEditApplier", () => {
  it("creates and reads files through VS Code workspace edits", async () => {
    const applier = new VSCodeEditApplier(root);
    await applier.writeFile("src/a.ts", "export const a = 1;\n");
    expect(await applier.readFile("src/a.ts")).toBe("export const a = 1;\n");
    expect(await applier.fileExists("src/a.ts")).toBe(true);
  });
  it("saves the agent's edit to disk — a new file must not stay an unsaved buffer", async () => {
    // Applying an edit leaves the document dirty; checking isDirty after it
    // skipped every save, so files reached disk empty (found by test/e2e).
    const applier = new VSCodeEditApplier(root);
    await applier.writeFile("src/new.ts", "export const n = 1;\n");
    expect(vscode.workspace._saves).toHaveLength(1);
    expect(vscode.workspace._saves[0]).toMatch(/new\.ts$/);
    expect(vscode.workspace._dirty.size).toBe(0);
  });
  it("leaves a buffer with the user's own unsaved changes unsaved", async () => {
    const applier = new VSCodeEditApplier(root);
    await applier.writeFile("open.ts", "on disk");
    const file = vscode.workspace._saves[0];
    vscode.workspace._saves = [];
    vscode.workspace._dirty.add(file); // the user is mid-edit in this buffer
    vscode.workspace.textDocuments = [await vscode.workspace.openTextDocument(vscode.Uri.file(file))];
    await applier.writeFile("open.ts", "agent edit");
    expect(vscode.workspace._saves).toEqual([]);
  });
  it("tells the agent when its edit could not be saved", async () => {
    vscode.workspace._saveResult = false;
    await expect(new VSCodeEditApplier(root).writeFile("b.ts", "x")).rejects.toThrow(/could not save/);
  });
  it("rejects paths outside the workspace", async () => {
    await expect(new VSCodeEditApplier(root).writeFile("../escape.txt", "x")).rejects.toThrow(/Path outside workspace/);
  });
  it("deletes files with ignore-if-missing semantics", async () => {
    const applier = new VSCodeEditApplier(root); await applier.writeFile("a.txt", "x");
    expect(await applier.removeFile("a.txt")).toBe(true); expect(await applier.fileExists("a.txt")).toBe(false);
  });
});
