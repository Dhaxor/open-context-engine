import { describe, it, expect } from "vitest";
import { Screen, decodeKeys } from "./screen";

class FakeOut {
  written: string[] = [];
  columns = 100;
  rows = 24;
  isTTY = true;
  listeners = new Map<string, ((...a: any[]) => void)[]>();
  write(s: string): boolean { this.written.push(s); return true; }
  on(event: string, fn: (...a: any[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  off(): this { return this; }
  get all(): string { return this.written.join(""); }
  clear(): void { this.written = []; }
}

class FakeIn {
  isTTY = true;
  raw = false;
  resumed = false;
  paused = false;
  setRawMode(v: boolean): this { this.raw = v; return this; }
  resume(): this { this.resumed = true; return this; }
  pause(): this { this.paused = true; return this; }
  on(): this { return this; }
  off(): this { return this; }
}

function screen() {
  const out = new FakeOut();
  const input = new FakeIn();
  return { out, input, screen: new Screen({ out: out as any, in: input as any }) };
}

describe("Screen lifecycle", () => {
  it("takes the alternate buffer and hides the cursor, then restores both", () => {
    const { out, input, screen: s } = screen();
    s.start();
    expect(out.all).toContain("[?1049h");
    expect(out.all).toContain("[?25l");
    expect(input.raw).toBe(true);

    out.clear();
    s.stop();
    // Leaving the terminal in raw mode with a hidden cursor is the classic way
    // a TUI ruins the shell it exits into.
    expect(out.all).toContain("[?25h");
    expect(out.all).toContain("[?1049l");
    expect(input.raw).toBe(false);
  });

  it("is idempotent, so a double stop cannot double-restore", () => {
    const { out, screen: s } = screen();
    s.start();
    s.start();
    s.stop();
    out.clear();
    s.stop();
    expect(out.all).toBe("");
  });

  it("ignores renders before start", () => {
    const { out, screen: s } = screen();
    s.render(["hello"]);
    expect(out.all).toBe("");
  });

  it("falls back to a sane size when stdout is not a TTY", () => {
    const out = new FakeOut();
    (out as any).columns = undefined;
    (out as any).rows = undefined;
    const s = new Screen({ out: out as any });
    expect(s.size).toEqual({ columns: 80, rows: 24 });
  });
});

describe("Screen diffing", () => {
  it("writes only the rows that changed", () => {
    const { out, screen: s } = screen();
    s.start();
    s.render(["one", "two", "three"]);
    out.clear();

    s.render(["one", "CHANGED", "three"]);
    const written = out.all;
    expect(written).toContain("CHANGED");
    expect(written).not.toContain("one");
    expect(written).not.toContain("three");
    // Row 2, column 1 — 1-based cursor addressing.
    expect(written).toContain("[2;1H");
  });

  it("writes nothing when the frame is unchanged", () => {
    const { out, screen: s } = screen();
    s.start();
    s.render(["a", "b"]);
    out.clear();
    s.render(["a", "b"]);
    expect(out.all).toBe("");
  });

  it("clears when the row count changes, so no old tail survives", () => {
    const { out, screen: s } = screen();
    s.start();
    s.render(["a", "b", "c"]);
    out.clear();
    s.render(["a", "b"]);
    expect(out.all).toContain("[2J");
  });

  it("repaints everything after invalidate — the resize path", () => {
    const { out, screen: s } = screen();
    s.start();
    s.render(["a", "b"]);
    out.clear();

    // "Resize the window to fix the rendering" is a bug filed against other
    // agents. Here the resize path IS the repair path, so they cannot disagree.
    s.invalidate();
    s.render(["a", "b"]);
    expect(out.all).toContain("[2J");
    expect(out.all).toContain("a");
    expect(out.all).toContain("b");
  });

  it("drops its cache on stop, so a restart never diffs against a dead frame", () => {
    const { out, screen: s } = screen();
    s.start();
    s.render(["a"]);
    s.stop();
    s.start();
    out.clear();
    s.render(["a"]);
    expect(out.all).toContain("a");
  });
});

describe("decodeKeys", () => {
  it("reads printable characters", () => {
    expect(decodeKeys("hi")).toEqual([
      { name: "h", ctrl: false, char: "h" },
      { name: "i", ctrl: false, char: "i" },
    ]);
  });

  it("reads the editing keys", () => {
    expect(decodeKeys("\r")[0].name).toBe("return");
    expect(decodeKeys("\n")[0].name).toBe("return");
    expect(decodeKeys("\x7f")[0].name).toBe("backspace");
    expect(decodeKeys("\x08")[0].name).toBe("backspace");
    expect(decodeKeys("\t")[0].name).toBe("tab");
  });

  it("reads arrows and paging without confusing them for an escape", () => {
    expect(decodeKeys("\x1b[A")).toEqual([{ name: "up", ctrl: false }]);
    expect(decodeKeys("\x1b[B")).toEqual([{ name: "down", ctrl: false }]);
    expect(decodeKeys("\x1b[5~")).toEqual([{ name: "pageup", ctrl: false }]);
    expect(decodeKeys("\x1b[6~")).toEqual([{ name: "pagedown", ctrl: false }]);
  });

  it("reads a bare escape as escape", () => {
    expect(decodeKeys("\x1b")).toEqual([{ name: "escape", ctrl: false }]);
  });

  it("maps control codes back to their letter", () => {
    expect(decodeKeys("\x03")).toEqual([{ name: "c", ctrl: true }]);
    expect(decodeKeys("\x12")).toEqual([{ name: "r", ctrl: true }]);
    expect(decodeKeys("\x04")).toEqual([{ name: "d", ctrl: true }]);
  });

  it("splits a burst arriving in one chunk", () => {
    // Paste and fast typing deliver several keys per data event.
    expect(decodeKeys("ab\r").map(k => k.name)).toEqual(["a", "b", "return"]);
    expect(decodeKeys("\x1b[Ax").map(k => k.name)).toEqual(["up", "x"]);
  });

  it("returns nothing for an empty chunk", () => {
    expect(decodeKeys("")).toEqual([]);
  });
});
