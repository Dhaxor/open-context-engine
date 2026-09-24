import { describe, it, expect } from "vitest";
import { findCitation, parseInline, parseMarkdown } from "./markdown";

describe("parseMarkdown — blocks", () => {
  it("separates paragraphs on blank lines", () => {
    const blocks = parseMarkdown("first line\nstill first\n\nsecond");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
  });

  it("reads headings with their level", () => {
    const [block] = parseMarkdown("## How retrieval works");
    expect(block).toMatchObject({ kind: "heading", level: 2 });
  });

  it("collects consecutive bullets into one list", () => {
    const blocks = parseMarkdown("- one\n- two\n- three");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "list" });
    expect((blocks[0] as any).items).toHaveLength(3);
  });

  it("captures a fence's language and file path", () => {
    const [block] = parseMarkdown("```ts src/core/retriever.ts\nconst x = 1;\n```");
    expect(block).toMatchObject({ kind: "fence", lang: "ts", path: "src/core/retriever.ts", open: false });
    expect((block as any).code).toBe("const x = 1;");
  });

  it("renders an unterminated fence as open rather than losing it", () => {
    // Text streams token by token, so a half-arrived code block is the normal
    // case, not an error.
    const blocks = parseMarkdown("Here:\n```ts\nconst partial =");
    expect(blocks[1]).toMatchObject({ kind: "fence", open: true });
    expect((blocks[1] as any).code).toBe("const partial =");
  });

  it("does not parse markdown inside a fence", () => {
    const [block] = parseMarkdown("```\n# not a heading\n- not a list\n```");
    expect(block.kind).toBe("fence");
    expect((block as any).code).toContain("# not a heading");
  });

  it("keeps the paragraph before a fence", () => {
    const blocks = parseMarkdown("Because:\n```ts\nx\n```");
    expect(blocks.map(b => b.kind)).toEqual(["paragraph", "fence"]);
  });

  it("returns nothing for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("reads inline code and bold", () => {
    expect(parseInline("call `retrieve()` then **stop**")).toEqual([
      { kind: "text", text: "call " },
      { kind: "code", text: "retrieve()" },
      { kind: "text", text: " then " },
      { kind: "strong", text: "stop" },
    ]);
  });

  it("lets code win over bold, so asterisks in code stay literal", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });

  it("passes plain text through unchanged", () => {
    expect(parseInline("nothing special")).toEqual([{ kind: "text", text: "nothing special" }]);
  });

  it("leaves an unmatched backtick alone rather than eating the rest", () => {
    expect(parseInline("an ` unmatched tick")).toEqual([{ kind: "text", text: "an ` unmatched tick" }]);
  });
});

describe("findCitation", () => {
  it("finds path:line and path:start-end", () => {
    expect(findCitation("see src/core/retriever.ts:118")).toEqual({
      path: "src/core/retriever.ts", startLine: 118, endLine: 118,
    });
    expect(findCitation("see src/a.ts:10-24 for detail")).toEqual({
      path: "src/a.ts", startLine: 10, endLine: 24,
    });
  });

  it("ignores prose that merely contains a colon and a number", () => {
    expect(findCitation("took 251ms: 12 results")).toBeNull();
    expect(findCitation("no citation here")).toBeNull();
  });
});
