/**
 * Terminal styling for Trace — the same tokens Studio uses, as ANSI.
 *
 * Colours come from src/trace/tokens.ts and nowhere else, so the TUI and the
 * browser cannot drift: change the accent once and both surfaces move. Truecolor
 * is used when the terminal advertises it and degrades to the 16-colour palette
 * otherwise, because a workbench that renders as mud over SSH is worse than one
 * that renders plainly.
 *
 * Everything here is a pure string function, which is what lets the whole
 * frame be asserted in tests without a TTY.
 */

import { COLORS, SCORE_RAMP, ansiFg, parseHex } from "../tokens";

export const RESET = "[0m";
export const BOLD = "[1m";
export const DIM = "[2m";
export const REVERSE = "[7m";

export interface ThemeOptions {
  /** 24-bit colour. Off falls back to the basic palette. */
  truecolor?: boolean;
  /** No colour at all (NO_COLOR, a pipe, TERM=dumb). */
  mono?: boolean;
}

/** Nearest basic-palette code, for terminals without truecolor. */
function basicFor(hex: string): string {
  const { r, g, b } = parseHex(hex);
  const max = Math.max(r, g, b);
  if (max < 60) return "[30m";
  if (b > r && b > g) return max > 170 ? "[96m" : "[36m";
  if (g > r && g > b) return "[32m";
  if (r > g && r > b) return g > 120 ? "[33m" : "[31m";
  return max > 190 ? "[97m" : max > 120 ? "[37m" : "[90m";
}

/**
 * Every styling helper is a bound arrow property, not a prototype method.
 * Renderers naturally write `const color = warn ? theme.warn : theme.ink3`, and
 * an unbound method there throws at call time — a whole class of bug removed by
 * the shape of the API rather than by remembering.
 */
export class Theme {
  constructor(private opts: ThemeOptions = {}) {}

  /** Wrap `text` in a token colour. */
  readonly color = (hex: string, text: string): string => {
    if (this.opts.mono || !text) return text;
    const open = this.opts.truecolor === false ? basicFor(hex) : ansiFg(hex);
    return `${open}${text}${RESET}`;
  };

  readonly bold = (text: string): string => (this.opts.mono ? text : `${BOLD}${text}${RESET}`);
  readonly dim = (text: string): string => (this.opts.mono ? text : `${DIM}${text}${RESET}`);
  readonly reverse = (text: string): string => (this.opts.mono ? text : `${REVERSE}${text}${RESET}`);

  readonly ink = (text: string): string => this.color(COLORS.ink, text);
  readonly ink2 = (text: string): string => this.color(COLORS.ink2, text);
  readonly ink3 = (text: string): string => this.color(COLORS.ink3, text);
  readonly ink4 = (text: string): string => this.color(COLORS.ink4, text);
  readonly accent = (text: string): string => this.color(COLORS.prompt, text);
  readonly ok = (text: string): string => this.color(COLORS.ok, text);
  readonly warn = (text: string): string => this.color(COLORS.warn, text);
  readonly del = (text: string): string => this.color(COLORS.del, text);

  /** A retrieval score in its ramp step — one hue, falling luminance. */
  readonly score = (value: number, text: string): string => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    const index = Math.min(SCORE_RAMP.length - 1, Math.floor((1 - clamped) * SCORE_RAMP.length));
    return this.color(SCORE_RAMP[index], text);
  };
}

/** Decide the theme from the environment. Mirrors supportsColor in cli/ui.ts. */
export function themeFor(stream: { isTTY?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Theme {
  if (env.NO_COLOR) return new Theme({ mono: true });
  if (!stream.isTTY && !env.FORCE_COLOR) return new Theme({ mono: true });
  if (env.TERM === "dumb") return new Theme({ mono: true });
  const truecolor = env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || /-256color$/.test(env.TERM ?? "");
  return new Theme({ truecolor });
}

// ─── text measurement ────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Visible width, ignoring escape sequences. */
export function width(s: string): number {
  return stripAnsi(s).length;
}

/** Truncate to `max` VISIBLE columns, appending an ellipsis. Escape sequences
 *  are preserved, so a truncated coloured string is still terminated. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  let visible = 0;
  let out = "";
  let i = 0;
  let styled = false;
  while (i < s.length && visible < max - 1) {
    const match = /^\[[0-9;]*m/.exec(s.slice(i));
    if (match) { out += match[0]; i += match[0].length; styled = true; continue; }
    out += s[i];
    visible++;
    i++;
  }
  // Only terminate styling that was actually opened. Appending a reset to
  // unstyled text writes a stray escape into NO_COLOR output.
  return styled ? `${out}…${RESET}` : `${out}…`;
}

/** Pad to exactly `w` visible columns. Over-long input is truncated, so every
 *  frame line has a known width and the diff renderer never leaves debris. */
export function fit(s: string, w: number): string {
  const t = truncate(s, w);
  return t + " ".repeat(Math.max(0, w - width(t)));
}

export function padStart(s: string, w: number): string {
  const gap = Math.max(0, w - width(s));
  return " ".repeat(gap) + s;
}

/** Wrap on word boundaries, falling back to a hard break for long tokens. */
export function wrap(text: string, w: number): string[] {
  if (w <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    let current = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (width(current) + width(word) <= w) { current += word; continue; }
      if (current.trim()) lines.push(current.trimEnd());
      current = "";
      let rest = word.trimStart();
      // A single token longer than the column (a path, a hash) is cut rather
      // than allowed to push the layout wider.
      while (width(rest) > w) {
        lines.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      current = rest;
    }
    if (current.trim() || !lines.length) lines.push(current.trimEnd());
  }
  return lines;
}
