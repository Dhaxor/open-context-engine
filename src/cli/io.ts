import { createCliHumanDiagnostics, createCliJsonDiagnostics, Diagnostics } from "../core/diagnostics";

/**
 * CLI output and exit policy behind one interface so commands stay testable:
 * `fatal` throws instead of calling process.exit (the entry point turns it
 * into exit 1), `fail` records a non-zero exit code without stopping the
 * command, and every byte written goes through injectable writers.
 */
export class CliFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliFatalError";
  }
}

export interface CliIo {
  /** Plain output (a line is appended unless the message already ends in one). */
  text(message: string): void;
  /** Exactly one JSON document on stdout. */
  json(value: unknown): void;
  info(message: string): void;
  progress(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Report a failure and mark the process exit non-zero, but keep going. */
  fail(message: string): void;
  /** Report a misconfiguration and stop the command. Throws CliFatalError. */
  fatal(message: string): never;
  diagnosticsFor(opts: { json?: boolean }): Diagnostics;
}

/** Callbacks shaped like the streams the diagnostics layer writes to. */
type Sink = { out?: (s: string) => void; err?: (s: string) => void };

export function createCliIo(sink: Sink = {}): CliIo {
  const stdout = sink.out ? { write: (s: string) => void sink.out!(s) } : process.stdout;
  const stderr = sink.err ? { write: (s: string) => void sink.err!(s) } : process.stderr;
  const human = createCliHumanDiagnostics({ stdout: stdout as any, stderr: stderr as any });
  const json = createCliJsonDiagnostics({ stderr: stderr as any });
  return {
    text: (message) => human.progress(message.endsWith("\n") ? message : message + "\n"),
    json: (value) => (stdout as any).write(JSON.stringify(value, null, 2) + "\n"),
    info: (m) => human.info(m),
    progress: (m) => human.progress(m),
    warn: (m) => human.warn(m),
    error: (m) => human.error(m),
    fail: (m) => { human.error(m); process.exitCode = 1; },
    fatal: (m): never => { human.error(m); throw new CliFatalError(m); },
    diagnosticsFor: (opts) => (opts.json ? json : human),
  };
}
