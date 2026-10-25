import { describe, it, expect } from "vitest";
import { COLORS, SCORE_RAMP } from "../tokens";
import { Theme, fit, padStart, stripAnsi, themeFor, truncate, width, wrap } from "./theme";

/** Written as an escape rather than a raw byte so the expectations are legible. */
const ESC = "";

describe("Theme", () => {
  it("emits truecolor from the shared tokens", () => {
    const styled = new Theme({ truecolor: true }).accent("x");
    // 69,196,233 is --prompt. The TUI and Studio read the same constant.
    expect(styled).toBe(`${ESC}[38;2;69;196;233mx${ESC}[0m`);
  });

  it("degrades to the basic palette when truecolor is absent", () => {
    const styled = new Theme({ truecolor: false }).accent("x");
    expect(styled).toMatch(new RegExp(`^${ESC}\\[9?[0-9]{1,2}mx${ESC}\\[0m$`));
    expect(styled).not.toContain("38;2");
  });

  it("emits nothing at all in mono mode", () => {
    const mono = new Theme({ mono: true });
    expect(mono.accent("x")).toBe("x");
    expect(mono.bold("x")).toBe("x");
    expect(mono.score(0.9, "0.90")).toBe("0.90");
  });

  it("maps a score onto the shared ramp, brightest first", () => {
    const t = new Theme({ truecolor: true });
    expect(t.score(1, "x")).toContain(rgbOf(SCORE_RAMP[0]));
    expect(t.score(0, "x")).toContain(rgbOf(SCORE_RAMP[SCORE_RAMP.length - 1]));
    expect(t.score(NaN, "x")).toContain(rgbOf(SCORE_RAMP[SCORE_RAMP.length - 1]));
  });

  it("survives being used as an unbound function reference", () => {
    // Renderers write `const c = warn ? theme.warn : theme.ink3`, so the
    // helpers must not depend on a receiver.
    const t = new Theme({ truecolor: true });
    const color = t.ink3;
    expect(() => color("x")).not.toThrow();
    expect(color("x")).toContain(rgbOf(COLORS.ink3));
  });
});

describe("themeFor", () => {
  it("honours NO_COLOR above everything else", () => {
    expect(themeFor({ isTTY: true }, { NO_COLOR: "1", COLORTERM: "truecolor" } as any).accent("x")).toBe("x");
  });

  it("stays plain when output is not a terminal", () => {
    expect(themeFor({ isTTY: false }, {} as any).accent("x")).toBe("x");
  });

  it("stays plain on a dumb terminal", () => {
    expect(themeFor({ isTTY: true }, { TERM: "dumb" } as any).accent("x")).toBe("x");
  });

  it("uses truecolor when the terminal advertises it", () => {
    expect(themeFor({ isTTY: true }, { COLORTERM: "truecolor" } as any).accent("x")).toContain("38;2");
  });

  it("colours a piped stream when FORCE_COLOR is set", () => {
    expect(themeFor({ isTTY: false }, { FORCE_COLOR: "1" } as any).accent("x")).not.toBe("x");
  });
});

describe("width and truncation", () => {
  const styled = new Theme({ truecolor: true }).accent("hello");

  it("measures visible columns, not escape sequences", () => {
    expect(width(styled)).toBe(5);
    expect(stripAnsi(styled)).toBe("hello");
  });

  it("truncates to visible width and keeps styling terminated", () => {
    const cut = truncate(styled, 3);
    expect(width(cut)).toBe(3);
    expect(cut.endsWith(`${ESC}[0m`)).toBe(true);
  });

  it("leaves short text alone", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("returns nothing for a non-positive width", () => {
    expect(truncate("abc", 0)).toBe("");
  });

  it("fits to an exact column count in both directions", () => {
    expect(width(fit("ab", 6))).toBe(6);
    expect(width(fit(styled, 3))).toBe(3);
    expect(width(fit("", 4))).toBe(4);
  });

  it("right-aligns without counting escapes", () => {
    expect(padStart(styled, 8)).toBe("   " + styled);
  });
});

describe("wrap", () => {
  it("breaks on word boundaries", () => {
    expect(wrap("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  it("hard-breaks a token longer than the column", () => {
    // A path or a hash must not be allowed to widen the layout.
    expect(wrap("src/core/a-very-long-file-name.ts", 10)).toEqual([
      "src/core/a", "-very-long", "-file-name", ".ts",
    ]);
  });

  it("keeps blank lines as paragraph breaks", () => {
    expect(wrap("one\n\ntwo", 20)).toEqual(["one", "", "two"]);
  });

  it("returns nothing for a non-positive width", () => {
    expect(wrap("anything", 0)).toEqual([]);
  });

  it("never returns a line wider than the column", () => {
    const text = "Because sqlite-vec failed to load its native binding, the retriever degrades instead of throwing.";
    for (const w of [12, 20, 37, 80]) {
      for (const line of wrap(text, w)) expect(width(line)).toBeLessThanOrEqual(w);
    }
  });
});

function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}
