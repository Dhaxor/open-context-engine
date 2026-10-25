export interface Diagnostics {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  /** Progress/status text that may update in place. */
  progress(message: string): void;
}

export type WritableLike = Pick<NodeJS.WritableStream, "write">;

export interface CliDiagnosticsOptions {
  stdout?: WritableLike;
  stderr?: WritableLike;
  debug?: boolean;
}

const writeLine = (stream: WritableLike, message: string) => stream.write(message.endsWith("\n") ? message : `${message}\n`);

export function createCliHumanDiagnostics(opts: CliDiagnosticsOptions = {}): Diagnostics {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const debugEnabled = opts.debug ?? !!process.env.OPEN_CONTEXT_DEBUG;
  return {
    info: (m) => writeLine(stdout, m),
    warn: (m) => writeLine(stderr, m),
    error: (m) => writeLine(stderr, m),
    debug: (m) => { if (debugEnabled) writeLine(stderr, m); },
    progress: (m) => stdout.write(m),
  };
}

/** For --json CLI modes: stdout is reserved for the single JSON document. */
export function createCliJsonDiagnostics(opts: CliDiagnosticsOptions = {}): Diagnostics {
  const stderr = opts.stderr ?? process.stderr;
  const debugEnabled = opts.debug ?? !!process.env.OPEN_CONTEXT_DEBUG;
  return {
    info: (m) => writeLine(stderr, m),
    warn: (m) => writeLine(stderr, m),
    error: (m) => writeLine(stderr, m),
    debug: (m) => { if (debugEnabled) writeLine(stderr, m); },
    progress: (m) => stderr.write(m),
  };
}

export function createMcpStderrDiagnostics(prefix = "[open-context]", opts: CliDiagnosticsOptions = {}): Diagnostics {
  const stderr = opts.stderr ?? process.stderr;
  const line = (m: string) => writeLine(stderr, `${prefix} ${m}`);
  return { info: line, warn: line, error: line, debug: (m) => { if (opts.debug ?? !!process.env.OPEN_CONTEXT_DEBUG) line(m); }, progress: line };
}

export interface ExtensionDiagnosticsTarget {
  appendLine(message: string): void;
}

export function createExtensionDiagnostics(target: ExtensionDiagnosticsTarget, prefix = "[openContext]"): Diagnostics {
  const line = (level: string, message: string) => target.appendLine(`${prefix} ${level}: ${message}`);
  return {
    info: (m) => line("info", m),
    warn: (m) => line("warn", m),
    error: (m) => line("error", m),
    debug: (m) => line("debug", m),
    progress: (m) => line("progress", m),
  };
}

export function createSilentDiagnostics(): Diagnostics {
  return { info() {}, warn() {}, error() {}, debug() {}, progress() {} };
}
