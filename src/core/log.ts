/**
 * Structured, leveled logging — local stderr only, no telemetry ever (the
 * privacy stance is a feature). Replaces the scattered
 * `OPEN_CONTEXT_DEBUG`-gated console.error calls and the silent `catch {}`
 * swallows that made field regressions undebuggable.
 *
 *   OCE_LOG=silent|error|info|debug   level (default error; OPEN_CONTEXT_DEBUG=1 implies debug)
 *   OCE_LOG_FORMAT=text|json          json = one JSON object per line for log shippers
 */

export type LogLevel = "silent" | "error" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

function envLevel(): LogLevel {
  const raw = (process.env.OCE_LOG ?? "").toLowerCase();
  if (raw === "silent" || raw === "error" || raw === "info" || raw === "debug") return raw;
  if (process.env.OPEN_CONTEXT_DEBUG) return "debug";
  return "error";
}

export interface LogRecord {
  ts: string;
  level: Exclude<LogLevel, "silent">;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

type Sink = (record: LogRecord) => void;

function defaultSink(record: LogRecord): void {
  if (process.env.OCE_LOG_FORMAT === "json") {
    process.stderr.write(JSON.stringify(record) + "\n");
    return;
  }
  const data = record.data ? " " + JSON.stringify(record.data) : "";
  process.stderr.write(`[oce:${record.component}] ${record.level}: ${record.message}${data}\n`);
}

let sink: Sink = defaultSink;
let levelOverride: LogLevel | null = null;

export function __setLogSinkForTests(custom: Sink | null): void {
  sink = custom ?? defaultSink;
}
export function __setLogLevelForTests(level: LogLevel | null): void {
  levelOverride = level;
}

function emit(level: Exclude<LogLevel, "silent">, component: string, message: string, data?: Record<string, unknown>): void {
  const active = levelOverride ?? envLevel();
  if (LEVEL_RANK[active] < LEVEL_RANK[level]) return;
  try {
    sink({ ts: new Date().toISOString(), level, component, message, ...(data ? { data } : {}) });
  } catch {
    // Logging must never take the engine down.
  }
}

export interface Logger {
  error(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
  return {
    error: (m, d) => emit("error", component, m, d),
    info: (m, d) => emit("info", component, m, d),
    debug: (m, d) => emit("debug", component, m, d),
  };
}

/** Render an unknown thrown value for a log field. */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
