import { describe, it, expect, beforeEach } from "vitest";
import { editTools, EditApplier } from "./edit-tools";
import { EditProposal, ToolDefinition } from "./types";

class MemApplier implements EditApplier {
  files = new Map<string, string>();
  async readFile(rel: string) { return this.files.has(rel) ? this.files.get(rel)! : null; }
  async writeFile(rel: string, c: string) { this.files.set(rel, c); }
  async removeFile(rel: string) { return this.files.delete(rel); }
  async fileExists(rel: string) { return this.files.has(rel); }
}

const fakeContext: any = {
  addFiles: async () => {},
  removeFromIndex: async () => {},
  getWorkspaceRoot: () => "/tmp",
};

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

describe("edit-tools: str-replace", () => {
  let applier: MemApplier;
  let tools: ToolDefinition[];
  let edits: EditProposal[];
  beforeEach(() => {
    applier = new MemApplier();
    edits = [];
    tools = editTools({ context: fakeContext, applier, reindexOnEdit: false, onEdit: e => edits.push(e) });
  });

  it("replaces a unique substring and emits a proposal", async () => {
    applier.files.set("a.ts", "const x = 1;\nconst y = 2;\n");
    const t = byName(tools, "str-replace");
    const r = await t.handler({ path: "a.ts", old_str: "const y = 2;", new_str: "const y = 99;" });
    expect(r).toMatch(/replaced 1 occurrence/);
    expect(applier.files.get("a.ts")).toBe("const x = 1;\nconst y = 99;\n");
    expect(edits).toHaveLength(1);
    expect(edits[0].kind).toBe("str-replace");
    expect(edits[0].diff).toContain("-const y = 2;");
    expect(edits[0].diff).toContain("+const y = 99;");
  });

  it("fails on missing file", async () => {
    const t = byName(tools, "str-replace");
    const r = await t.handler({ path: "nope.ts", old_str: "x", new_str: "y" });
    expect(r).toMatch(/file not found/);
    expect(edits).toHaveLength(0);
  });

  it("fails when old_str is absent", async () => {
    applier.files.set("a.ts", "hello");
    const t = byName(tools, "str-replace");
    const r = await t.handler({ path: "a.ts", old_str: "world", new_str: "x" });
    expect(r).toMatch(/not found in/);
  });

  it("requires uniqueness unless replace_all is set", async () => {
    applier.files.set("a.ts", "foo\nfoo\nfoo\n");
    const t = byName(tools, "str-replace");
    const r = await t.handler({ path: "a.ts", old_str: "foo", new_str: "bar" });
    expect(r).toMatch(/matches 3 locations/);
    expect(applier.files.get("a.ts")).toBe("foo\nfoo\nfoo\n");
    const r2 = await t.handler({ path: "a.ts", old_str: "foo", new_str: "bar", replace_all: true });
    expect(r2).toMatch(/replaced 3/);
    expect(applier.files.get("a.ts")).toBe("bar\nbar\nbar\n");
  });
});

describe("edit-tools: create-file", () => {
  it("creates when missing", async () => {
    const applier = new MemApplier();
    const edits: EditProposal[] = [];
    const tools = editTools({ context: fakeContext, applier, reindexOnEdit: false, onEdit: e => edits.push(e) });
    const t = byName(tools, "create-file");
    const r = await t.handler({ path: "new.md", contents: "# hi\n" });
    expect(r).toMatch(/Created new.md/);
    expect(applier.files.get("new.md")).toBe("# hi\n");
    expect(edits[0].kind).toBe("create");
    expect(edits[0].diff).toContain("+# hi");
  });

  it("refuses when file exists", async () => {
    const applier = new MemApplier();
    applier.files.set("x.txt", "old");
    const tools = editTools({ context: fakeContext, applier, reindexOnEdit: false });
    const r = await byName(tools, "create-file").handler({ path: "x.txt", contents: "new" });
    expect(r).toMatch(/already exists/);
    expect(applier.files.get("x.txt")).toBe("old");
  });
});

describe("edit-tools: remove-file", () => {
  it("removes and emits proposal", async () => {
    const applier = new MemApplier();
    applier.files.set("gone.md", "bye");
    const edits: EditProposal[] = [];
    const tools = editTools({ context: fakeContext, applier, reindexOnEdit: false, onEdit: e => edits.push(e) });
    const r = await byName(tools, "remove-file").handler({ path: "gone.md" });
    expect(r).toMatch(/Removed/);
    expect(applier.files.has("gone.md")).toBe(false);
    expect(edits[0].kind).toBe("remove");
    expect(edits[0].diff).toContain("-bye");
  });
  it("errors when missing", async () => {
    const applier = new MemApplier();
    const tools = editTools({ context: fakeContext, applier, reindexOnEdit: false });
    const r = await byName(tools, "remove-file").handler({ path: "nope" });
    expect(r).toMatch(/file not found/);
  });
});

describe("edit-tools: view-range", () => {
  it("returns numbered slice", async () => {
    const applier = new MemApplier();
    applier.files.set("a.ts", ["a", "b", "c", "d", "e"].join("\n"));
    const tools = editTools({ context: fakeContext, applier, reindexOnEdit: false });
    const r = await byName(tools, "view-range").handler({ path: "a.ts", start_line: 2, end_line: 4 });
    expect(r).toContain("a.ts (2-4 of 5)");
    expect(r).toContain("b");
    expect(r).toContain("c");
    expect(r).toContain("d");
    expect(r).not.toMatch(/\s1\s+a/);
  });
});
