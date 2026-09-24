/**
 * Design tokens — one source, two renderers.
 *
 * Studio consumes these as CSS custom properties; the TUI maps the same values
 * to 24-bit ANSI. Defining them once is what keeps a terminal session and a
 * browser session recognisably the same product instead of two things that
 * drifted apart the first time someone tweaked a colour in one place.
 *
 * The direction is committed in .interface-design/system.md: an instrument at
 * night. Dark only, one hue across every surface (lightness moves, hue does
 * not), hairline borders instead of shadows, and a single cyan accent that is
 * spent on meaning — never decoration.
 *
 * Retrieval score is encoded as cyan LUMINANCE, not as a rainbow. A five-step
 * ramp reads as one scale at a glance; five different hues would read as five
 * different categories, which is a lie about what the number means.
 */

export const COLORS = {
  // Surfaces: one hue, lightness only. Each step is a few percent — you should
  // feel the stacking rather than see it.
  void: "#0a0d12",
  panel: "#10151c",
  lift: "#161c25",
  overlay: "#1b222d",

  // Ink, four tiers: default, supporting, metadata, disabled.
  ink: "#e8edf4",
  ink2: "#a8b3c0",
  ink3: "#6e7a88",
  ink4: "#48525e",

  // The one accent.
  prompt: "#45c4e9",
  promptDim: "rgba(69,196,233,0.12)",

  // Semantic only — never decorative.
  ok: "#3fb950",
  warn: "#e3b341",
  del: "#f47067",
} as const;

/** Hairlines. Low-opacity so an edge is findable but never the first thing seen. */
export const EDGES = {
  edge: "rgba(219,230,242,0.08)",
  edgeHi: "rgba(219,230,242,0.16)",
  edgeFaint: "rgba(219,230,242,0.05)",
} as const;

/** Fusion-score ramp, strongest first. Same hue, falling luminance. */
export const SCORE_RAMP = ["#45c4e9", "#3fa9cc", "#358ead", "#2c748f", "#245a70"] as const;

/**
 * Bucket colours for the context meter. Retrieval gets the live accent because
 * it is the bucket the user can actually act on; the rest recede into surface
 * tones so the meter reads as "how much of this is mine to fix".
 */
export const BUCKET_COLORS = {
  retrieval: "#45c4e9",
  files: "#2f7f9b",
  history: "#3d4b58",
  system: "#242d38",
  tools: "#1b222d",
} as const;

/** 1.25 from a 13px base — workbench-dense, not brochure-airy. */
export const TYPE = {
  micro: "11px",
  small: "12px",
  body: "13px",
  mid: "14px",
  h3: "16px",
  h2: "18px",
  h1: "22px",
  display: "28px",
  sans: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/** 8px grid. */
export const SPACE = { s1: "4px", s2: "8px", s3: "12px", s4: "16px", s5: "24px", s6: "32px", s7: "48px" } as const;

export const RADIUS = { sm: "6px", md: "10px", lg: "14px" } as const;

/**
 * Proportions state a relationship. The spine is a 44px gutter — subordinate,
 * a margin note. The rail is 320px, near-peer with the transcript, because the
 * claim of this product is that the evidence matters as much as the answer.
 */
export const LAYOUT = { spine: "44px", rail: "320px", transcriptMin: "480px", composerMax: "72ch" } as const;

/** Felt, not watched. Custom ease-out — the built-in curves are too weak. */
export const MOTION = {
  fast: "180ms",
  base: "220ms",
  ease: "cubic-bezier(.23,1,.32,1)",
  stagger: "40ms",
} as const;

/** Pick a ramp colour for a fusion score in [0,1]. */
export function scoreColor(score: number): string {
  if (!Number.isFinite(score)) return SCORE_RAMP[SCORE_RAMP.length - 1];
  const clamped = Math.min(1, Math.max(0, score));
  // Highest scores land on index 0; the ramp is ordered strongest-first.
  const index = Math.min(SCORE_RAMP.length - 1, Math.floor((1 - clamped) * SCORE_RAMP.length));
  return SCORE_RAMP[index];
}

/** `#rrggbb` → an SGR foreground sequence, for the TUI renderer. */
export function ansiFg(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `[38;2;${r};${g};${b}m`;
}

export function ansiBg(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `[48;2;${r};${g};${b}m`;
}

export function parseHex(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? clean.split("").map(c => c + c).join("") : clean;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * The `:root` block, generated at build time and inlined into the Studio shell.
 * Generating rather than hand-maintaining a parallel CSS file is the point:
 * there is no second copy to fall out of date.
 */
export function cssVariables(): string {
  const lines: string[] = [];
  const push = (name: string, value: string) => lines.push(`  --${name}: ${value};`);

  for (const [key, value] of Object.entries(COLORS)) push(kebab(key), value);
  for (const [key, value] of Object.entries(EDGES)) push(kebab(key), value);
  SCORE_RAMP.forEach((c, i) => push(`score-${i}`, c));
  for (const [key, value] of Object.entries(BUCKET_COLORS)) push(`bucket-${key}`, value);
  for (const [key, value] of Object.entries(TYPE)) push(`type-${kebab(key)}`, value);
  for (const [key, value] of Object.entries(SPACE)) push(kebab(key), value);
  for (const [key, value] of Object.entries(RADIUS)) push(`radius-${key}`, value);
  for (const [key, value] of Object.entries(LAYOUT)) push(`layout-${kebab(key)}`, value);
  for (const [key, value] of Object.entries(MOTION)) push(`motion-${kebab(key)}`, value);

  return `:root {\n${lines.join("\n")}\n}`;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
