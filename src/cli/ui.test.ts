import { describe, it, expect } from "vitest";
import {
  MarkdownStreamRenderer, colorizeDiff, formatPlan, formatStats, formatToolCall,
  formatToolResult, makeColors, parseSlashCommand, renderBanner, renderBox,
  stripAnsi, truncateMiddle,
} from "./ui";

const plain = makeColors(false);
const ansi = makeColors(true);

describe("colors", () => {
  it("passes text through untouched when disabled", () => {
    expect(plain.bold("x")).toBe("x");
    expect(plain.red("x")).toBe("x");
  });

  it("wraps with ANSI when enabled, and stripAnsi undoes it", () => {
    const s = ansi.bold(ansi.green("hello"));
    expect(s).not.toBe("hello");
    expect(stripAnsi(s)).toBe("hello");
  });
});

describe("truncateMiddle", () => {
  it("keeps short strings and squeezes long ones around an ellipsis", () => {
    expect(truncateMiddle("short", 10)).toBe("short");
    const t = truncateMiddle("a".repeat(30) + "Z" + "b".repeat(30), 21);
    expect(t.length).toBe(21);
    expect(t).toContain("…");
    expect(t.startsWith("aaaa")).toBe(true);
    expect(t.endsWith("bbbb")).toBe(true);
  });
});

describe("MarkdownStreamRenderer", () => {
  it("buffers partial lines until the newline arrives", () => {
    const md = new MarkdownStreamRenderer(plain);
    expect(md.feed("hello ")).toBe("");
    expect(md.feed("world\n")).toBe("hello world\n");
    expect(md.flush()).toBe("");
  });

  it("styles headers, bullets, bold, and inline code", () => {
    const md = new MarkdownStreamRenderer(ansi);
    const out = md.feed("# Title\n- item with `code` and **bold**\n");
    const clean = stripAnsi(out);
    expect(clean).toContain("Title");
    expect(clean).toContain("• item with code and bold");
    expect(clean).not.toContain("# Title");   // marker consumed
    expect(clean).not.toContain("**");
  });

  it("renders fenced code blocks with a gutter and closes them", () => {
    const md = new MarkdownStreamRenderer(plain);
    const out = md.feed("```ts\nconst x = 1;\n```\nafter\n");
    expect(out).toContain("╭── ts");
    expect(out).toContain("│ const x = 1;");
    expect(out).toContain("╰──");
    expect(out).toContain("after");
  });

  it("flush() emits a trailing partial line", () => {
    const md = new MarkdownStreamRenderer(plain);
    md.feed("no newline yet");
    expect(md.flush()).toBe("no newline yet");
  });
});

describe("colorizeDiff", () => {
  it("marks +/-/@@ lines distinctly and leaves context dim", () => {
    const out = colorizeDiff("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n context", ansi);
    const lines = out.split("\n");
    expect(stripAnsi(lines[3])).toBe("-old");
    expect(lines[3]).not.toBe("-old");            // got styled
    expect(stripAnsi(lines[4])).toBe("+new");
    expect(lines[4]).not.toBe(lines[3]);
  });
});

describe("tool formatting", () => {
  it("summarizes common tools with their salient argument", () => {
    expect(stripAnsi(formatToolCall("codebase-retrieval", { information_request: "auth flow" }, plain))).toContain("auth flow");
    expect(stripAnsi(formatToolCall("read-file", { path: "src/a.ts", start_line: 3, end_line: 9 }, plain))).toContain("src/a.ts:3-9");
    expect(stripAnsi(formatToolCall("run-command", { command: "npm test" }, plain))).toContain("npm test");
  });

  it("formatToolResult shows outcome, timing, and size", () => {
    const ok = stripAnsi(formatToolResult("read-file", true, 1500, 12345, plain));
    expect(ok).toContain("✓");
    expect(ok).toContain("1.5s");
    expect(ok).toContain("12,345");
    expect(stripAnsi(formatToolResult("run-command", false, undefined, 10, plain))).toContain("✗");
  });
});

describe("plan + stats + banner", () => {
  it("formatPlan renders the three states", () => {
    const out = stripAnsi(formatPlan([
      { step: "done", status: "completed" },
      { step: "doing", status: "in_progress" },
      { step: "later", status: "pending" },
    ], plain));
    expect(out).toContain("✔ done");
    expect(out).toContain("▸ doing");
    expect(out).toContain("○ later");
  });

  it("formatStats includes tokens only when reported", () => {
    const base = { steps: 2, toolCalls: 3, toolErrors: 0, durationMs: 4200 };
    expect(stripAnsi(formatStats({ ...base, usage: { inputTokens: 1000, outputTokens: 50 } }, plain))).toContain("1,000→50 tok");
    expect(stripAnsi(formatStats({ ...base, usage: { inputTokens: 0, outputTokens: 0 } }, plain))).not.toContain("tok");
  });

  it("renderBanner and renderBox produce readable plain-text scaffolding", () => {
    const banner = stripAnsi(renderBanner({ model: "m", provider: "openai", workspace: "/w", index: "10 chunks", mode: "suggest" }, plain));
    expect(banner).toContain("Open Context");
    expect(banner).toContain("openai/m");
    expect(banner).toContain("/help");
    const box = stripAnsi(renderBox("edit a.ts", "-x\n+y", plain));
    expect(box).toContain("┌─ edit a.ts");
    expect(box).toContain("│ -x");
    expect(box).toContain("└");
  });
});

describe("parseSlashCommand", () => {
  it("parses commands with and without args", () => {
    expect(parseSlashCommand("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlashCommand("/resume 20260713-abc1")).toEqual({ name: "resume", args: "20260713-abc1" });
    expect(parseSlashCommand("/MODE full-auto")).toEqual({ name: "mode", args: "full-auto" });
  });

  it("returns null for ordinary input (including paths)", () => {
    expect(parseSlashCommand("fix the bug in src/x.ts")).toBeNull();
    expect(parseSlashCommand("/usr/bin/env is a path, not a command")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });
});
