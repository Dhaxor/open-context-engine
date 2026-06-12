import { describe, it, expect } from "vitest";
import { defaultAgentTools } from "./agent";
import { OpenContext } from "../core/context";
import { Chunk } from "../core/types";

const fakeContext = { getWorkspaceRoot: () => "/tmp/ws" } as unknown as OpenContext;
const names = (tools: { name: string }[]) => tools.map(t => t.name);

describe("defaultAgentTools", () => {
  it("is read-only by default (no edits, no shell, no web)", () => {
    const tools = defaultAgentTools({ context: fakeContext });
    expect(names(tools)).toEqual(["codebase-retrieval", "list-files", "read-file", "find-symbol-definition", "find-symbol-references"]);
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

describe("symbol tools", () => {
  const chunk = (over: Partial<Chunk>): Chunk => ({
    id: "c1",
    path: "src/core/retriever.ts",
    startLine: 100,
    endLine: 130,
    contents: "export function reciprocalRankFusion(lists) {\n  return fuse(lists);\n}",
    symbolName: "reciprocalRankFusion",
    symbolKind: "function",
    language: "typescript",
    ...over,
  } as Chunk);

  function toolsFor(ctx: Partial<Record<string, unknown>>) {
    const c = { getWorkspaceRoot: () => "/tmp/ws", ...ctx } as unknown as OpenContext;
    const tools = defaultAgentTools({ context: c });
    return {
      def: tools.find(t => t.name === "find-symbol-definition")!,
      refs: tools.find(t => t.name === "find-symbol-references")!,
    };
  }

  it("find-symbol-definition renders kind, location, and source", async () => {
    const { def } = toolsFor({ findSymbolDefinitions: () => [chunk({})] });
    const out = String(await def.handler({ symbol: "reciprocalRankFusion" }));
    expect(out).toContain("function reciprocalRankFusion");
    expect(out).toContain("src/core/retriever.ts:100-130");
    expect(out).toContain("```typescript");
  });

  it("find-symbol-definition explains a miss and suggests fallbacks", async () => {
    const { def } = toolsFor({ findSymbolDefinitions: () => [] });
    const out = String(await def.handler({ symbol: "noSuchThing" }));
    expect(out).toContain("No definition found");
    expect(out).toContain("codebase-retrieval");
  });

  it("find-symbol-references reports file:line for each matching line and tags the definition", async () => {
    const refs1 = chunk({}); // the defining chunk
    const refs2 = chunk({
      id: "c2", path: "src/core/context.ts", startLine: 50, endLine: 60,
      symbolName: "search", contents: "const fused = reciprocalRankFusion(lists);\nreturn fused;",
    });
    const { refs } = toolsFor({ findSymbolReferences: () => [refs1, refs2] });
    const out = String(await refs.handler({ symbol: "reciprocalRankFusion" }));
    expect(out).toContain("[definition]");
    expect(out).toContain("src/core/context.ts:50:");
    expect(out).toContain("const fused = reciprocalRankFusion(lists);");
  });

  it("find-symbol-references does not match substrings of longer identifiers", async () => {
    const c = chunk({
      id: "c3", path: "src/x.ts", startLine: 1, endLine: 3, symbolName: "other",
      contents: "useRanker();\nreciprocalRankFusionPlus();\n",
    });
    const { refs } = toolsFor({ findSymbolReferences: () => [c] });
    const out = String(await refs.handler({ symbol: "reciprocalRankFusion" }));
    // chunk is returned by the store layer, but no line passes the
    // word-boundary check — only the location header should render.
    expect(out).toContain("src/x.ts:1-3");
    expect(out).not.toContain("reciprocalRankFusionPlus");
  });
});
