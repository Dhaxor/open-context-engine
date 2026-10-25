import { describe, it, expect } from "vitest";
import { EditApplier } from "../agent/edit-tools";
import { EditProposal } from "../agent/types";
import { CheckpointStore } from "./checkpoints";

class MemoryApplier implements EditApplier {
  constructor(public files = new Map<string, string>()) {}
  async readFile(p: string): Promise<string | null> { return this.files.has(p) ? this.files.get(p)! : null; }
  async writeFile(p: string, c: string): Promise<void> { this.files.set(p, c); }
  async removeFile(p: string): Promise<boolean> { return this.files.delete(p); }
  async fileExists(p: string): Promise<boolean> { return this.files.has(p); }
}

let n = 0;
function edit(over: Partial<EditProposal> & { path: string }): EditProposal {
  return { id: `e${++n}`, kind: "str-replace", diff: "", ...over };
}

function store(applier: EditApplier, onRestored?: (p: string[]) => void) {
  return new CheckpointStore({ applier, onRestored });
}

/** Commit a turn at a fake chain position. */
function commit(s: CheckpointStore, seq: number, hash: string, prev = "") {
  return s.commit({ seq, hash, prev, label: `turn ${seq}`, turn: seq });
}

describe("CheckpointStore", () => {
  it("groups edits into the turn that was in flight", () => {
    const s = store(new MemoryApplier());
    s.noteEdit(edit({ path: "a.ts" }));
    s.noteEdit(edit({ path: "b.ts" }));
    const first = commit(s, 1, "aaaa1111");
    s.noteEdit(edit({ path: "c.ts" }));
    const second = commit(s, 2, "bbbb2222", "aaaa1111");

    expect(first.filesTouched).toBe(2);
    expect(second.filesTouched).toBe(1);
    expect(s.list().map(c => c.short)).toEqual(["aaaa", "bbbb"]);
  });

  it("marks a turn with no edits as not restorable", () => {
    const s = store(new MemoryApplier());
    expect(commit(s, 1, "aaaa1111").restorable).toBe(false);
  });

  it("restores file contents from before the dropped turns", async () => {
    const files = new Map([["a.ts", "v3"]]);
    const s = store(new MemoryApplier(files));
    commit(s, 1, "aaaa1111");
    s.noteEdit(edit({ path: "a.ts", oldContents: "v1", newContents: "v2" }));
    commit(s, 2, "bbbb2222");
    s.noteEdit(edit({ path: "a.ts", oldContents: "v2", newContents: "v3" }));
    commit(s, 3, "cccc3333");

    const result = await s.rewindTo("aaaa1111");
    // Unwinding newest-first walks v3 → v2 → v1; the other order would leave v2.
    expect(files.get("a.ts")).toBe("v1");
    expect(result.checkpointsDropped).toBe(2);
    expect(result.filesRestored).toEqual(["a.ts"]);
    expect(result.turn).toBe(1);
    expect(s.list()).toHaveLength(1);
  });

  it("deletes files the agent created", async () => {
    const files = new Map([["new.ts", "hello"]]);
    const s = store(new MemoryApplier(files));
    commit(s, 1, "aaaa1111");
    s.noteEdit(edit({ path: "new.ts", kind: "create", oldContents: "", newContents: "hello" }));
    commit(s, 2, "bbbb2222");

    await s.rewindTo("aaaa1111");
    expect(files.has("new.ts")).toBe(false);
  });

  it("brings back files the agent removed", async () => {
    const files = new Map<string, string>();
    const s = store(new MemoryApplier(files));
    commit(s, 1, "aaaa1111");
    s.noteEdit(edit({ path: "gone.ts", kind: "remove", oldContents: "ORIGINAL", newContents: "" }));
    commit(s, 2, "bbbb2222");

    await s.rewindTo("aaaa1111");
    expect(files.get("gone.ts")).toBe("ORIGINAL");
  });

  it("refuses to clobber a file the user changed by hand", async () => {
    const files = new Map([["a.ts", "MY OWN EDIT"]]);
    const s = store(new MemoryApplier(files));
    commit(s, 1, "aaaa1111");
    s.noteEdit(edit({ path: "a.ts", oldContents: "v1", newContents: "v2" }));
    commit(s, 2, "bbbb2222");

    const result = await s.rewindTo("aaaa1111");
    expect(files.get("a.ts")).toBe("MY OWN EDIT");
    expect(result.filesRestored).toEqual([]);
    expect(result.filesSkipped).toEqual([{ path: "a.ts", reason: "modified since the agent edited it" }]);
  });

  it("unwinds edits from a turn still in flight", async () => {
    const files = new Map([["a.ts", "v2"]]);
    const s = store(new MemoryApplier(files));
    commit(s, 1, "aaaa1111");
    s.noteEdit(edit({ path: "a.ts", oldContents: "v1", newContents: "v2" }));

    await s.rewindTo("aaaa1111");
    expect(files.get("a.ts")).toBe("v1");
    // The in-flight edits are consumed, so committing next does not re-apply them.
    expect(commit(s, 2, "bbbb2222").filesTouched).toBe(0);
  });

  it("reports what a rewind would touch before doing it", () => {
    const s = store(new MemoryApplier());
    commit(s, 1, "aaaa1111");
    s.noteEdit(edit({ path: "a.ts" }));
    s.noteEdit(edit({ path: "b.ts" }));
    commit(s, 2, "bbbb2222");
    s.noteEdit(edit({ path: "a.ts" }));

    expect(s.changedSince("aaaa1111").sort()).toEqual(["a.ts", "b.ts"]);
    expect(s.changedSince("nope")).toEqual([]);
  });

  it("notifies so the index can be refreshed", async () => {
    const files = new Map([["a.ts", "v2"]]);
    let restored: string[] = [];
    const s = store(new MemoryApplier(files), p => { restored = p; });
    commit(s, 1, "aaaa1111");
    s.noteEdit(edit({ path: "a.ts", oldContents: "v1", newContents: "v2" }));
    commit(s, 2, "bbbb2222");

    await s.rewindTo("aaaa1111");
    expect(restored).toEqual(["a.ts"]);
  });

  it("rejects an unknown checkpoint instead of silently doing nothing", async () => {
    const s = store(new MemoryApplier());
    await expect(s.rewindTo("deadbeef")).rejects.toThrow(/No checkpoint deadbeef/);
  });
});
