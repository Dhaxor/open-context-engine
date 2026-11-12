import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { EditReviewService } from "./EditReviewService";

const index = { added: [] as any[], removed: [] as any[], addFiles: vi.fn(async (f) => index.added.push(...f)), removeFromIndex: vi.fn(async (p) => index.removed.push(...p)) };
vi.mock("./ContextService", () => ({ ContextService: { getInstance: () => ({ getContext: async () => index }) } }));

// undo/redo resolve the workspace root with realpath, so it must exist on every OS
const root = fs.mkdtempSync(path.join(os.tmpdir(), "oce-review-"));
const rootOf = async () => root;

beforeEach(() => { index.added = []; index.removed = []; vi.clearAllMocks(); vscode.commands._calls = []; vscode.workspace._files = new Map(); vscode.workspace._stats = new Set(); });

describe("EditReviewService", () => {
  it("records edits in order and opens virtual before/after diffs", async () => {
    const svc = new EditReviewService(rootOf);
    const edit = svc.record({ id: "e1", kind: "str-replace", path: "a.ts", oldContents: "old", newContents: "new", diff: "diff" } as any);
    expect(edit.seq).toBe(1); expect(svc.appliedEdits()).toHaveLength(1);
    await svc.openDiff("e1");
    expect(vscode.commands._calls[0][0]).toBe("vscode.diff");
    expect(vscode.workspace._providers.get("open-context-diff").provideTextDocumentContent(vscode.commands._calls[0][1])).toBe("old");
    svc.dispose();
  });
  it("undoes and redoes file state while updating the index", async () => {
    const svc = new EditReviewService(rootOf);
    svc.record({ id: "e1", kind: "str-replace", path: "a.ts", oldContents: "old", newContents: "new", diff: "" } as any);
    await svc.undo("e1"); expect(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, "a.ts"))).then(b => new TextDecoder().decode(b))).toBe("old");
    expect(index.added[0]).toEqual({ path: "a.ts", contents: "old" });
    await svc.redo("e1"); expect(index.added[1]).toEqual({ path: "a.ts", contents: "new" });
  });
  it("undoAll reverts applied edits newest first", async () => {
    const svc = new EditReviewService(rootOf);
    svc.record({ id: "create", kind: "create", path: "new.ts", oldContents: null, newContents: "x", diff: "" } as any);
    svc.record({ id: "remove", kind: "remove", path: "old.ts", oldContents: "y", newContents: null, diff: "" } as any);
    expect(await svc.undoAll()).toBe(2);
    expect(index.added[0]).toEqual({ path: "old.ts", contents: "y" });
    expect(index.removed[0]).toBe("new.ts");
  });
  it("combinedDiff folds a file's edits into one git-style diff and skips undone ones", async () => {
    const svc = new EditReviewService(rootOf);
    svc.record({ id: "e1", kind: "str-replace", path: "a.ts", oldContents: "one\n", newContents: "two\n", diff: "" } as any);
    svc.record({ id: "e2", kind: "str-replace", path: "a.ts", oldContents: "two\n", newContents: "three\n", diff: "" } as any);
    svc.record({ id: "e3", kind: "create", path: "b.ts", newContents: "new\n", diff: "" } as any);
    svc.record({ id: "e4", kind: "remove", path: "c.ts", oldContents: "gone\n", diff: "" } as any);
    svc.record({ id: "e5", kind: "create", path: "d.ts", newContents: "undone\n", diff: "" } as any);
    await svc.undo("e5");

    const { diff, deletedFiles } = svc.combinedDiff(["e1", "e2", "e3", "e4", "e5"]);
    // Earliest "before" against latest "after": the intermediate "two" never shows.
    expect(diff).toContain("+++ b/a.ts");
    expect(diff).toContain("-one");
    expect(diff).toContain("+three");
    expect(diff).not.toContain("two");
    expect(diff).toContain("+++ b/b.ts");
    expect(diff).not.toContain("d.ts");
    expect(deletedFiles).toEqual(["c.ts"]);
  });
});
