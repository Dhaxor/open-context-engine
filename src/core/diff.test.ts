import { describe, it, expect } from "vitest";
import { unifiedDiff, countOccurrences, replaceOnce, replaceAll } from "./diff";

describe("unifiedDiff", () => {
  it("returns empty string when texts are identical", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nb\nc\n")).toBe("");
  });

  it("produces headers and single hunk for small change", () => {
    const out = unifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n", { fromLabel: "a.txt", toLabel: "a.txt" });
    expect(out).toContain("--- a.txt");
    expect(out).toContain("+++ a.txt");
    expect(out).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(out).toContain("-two");
    expect(out).toContain("+TWO");
    expect(out).toContain(" one");
    expect(out).toContain(" three");
  });

  it("handles new file (empty old)", () => {
    const out = unifiedDiff("", "hello\nworld\n");
    expect(out).toContain("+hello");
    expect(out).toContain("+world");
  });

  it("handles removed file (empty new)", () => {
    const out = unifiedDiff("hello\nworld\n", "");
    expect(out).toContain("-hello");
    expect(out).toContain("-world");
  });

  it("splits into multiple hunks when changes are far apart", () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 2", "LINE 2").replace("line 25", "LINE 25");
    const out = unifiedDiff(a, b);
    const hunks = out.match(/@@/g) ?? [];
    expect(hunks.length).toBeGreaterThanOrEqual(4);
  });
});

describe("countOccurrences / replaceOnce / replaceAll", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("ababab", "ab")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "xyz")).toBe(0);
    expect(countOccurrences("abc", "")).toBe(0);
  });

  it("replaceOnce only replaces first match", () => {
    const r = replaceOnce("foo bar foo", "foo", "FOO");
    expect(r.text).toBe("FOO bar foo");
    expect(r.replaced).toBe(true);
    expect(r.index).toBe(0);
  });

  it("replaceOnce returns unchanged when not found", () => {
    const r = replaceOnce("hello", "x", "y");
    expect(r.text).toBe("hello");
    expect(r.replaced).toBe(false);
  });

  it("replaceAll replaces every occurrence", () => {
    const r = replaceAll("foo bar foo baz foo", "foo", "QUX");
    expect(r.text).toBe("QUX bar QUX baz QUX");
    expect(r.count).toBe(3);
  });
});
