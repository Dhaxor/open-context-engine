/**
 * Terminal UI primitives for the interactive CLI — dependency-free ANSI.
 *
 * Everything here is a pure function of (input, colors) except Spinner, so it
 * unit-tests without a TTY. Color output auto-disables on non-TTY streams,
 * NO_COLOR, or TERM=dumb, and every renderer degrades to plain text.
 */

export interface Colors {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  italic(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  magenta(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
  inverse(s: string): string;
}

function wrap(open: number, close: number, enabled: boolean): (s: string) => string {
  return enabled ? (s: string) => `[${open}m${s}[${close}m` : (s: string) => s;
}

export function makeColors(enabled: boolean): Colors {
  return {
    enabled,
    bold: wrap(1, 22, enabled),
    dim: wrap(2, 22, enabled),
    italic: wrap(3, 23, enabled),
    red: wrap(31, 39, enabled),
    green: wrap(32, 39, enabled),
    yellow: wrap(33, 39, enabled),
    blue: wrap(34, 39, enabled),
    magenta: wrap(35, 39, enabled),
    cyan: wrap(36, 39, enabled),
    gray: wrap(90, 39, enabled),
    inverse: wrap(7, 27, enabled),
  };
}

export function supportsColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY) && process.env.TERM !== "dumb";
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - (max - 1 - half))}`;
}

// ─── banner + boxes ──────────────────────────────────────────────────────────

export interface BannerInfo {
  model: string;
  provider: string;
  workspace: string;
  index: string;
  mode: string;
  extras?: string[];
}

export function renderBanner(info: BannerInfo, c: Colors): string {
  const title = `${c.bold("Open Context")} ${c.dim("· code-native agent")}`;
  const rows = [
    `${c.dim("model")}      ${info.provider}/${c.cyan(info.model)}`,
    `${c.dim("workspace")}  ${truncateMiddle(info.workspace, 64)}`,
    `${c.dim("index")}      ${info.index}`,
    `${c.dim("approvals")}  ${info.mode}`,
    ...(info.extras ?? []).map(e => `${c.dim("·")}          ${e}`),
  ];
  return [title, ...rows, c.dim(`type a request, or /help for commands · Ctrl+C interrupts`), ""].join("\n");
}

export function renderBox(title: string, body: string, c: Colors, width = 76): string {
  const line = "─".repeat(Math.max(4, width - title.length - 4));
  const top = c.dim(`┌─ `) + c.bold(title) + c.dim(` ${line}`);
  const rows = body.split("\n").map(l => c.dim("│ ") + l);
  const bottom = c.dim("└" + "─".repeat(width));
  return [top, ...rows, bottom].join("\n");
}

// ─── markdown-lite streaming renderer ────────────────────────────────────────

/**
 * Streams model text with line-level markdown styling: headers bold,
 * bullets prettified, `inline code` cyan, **bold**, and fenced code blocks
 * dimmed with a gutter. Partial lines buffer until their newline arrives so
 * styling never splits an escape sequence across chunks.
 */
export class MarkdownStreamRenderer {
  private buffer = "";
  private inFence = false;

  constructor(private c: Colors) {}

  feed(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      out += this.renderLine(line) + "\n";
    }
    return out;
  }

  /** Emit whatever is still buffered (end of message). */
  flush(): string {
    if (!this.buffer) return "";
    const rest = this.renderLine(this.buffer);
    this.buffer = "";
    return rest;
  }

  private renderLine(line: string): string {
    const c = this.c;
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      this.inFence = !this.inFence;
      const label = fence[1]?.trim();
      return c.dim(this.inFence ? `╭── ${label || "code"}` : "╰──");
    }
    if (this.inFence) return c.dim("│ ") + c.cyan(line);
    let styled = line;
    const header = styled.match(/^(#{1,4})\s+(.*)$/);
    if (header) return c.bold(c.magenta(header[2]));
    styled = styled.replace(/^(\s*)[-*]\s+/, (_m, ws) => `${ws}${c.dim("•")} `);
    styled = styled.replace(/\*\*([^*]+)\*\*/g, (_m, t) => c.bold(t));
    styled = styled.replace(/`([^`]+)`/g, (_m, t) => c.cyan(t));
    return styled;
  }
}

// ─── diffs ───────────────────────────────────────────────────────────────────

export function colorizeDiff(diff: string, c: Colors): string {
  return diff.split("\n").map(line => {
    if (line.startsWith("+++") || line.startsWith("---")) return c.bold(line);
    if (line.startsWith("@@")) return c.cyan(line);
    if (line.startsWith("+")) return c.green(line);
    if (line.startsWith("-")) return c.red(line);
    return c.dim(line);
  }).join("\n");
}

// ─── tool call formatting ────────────────────────────────────────────────────

export function formatToolCall(name: string, args: Record<string, unknown>, c: Colors): string {
  const detail = (() => {
    switch (name) {
      case "codebase-retrieval": return String(args.information_request ?? "");
      case "read-file": return `${args.path}${args.start_line ? `:${args.start_line}-${args.end_line ?? ""}` : ""}`;
      case "list-files": return String(args.directory ?? args.pattern ?? "");
      case "find-symbol-definition":
      case "find-symbol-references": return String(args.symbol ?? "");
      case "str-replace":
      case "create-file":
      case "remove-file": return String(args.path ?? "");
      case "run-command": return String(args.command ?? "");
      case "web-search": return String(args.query ?? "");
      case "delegate": return truncateMiddle(String(args.task ?? ""), 60);
      case "update-plan": return "";
      default: return truncateMiddle(JSON.stringify(args), 60);
    }
  })();
  return `${c.bold(name)}${detail ? " " + c.dim(truncateMiddle(detail, 80)) : ""}`;
}

export function formatToolResult(name: string, ok: boolean, ms: number | undefined, resultChars: number, c: Colors): string {
  const mark = ok ? c.green("✓") : c.red("✗");
  const timing = ms !== undefined ? c.dim(` ${(ms / 1000).toFixed(1)}s`) : "";
  return `${mark} ${c.bold(name)}${timing} ${c.dim(`(${resultChars.toLocaleString()} chars)`)}`;
}

// ─── plan + stats ────────────────────────────────────────────────────────────

export function formatPlan(steps: { step: string; status: string }[], c: Colors): string {
  if (!steps.length) return c.dim("(no plan)");
  return steps.map(s => {
    if (s.status === "completed") return `${c.green("✔")} ${c.dim(s.step)}`;
    if (s.status === "in_progress") return `${c.yellow("▸")} ${c.bold(s.step)}`;
    return `${c.dim("○")} ${s.step}`;
  }).join("\n");
}

export function formatStats(stats: { steps: number; toolCalls: number; toolErrors: number; usage: { inputTokens: number; outputTokens: number }; durationMs: number }, c: Colors): string {
  const tokens = stats.usage.inputTokens || stats.usage.outputTokens
    ? ` · ${stats.usage.inputTokens.toLocaleString()}→${stats.usage.outputTokens.toLocaleString()} tok`
    : "";
  const errors = stats.toolErrors ? c.red(` · ${stats.toolErrors} tool error${stats.toolErrors === 1 ? "" : "s"}`) : "";
  return c.dim(`${stats.steps} step${stats.steps === 1 ? "" : "s"} · ${stats.toolCalls} tool${stats.toolCalls === 1 ? "" : "s"}${tokens}${errors} · ${(stats.durationMs / 1000).toFixed(1)}s`);
}

// ─── spinner ─────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Single-line spinner. On non-TTY streams it prints each label once instead
 *  of animating, so logs and pipes stay clean. */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private text = "";
  private lastPrinted = "";

  constructor(private stream: NodeJS.WriteStream, private c: Colors) {}

  private get animated(): boolean { return Boolean(this.stream.isTTY); }

  start(text: string): void {
    this.text = text;
    if (!this.animated) {
      if (text !== this.lastPrinted) { this.stream.write(`… ${stripAnsi(text)}\n`); this.lastPrinted = text; }
      return;
    }
    if (this.timer) return this.update(text);
    this.timer = setInterval(() => this.draw(), 80);
    this.draw();
  }

  update(text: string): void {
    this.text = text;
    if (!this.animated && text !== this.lastPrinted) { this.stream.write(`… ${stripAnsi(text)}\n`); this.lastPrinted = text; }
  }

  /** Stop and replace the spinner line with `line` (or clear it). */
  stopWith(line?: string): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.animated) this.stream.write("\r[2K");
    if (line) this.stream.write(line + "\n");
  }

  private draw(): void {
    const f = this.c.cyan(FRAMES[this.frame = (this.frame + 1) % FRAMES.length]);
    this.stream.write(`\r[2K${f} ${this.text}`);
  }
}

// ─── slash commands ──────────────────────────────────────────────────────────

export interface SlashCommand {
  name: string;
  args: string;
}

/** Parse "/cmd arg…" → {name, args}; null for ordinary input. */
export function parseSlashCommand(input: string): SlashCommand | null {
  const m = input.trim().match(/^\/([a-z-]+)(?:\s+(.*))?$/i);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

export const HELP_TEXT = `
/help              show this help
/reset             clear the conversation (keeps the index)
/compact           summarize older history to free context
/plan              show the agent's current plan
/diff              show diffs from this session's edits
/usage             token usage for this session
/tools             list the tools the agent has
/mode [m]          show or set approval mode: suggest | auto-edit | full-auto
/sessions          list saved sessions
/resume <id>       resume a saved session
/exit              quit (Ctrl+C twice also works)
`.trim();
