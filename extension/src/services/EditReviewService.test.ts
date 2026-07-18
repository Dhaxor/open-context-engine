import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { EditReviewService } from "./EditReviewService";

const index = { added: [] as any[], removed: [] as any[], addFiles: vi.fn(async (f) => index.added.push(...f)), removeFromIndex: vi.fn(async (p) => index.removed.push(...p)) };
vi.mock("./ContextService", () => ({ ContextService: { getInstance: () => ({ getContext: async () => index }) } }));

beforeEach(() => { index.added = []; index.removed = []; vi.clearAllMocks(); vscode.commands._calls = []; vscode.workspace._files = new Map(); vscode.workspace._stats = new Set(); });

describe("EditReviewService", () => {
  it("records edits in order and opens virtual before/after diffs", async () => {
    const svc = new EditReviewService(async () => "/tmp/root");
    const edit = svc.record({ id: "e1", kind: "str-replace", path: "a.ts", oldContents: "old", newContents: "new", diff: "diff" } as any);
    expect(edit.seq).toBe(1); expect(svc.appliedEdits()).toHaveLength(1);
    await svc.openDiff("e1");
    expect(vscode.commands._calls[0][0]).toBe("vscode.diff");
    expect(vscode.workspace._providers.get("open-context-diff").provideTextDocumentContent(vscode.commands._calls[0][1])).toBe("old");
    svc.dispose();
  });
  it("undoes and redoes file state while updating the index", async () => {
    const svc = new EditReviewService(async () => "/tmp/root");
    svc.record({ id: "e1", kind: "str-replace", path: "a.ts", oldContents: "old", newContents: "new", diff: "" } as any);
    await svc.undo("e1"); expect(await vscode.workspace.fs.readFile(vscode.Uri.file("/tmp/root/a.ts")).then(b => new TextDecoder().decode(b))).toBe("old");
    expect(index.added[0]).toEqual({ path: "a.ts", contents: "old" });
    await svc.redo("e1"); expect(index.added[1]).toEqual({ path: "a.ts", contents: "new" });
  });
  it("undoAll reverts applied edits newest first", async () => {
    const svc = new EditReviewService(async () => "/tmp/root");
    svc.record({ id: "create", kind: "create", path: "new.ts", oldContents: null, newContents: "x", diff: "" } as any);
    svc.record({ id: "remove", kind: "remove", path: "old.ts", oldContents: "y", newContents: null, diff: "" } as any);
    expect(await svc.undoAll()).toBe(2);
    expect(index.added[0]).toEqual({ path: "old.ts", contents: "y" });
    expect(index.removed[0]).toBe("new.ts");
  });
});
