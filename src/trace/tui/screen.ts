/**
 * The screen driver — turns frames into terminal writes.
 *
 * Two properties are designed for rather than hoped for, because the harnesses
 * this competes with are known to lose them:
 *
 *   No debris. Every frame line is padded to exactly the terminal width (see
 *   frame.ts), so rewriting a row always fully overwrites the previous one. A
 *   shorter line can never leave the tail of a longer one behind — the usual
 *   cause of a TUI that slowly fills with garbage over a long session.
 *
 *   Resize is a full repaint. On SIGWINCH the cached frame is discarded and
 *   every row redrawn. "Resize the window to fix the rendering" is a bug report
 *   filed against other agents; here the resize path IS the repair path, so the
 *   two can never disagree.
 *
 * Between frames only changed rows are written, which keeps a streaming answer
 * from repainting the whole screen sixty times a second.
 */

export interface ScreenIo {
  out: NodeJS.WriteStream;
  in?: NodeJS.ReadStream;
}

// Written with  rather than a literal escape byte: raw control characters
// in source are invisible in diffs and easy to lose to a stray edit, and losing
// one here silently disables the alternate buffer or arrow keys.
const ESC = "";
const CSI = `${ESC}[`;

const ALT_ON = `${CSI}?1049h`;
const ALT_OFF = `${CSI}?1049l`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CLEAR = `${CSI}2J`;

export class Screen {
  private previous: string[] = [];
  private started = false;
  private rawWasSet = false;

  constructor(private io: ScreenIo) {}

  get size(): { columns: number; rows: number } {
    return {
      // Sensible defaults when stdout is not a TTY (piped output, CI).
      columns: this.io.out.columns ?? 80,
      rows: this.io.out.rows ?? 24,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.io.out.write(ALT_ON + CURSOR_HIDE + CLEAR);
    const input = this.io.in;
    if (input?.isTTY && typeof input.setRawMode === "function") {
      input.setRawMode(true);
      this.rawWasSet = true;
    }
    input?.resume?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    const input = this.io.in;
    if (this.rawWasSet && typeof input?.setRawMode === "function") input.setRawMode(false);
    input?.pause?.();
    this.io.out.write(CURSOR_SHOW + ALT_OFF);
    this.previous = [];
  }

  /** Discard the cache so the next render repaints everything. */
  invalidate(): void {
    this.previous = [];
  }

  /**
   * Paint a frame. Rows identical to the previous frame are skipped; the rest
   * are rewritten in place. A change in row COUNT forces a clear, because the
   * old frame's tail would otherwise linger below the new one.
   */
  render(lines: string[]): void {
    if (!this.started) return;
    const out = this.io.out;
    const full = this.previous.length !== lines.length;
    let buffer = full ? CLEAR : "";

    for (let row = 0; row < lines.length; row++) {
      if (!full && this.previous[row] === lines[row]) continue;
      // 1-based cursor addressing, column 1, then the padded line.
      buffer += `${CSI}${row + 1};1H${lines[row]}`;
    }
    if (buffer) out.write(buffer);
    this.previous = lines.slice();
  }
}

// ─── key decoding ────────────────────────────────────────────────────────────

export interface Key {
  name: string;
  ctrl: boolean;
  /** Printable character, when the key produced one. */
  char?: string;
}

/**
 * Decode one chunk of raw stdin.
 *
 * Deliberately small: Trace needs Enter, Escape, Backspace, arrows, and a
 * handful of control keys. A full terminfo parser would be a dependency and a
 * liability for six sequences.
 */
export function decodeKeys(input: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);

    if (rest.startsWith(`${CSI}A`)) { keys.push(key("up")); i += 3; continue; }
    if (rest.startsWith(`${CSI}B`)) { keys.push(key("down")); i += 3; continue; }
    if (rest.startsWith(`${CSI}C`)) { keys.push(key("right")); i += 3; continue; }
    if (rest.startsWith(`${CSI}D`)) { keys.push(key("left")); i += 3; continue; }
    if (rest.startsWith(`${CSI}5~`)) { keys.push(key("pageup")); i += 4; continue; }
    if (rest.startsWith(`${CSI}6~`)) { keys.push(key("pagedown")); i += 4; continue; }

    const code = input.charCodeAt(i);
    const ch = input[i];
    i++;

    if (code === 0x1b) { keys.push(key("escape")); continue; }
    if (code === 0x0d || code === 0x0a) { keys.push(key("return")); continue; }
    if (code === 0x7f || code === 0x08) { keys.push(key("backspace")); continue; }
    if (code === 0x09) { keys.push(key("tab")); continue; }
    if (code === 0x03) { keys.push(key("c", true)); continue; }
    if (code < 0x20) {
      // Other control codes map back to their letter: 0x12 → ctrl+r.
      keys.push(key(String.fromCharCode(code + 96), true));
      continue;
    }
    keys.push({ name: ch, ctrl: false, char: ch });
  }
  return keys;
}

function key(name: string, ctrl = false): Key {
  return { name, ctrl };
}
