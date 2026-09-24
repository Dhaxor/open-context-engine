import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  BUCKET_COLORS, COLORS, EDGES, LAYOUT, MOTION, RADIUS, SCORE_RAMP, SPACE, TYPE,
  ansiBg, ansiFg, cssVariables, parseHex, scoreColor,
} from "./tokens";

describe("the palette holds its direction", () => {
  it("keeps one hue across every surface — lightness moves, hue does not", () => {
    // Different hues per surface is what makes an interface look assembled
    // rather than designed. The check is mechanical so it cannot drift.
    const hues = [COLORS.void, COLORS.panel, COLORS.lift, COLORS.overlay].map(hueOf);
    for (const hue of hues) expect(Math.abs(hue - hues[0])).toBeLessThan(12);
  });

  it("steps surfaces upward in small increments", () => {
    const steps = [COLORS.void, COLORS.panel, COLORS.lift, COLORS.overlay].map(luminance);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
      // Whisper-quiet: a visible jump reads as a different app, not a layer.
      expect(steps[i] - steps[i - 1]).toBeLessThan(0.06);
    }
  });

  it("gives ink four distinct, descending tiers", () => {
    const tiers = [COLORS.ink, COLORS.ink2, COLORS.ink3, COLORS.ink4].map(luminance);
    for (let i = 1; i < tiers.length; i++) expect(tiers[i]).toBeLessThan(tiers[i - 1]);
    // Two tiers pretending to be four is the usual cause of flat hierarchy.
    expect(tiers[0] - tiers[3]).toBeGreaterThan(0.4);
  });

  it("uses hairline borders, never solid ones", () => {
    for (const edge of Object.values(EDGES)) {
      expect(edge).toMatch(/^rgba\(/);
      const alpha = Number(/,\s*([\d.]+)\)$/.exec(edge)![1]);
      expect(alpha).toBeLessThanOrEqual(0.16);
    }
  });

  it("has exactly one accent", () => {
    const accents = [COLORS.prompt, COLORS.ok, COLORS.warn, COLORS.del];
    // ok/warn/del are semantic; only `prompt` is spent on identity and action.
    expect(new Set(accents).size).toBe(4);
    expect(COLORS.prompt).toBe(BUCKET_COLORS.retrieval);
  });
});

describe("score ramp", () => {
  it("is one hue at falling luminance, not a rainbow", () => {
    const hues = SCORE_RAMP.map(hueOf);
    for (const hue of hues) expect(Math.abs(hue - hues[0])).toBeLessThan(15);
  });

  it("descends monotonically", () => {
    const steps = SCORE_RAMP.map(luminance);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1]);
  });

  it("starts at the accent, so a top hit reads as the live colour", () => {
    expect(SCORE_RAMP[0]).toBe(COLORS.prompt);
    expect(scoreColor(1)).toBe(COLORS.prompt);
  });
});

describe("type and space scales", () => {
  it("steps type at roughly 1.25 from a 13px base", () => {
    const sizes = [TYPE.micro, TYPE.small, TYPE.body, TYPE.mid, TYPE.h3, TYPE.h2, TYPE.h1, TYPE.display].map(px);
    expect(TYPE.body).toBe("13px");
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    // Distinct enough to squint at: no 15/16/17 mush.
    expect(sizes[sizes.length - 1] / sizes[0]).toBeGreaterThan(2);
  });

  it("keeps every spacing value on the 4px grid", () => {
    for (const value of Object.values(SPACE)) expect(px(value) % 4).toBe(0);
  });

  it("scales radius so small controls never get a large corner", () => {
    expect(px(RADIUS.sm)).toBeLessThan(px(RADIUS.md));
    expect(px(RADIUS.md)).toBeLessThan(px(RADIUS.lg));
  });

  it("states the layout proportions the design argues for", () => {
    // A 44px gutter is subordinate; a 320px rail is near-peer with the
    // transcript, which is the claim this product makes.
    expect(px(LAYOUT.spine)).toBe(44);
    expect(px(LAYOUT.rail)).toBe(320);
    expect(px(LAYOUT.rail)).toBeGreaterThan(px(LAYOUT.spine) * 4);
  });

  it("keeps motion under the threshold where it reads as lag", () => {
    expect(px(MOTION.fast)).toBeLessThan(300);
    expect(px(MOTION.base)).toBeLessThan(300);
    expect(MOTION.ease).toBe("cubic-bezier(.23,1,.32,1)");
  });
});

describe("cssVariables()", () => {
  const css = cssVariables();

  it("emits a :root block with every token", () => {
    expect(css.startsWith(":root {")).toBe(true);
    expect(css).toContain("--void: #0a0d12;");
    expect(css).toContain("--prompt: #45c4e9;");
    expect(css).toContain("--score-0: #45c4e9;");
    expect(css).toContain("--bucket-retrieval: #45c4e9;");
    expect(css).toContain("--layout-rail: 320px;");
    expect(css).toContain("--type-mono:");
  });

  it("kebab-cases every custom property", () => {
    for (const [, name] of css.matchAll(/--([a-z0-9-]+):/g)) expect(name).not.toMatch(/[A-Z_]/);
    expect(css).toContain("--edge-hi:");
    expect(css).toContain("--prompt-dim:");
  });

  it("declares every variable the stylesheet consumes", () => {
    // This is the "one source" claim, checked rather than asserted: a token
    // renamed in tokens.ts must not leave styles.css referencing a dead var.
    const stylesheet = fs.readFileSync(path.join(__dirname, "studio", "styles.css"), "utf8");
    const declared = new Set([...css.matchAll(/--([a-z0-9-]+):/g)].map(m => m[1]));
    const used = new Set([...stylesheet.matchAll(/var\(--([a-z0-9-]+)\)/g)].map(m => m[1]));
    const missing = [...used].filter(name => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it("contains no colour literal the stylesheet could have hardcoded instead", () => {
    const stylesheet = fs.readFileSync(path.join(__dirname, "studio", "styles.css"), "utf8");
    // A stray hex in the stylesheet means a token was bypassed. rgba() is
    // allowed for the few one-off translucent washes tied to semantic colours.
    expect(stylesheet).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

describe("ANSI mapping for the TUI", () => {
  it("turns a token into a truecolor sequence", () => {
    expect(ansiFg("#45c4e9")).toBe("[38;2;69;196;233m");
    expect(ansiBg("#0a0d12")).toBe("[48;2;10;13;18m");
  });

  it("parses shorthand and rejects nonsense without throwing", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("45c4e9")).toEqual({ r: 69, g: 196, b: 233 });
    expect(parseHex("nope")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("maps every palette colour without producing a broken sequence", () => {
    for (const value of Object.values(COLORS)) {
      if (!value.startsWith("#")) continue;
      expect(ansiFg(value)).toMatch(/^\[38;2;\d{1,3};\d{1,3};\d{1,3}m$/);
    }
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function px(value: string): number {
  return Number.parseFloat(value);
}

function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Hue in degrees, for checking that surfaces share one. */
function hueOf(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}
