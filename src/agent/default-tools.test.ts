import { describe, it, expect } from "vitest";
import { defaultAgentTools } from "./agent";
import { OpenContext } from "../core/context";

const fakeContext = { getWorkspaceRoot: () => "/tmp/ws" } as unknown as OpenContext;
const names = (tools: { name: string }[]) => tools.map(t => t.name);

describe("defaultAgentTools", () => {
  it("is read-only by default (no edits, no shell, no web)", () => {
    const tools = defaultAgentTools({ context: fakeContext });
    expect(names(tools)).toEqual(["codebase-retrieval", "list-files", "read-file"]);
  });

  it("adds edit tools only when includeEdits is set", () => {
    const tools = defaultAgentTools({ context: fakeContext, includeEdits: true });
    expect(names(tools)).toContain("str-replace");
    expect(names(tools)).toContain("create-file");
  });

  it("adds the shell tool only when shell is enabled", () => {
    expect(names(defaultAgentTools({ context: fakeContext }))).not.toContain("run-command");
    expect(names(defaultAgentTools({ context: fakeContext, shell: true }))).toContain("run-command");
  });
});
