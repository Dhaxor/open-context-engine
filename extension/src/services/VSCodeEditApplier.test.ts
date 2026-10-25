import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { VSCodeEditApplier } from "./VSCodeEditApplier";

// the applier canonicalizes the root with realpath, so it must exist on every OS
const root = fs.mkdtempSync(path.join(os.tmpdir(), "oce-applier-"));
beforeEach(() => { vscode.workspace._files = new Map(); vscode.workspace._stats = new Set(); vscode.workspace.textDocuments = []; vscode.workspace._applyEditResult = true; });

describe("VSCodeEditApplier", () => {
  it("creates and reads files through VS Code workspace edits", async () => {
    const applier = new VSCodeEditApplier(root);
    await applier.writeFile("src/a.ts", "export const a = 1;\n");
    expect(await applier.readFile("src/a.ts")).toBe("export const a = 1;\n");
    expect(await applier.fileExists("src/a.ts")).toBe(true);
  });
  it("rejects paths outside the workspace", async () => {
    await expect(new VSCodeEditApplier(root).writeFile("../escape.txt", "x")).rejects.toThrow(/Path outside workspace/);
  });
  it("deletes files with ignore-if-missing semantics", async () => {
    const applier = new VSCodeEditApplier(root); await applier.writeFile("a.txt", "x");
    expect(await applier.removeFile("a.txt")).toBe(true); expect(await applier.fileExists("a.txt")).toBe(false);
  });
});
