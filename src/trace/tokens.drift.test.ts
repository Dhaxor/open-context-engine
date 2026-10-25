import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { COLORS, EDGES, RADIUS, MOTION } from "./tokens";

/**
 * The marketing site (web/oce.css) predates tokens.ts and holds the shared
 * palette by hand — .interface-design/system.md says "keep them in step".
 * This test is what actually keeps them in step: every token both sides
 * declare must carry the same value, or the site drifts from the product.
 *
 * The site's type and spacing scales are deliberately its own (a brochure is
 * airier than a workbench); only the palette, edges, radii, and the ease curve
 * are shared with Trace.
 */

/** tokens.ts export name → web/oce.css custom property. */
const SHARED: Record<string, string> = {
  // ink2/3/4 are written --ink-2/--ink-3/--ink-4 on the site (a bare trailing
  // digit reads as a weight, not a tier).
  ...Object.fromEntries(Object.entries(COLORS).map(([k]) => [k, inkAware(k)])),
  edge: "--edge",
  edgeHi: "--edge-hi",
  sm: "--r-s",
  md: "--r-m",
  lg: "--r-l",
  ease: "--ease",
};

function inkAware(tokenKey: string): string {
  return `--${tokenKey.replace(/^ink(\d)$/, "ink-$1").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

/** rgba(219, 230, 242, 0.08) ≡ rgba(219,230,242,.08) — compare forms, not formatting. */
function normalize(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(,\s*([\d.]+)?)?\s*\)/gi, (_m, r, g, b, _c, a) => {
      const alpha = a === undefined ? "" : `,${Number(a)}`;
      return `rgba(${Number(r)},${Number(g)},${Number(b)}${alpha})`;
    })
    .replace(/"(.*?)"|'(.*?)'/g, "$1$2")
    // 0.23 ≡ .23 — strip leading zeros from decimals anywhere (cubic-bezier args).
    .replace(/0+(\.\d+)/g, "$1")
    // `a, b` ≡ `a,b` — list formatting is not a token value.
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function siteVariables(): Record<string, string> {
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "web", "oce.css"), "utf8");
  const root = css.match(/:root\s*\{([^}]*)\}/);
  expect(root, "web/oce.css must have a :root block declaring the shared tokens").toBeTruthy();
  const vars: Record<string, string> = {};
  for (const [, name, value] of root![1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[name] = value;
  }
  return vars;
}

describe("marketing site design tokens stay in step with tokens.ts", () => {
  const site = siteVariables();

  it("declares every shared token", () => {
    const missing = Object.values(SHARED).filter((cssName) => !(cssName in site));
    expect(missing, `web/oce.css is missing shared tokens: ${missing.join(", ")}`).toEqual([]);
  });

  it("carries the same value for every shared token", () => {
    const drift: string[] = [];
    for (const [tokenKey, cssName] of Object.entries(SHARED)) {
      const expected = normalize(tokenValue(tokenKey));
      const actual = site[cssName];
      if (actual === undefined) continue; // covered by the presence test
      if (normalize(actual) !== expected) {
        drift.push(`  ${cssName}: web/oce.css has ${actual.trim()}, tokens.ts has ${tokenValue(tokenKey)}`);
      }
    }
    expect(
      drift,
      `Shared design tokens drifted between web/oce.css and src/trace/tokens.ts:\n${drift.join("\n")}\n  tokens.ts is the source of truth (.interface-design/system.md).`,
    ).toEqual([]);
  });
});

function tokenValue(key: string): string {
  if (key in COLORS) return COLORS[key as keyof typeof COLORS];
  if (key in EDGES) return EDGES[key as keyof typeof EDGES];
  if (key in RADIUS) return RADIUS[key as keyof typeof RADIUS];
  if (key in MOTION) return MOTION[key as keyof typeof MOTION];
  throw new Error(`unknown shared token ${key}`);
}
