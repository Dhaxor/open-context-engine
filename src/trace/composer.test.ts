import { describe, it, expect } from "vitest";
import {
  activeToken, applyCompletion, extractMentions, matchCommands,
  parseComposer, rankPaths, SLASH_COMMANDS,
} from "./composer";

describe("parseComposer", () => {
  it("treats ordinary text as a prompt", () => {
    expect(parseComposer("why does search degrade")).toEqual({
      kind: "prompt", text: "why does search degrade", mentions: [],
    });
  });

  it("reads a leading ! as a shell command", () => {
    expect(parseComposer("!npm test")).toEqual({ kind: "shell", command: "npm test" });
    expect(parseComposer("  !  git status  ")).toEqual({ kind: "shell", command: "git status" });
  });

  it("reads a leading / as a slash command with its argument", () => {
    expect(parseComposer("/mode full-auto")).toEqual({ kind: "command", name: "mode", args: "full-auto" });
    expect(parseComposer("/compact")).toEqual({ kind: "command", name: "compact", args: "" });
    expect(parseComposer("/MODE Full-Auto")).toEqual({ kind: "command", name: "mode", args: "Full-Auto" });
  });

  it("only treats ! and / as special at the start", () => {
    // "use !important" is prose, not a shell command.
    expect(parseComposer("use !important here").kind).toBe("prompt");
    expect(parseComposer("what does a/b do").kind).toBe("prompt");
  });

  it("is empty for whitespace and for a bare trigger", () => {
    expect(parseComposer("   ")).toEqual({ kind: "empty" });
    expect(parseComposer("!")).toEqual({ kind: "empty" });
    expect(parseComposer("/")).toEqual({ kind: "empty" });
  });

  it("collects @mentions from a prompt", () => {
    expect(parseComposer("compare @src/a.ts with @src/b.ts")).toEqual({
      kind: "prompt",
      text: "compare @src/a.ts with @src/b.ts",
      mentions: ["src/a.ts", "src/b.ts"],
    });
  });
});

describe("extractMentions", () => {
  it("trims trailing sentence punctuation", () => {
    // "look at @src/a.ts." means the file, not the full stop.
    expect(extractMentions("look at @src/a.ts.")).toEqual(["src/a.ts"]);
    expect(extractMentions("(see @src/a.ts)")).toEqual(["src/a.ts"]);
  });

  it("ignores an @ that does not start a word", () => {
    expect(extractMentions("mail me at dev@example.com")).toEqual([]);
  });

  it("de-duplicates while keeping order", () => {
    expect(extractMentions("@b.ts then @a.ts then @b.ts")).toEqual(["b.ts", "a.ts"]);
  });

  it("handles a mention at the very start", () => {
    expect(extractMentions("@src/a.ts explain this")).toEqual(["src/a.ts"]);
  });

  it("finds nothing in text without mentions", () => {
    expect(extractMentions("nothing here")).toEqual([]);
  });
});

describe("activeToken", () => {
  it("finds the mention being typed", () => {
    expect(activeToken("look at @src/re")).toEqual({ trigger: "@", query: "src/re", start: 8, end: 15 });
  });

  it("opens on a bare @", () => {
    expect(activeToken("look at @")).toMatchObject({ trigger: "@", query: "" });
  });

  it("closes once the mention is committed with a space", () => {
    expect(activeToken("look at @src/a.ts and")).toBeNull();
  });

  it("respects the caret rather than the end of the string", () => {
    // Caret sits right after "@sr" even though more text follows.
    expect(activeToken("look at @sr more text", 11)).toMatchObject({ query: "sr", end: 11 });
  });

  it("ignores an @ inside a word", () => {
    expect(activeToken("dev@exam")).toBeNull();
  });

  it("finds a slash command only at the start", () => {
    expect(activeToken("/mo")).toEqual({ trigger: "/", query: "mo", start: 0, end: 3 });
    expect(activeToken("/mode full")).toBeNull();
    expect(activeToken("look at a/b")).toBeNull();
  });

  it("returns nothing for plain text", () => {
    expect(activeToken("just typing")).toBeNull();
    expect(activeToken("")).toBeNull();
  });
});

describe("applyCompletion", () => {
  it("replaces the token and commits it with a space", () => {
    const input = "look at @src/re";
    const token = activeToken(input)!;
    const result = applyCompletion(input, token, "src/core/retriever.ts");
    expect(result.text).toBe("look at @src/core/retriever.ts ");
    // The caret lands past the committed token, ready for the next word.
    expect(result.caret).toBe(result.text.length);
  });

  it("keeps text that follows the caret", () => {
    const input = "look at @sr and explain";
    const token = activeToken(input, 11)!;
    const result = applyCompletion(input, token, "src/a.ts");
    expect(result.text).toBe("look at @src/a.ts  and explain");
  });

  it("completes a slash command", () => {
    const input = "/mo";
    const result = applyCompletion(input, activeToken(input)!, "mode");
    expect(result.text).toBe("/mode ");
  });
});

describe("rankPaths", () => {
  const paths = [
    "src/core/retriever.ts",
    "src/core/retriever.test.ts",
    "src/trace/retrieval.ts",
    "src/cli/index.ts",
    "README.md",
  ];

  it("puts an exact basename match first", () => {
    expect(rankPaths(paths, "retriever.ts")[0]).toBe("src/core/retriever.ts");
  });

  it("prefers a basename prefix over a substring elsewhere", () => {
    expect(rankPaths(paths, "retriev")[0]).toBe("src/core/retriever.ts");
  });

  it("matches on a path fragment", () => {
    expect(rankPaths(paths, "trace/")).toEqual(["src/trace/retrieval.ts"]);
  });

  it("falls back to a scattered subsequence", () => {
    expect(rankPaths(paths, "scliidx")).toContain("src/cli/index.ts");
  });

  it("breaks ties by the shorter path", () => {
    const ranked = rankPaths(paths, "retriever");
    expect(ranked.indexOf("src/core/retriever.ts")).toBeLessThan(ranked.indexOf("src/core/retriever.test.ts"));
  });

  it("returns everything (capped) for an empty query", () => {
    expect(rankPaths(paths, "")).toHaveLength(5);
    expect(rankPaths(paths, "", 2)).toHaveLength(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(rankPaths(paths, "zzzzqqq")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(rankPaths(paths, "README")).toEqual(["README.md"]);
    expect(rankPaths(paths, "readme")).toEqual(["README.md"]);
  });
});

describe("matchCommands", () => {
  it("lists everything for an empty query", () => {
    expect(matchCommands("")).toEqual(SLASH_COMMANDS);
  });

  it("matches on the name prefix", () => {
    expect(matchCommands("mo").map(c => c.name)).toEqual(["mode"]);
  });

  it("also matches the summary, so intent finds the command", () => {
    expect(matchCommands("checkpoint").map(c => c.name)).toContain("rewind");
  });

  it("returns nothing for nonsense", () => {
    expect(matchCommands("zzzz")).toEqual([]);
  });

  it("declares an argument where one is expected", () => {
    expect(SLASH_COMMANDS.find(c => c.name === "mode")?.arg).toBeTruthy();
    expect(SLASH_COMMANDS.find(c => c.name === "compact")?.arg).toBeUndefined();
  });
});
