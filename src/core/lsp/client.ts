/**
 * LSP client over stdio for symbol lookup. Speaks just enough JSON-RPC:
 * initialize → textDocument/definition | textDocument/references → shutdown.
 *
 * Deliberately tolerant: a server that errors on an optional method, logs
 * profusely, or exits mid-session produces empty results / clean errors —
 * LSP is an accuracy upgrade over the AST graph, never a hard dependency.
 */
import { spawn, type ChildProcess } from "child_process";
import { createMessageReader, encodeMessage, type JsonRpcMessage } from "./protocol";
import { pathToFileURL } from "url";
import * as fs from "fs";
import * as path from "path";

export interface LspLocation { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }

export interface LspStartOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** workspace root, absolute — sent as rootUri */
  rootPath: string;
  /** per-request timeout in ms (default 10s) */
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

export class LspError extends Error {
  constructor(message: string, readonly code: "spawn" | "timeout" | "protocol" | "exited") {
    super(message);
  }
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private reader: ReturnType<typeof createMessageReader>;
  private disposed = false;
  /** Files announced via textDocument/didOpen — servers only answer queries
   *  about files they know. */
  private opened = new Set<string>();

  private constructor(private proc: ChildProcess, private opts: LspStartOptions) {
    this.reader = createMessageReader(msg => this.onMessage(msg));
    proc.stdout?.on("data", (chunk: Buffer) => this.reader.feed(chunk));
    const stderr: string[] = [];
    proc.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 20) stderr.push(c.toString("utf8"));
      this.opts.onLog?.(c.toString("utf8").trim());
    });
    proc.on("exit", () => {
      this.disposed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new LspError("language server exited", "exited"));
      }
      this.pending.clear();
    });
  }

  /** Start the server process and complete the initialize handshake. */
  static async start(opts: LspStartOptions): Promise<LspClient> {
    let proc: ChildProcess;
    try {
      proc = spawn(opts.command, opts.args ?? [], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      throw new LspError(`cannot start ${opts.command}: ${(e as Error).message}`, "spawn");
    }
    // Spawn errors arrive async on some platforms.
    const spawnFailure = new Promise<never>((_, reject) => proc.once("error", err => reject(new LspError(`cannot start ${opts.command}: ${err.message}`, "spawn"))));
    const client = new LspClient(proc, opts);
    try {
      await Promise.race([
        (async () => {
          const capabilities = await client.request("initialize", {
            processId: process.pid,
            rootUri: pathToFileURL(opts.rootPath).href,
            capabilities: {
              textDocument: { definition: { linkSupport: false }, references: {} },
            },
          });
          void capabilities;
          client.notify("initialized", {});
        })(),
        spawnFailure,
        timeout(opts.timeoutMs ?? 10_000, "initialize", "timeout"),
      ]);
    } catch (e) {
      client.dispose().catch(() => {});
      throw e;
    }
    return client;
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (msg.id === undefined) return; // notification (window/logMessage etc.) — ignored
    const p = this.pending.get(Number(msg.id));
    if (!p) return;
    this.pending.delete(Number(msg.id));
    clearTimeout(p.timer);
    if (msg.error) p.reject(new LspError(msg.error.message || "server error", "protocol"));
    else p.resolve(msg.result);
  }

  private request(method: string, params: unknown, timeoutMs = this.opts.timeoutMs ?? 10_000): Promise<unknown> {
    if (this.disposed || !this.proc.stdin?.writable) return Promise.reject(new LspError("client disposed", "exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`${method} timed out after ${timeoutMs}ms`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc.stdin?.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  /** Announce a file to the server (textDocument/didOpen) if not already
   *  opened. Language servers index opened files; queries about files the
   *  server has never seen return empty. Best-effort: unreadable file → skip
   *  (the query will come back empty and the caller falls back). */
  private ensureOpened(pathAbs: string): void {
    const uri = pathToFileURL(pathAbs).href;
    if (this.opened.has(uri)) return;
    try {
      const text = fs.readFileSync(pathAbs, "utf8");
      const languageId = LANGUAGE_BY_EXT[path.extname(pathAbs).toLowerCase()] ?? "plaintext";
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
      this.opened.add(uri);
    } catch { /* unreadable — let the query answer empty */ }
  }

  async definition(pathAbs: string, line: number, character: number): Promise<LspLocation[]> {
    this.ensureOpened(pathAbs);
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(pathAbs).href },
      position: { line, character },
    });
    return asLocations(result);
  }

  async references(pathAbs: string, line: number, character: number, includeDeclaration = false): Promise<LspLocation[]> {
    this.ensureOpened(pathAbs);
    const result = await this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(pathAbs).href },
      position: { line, character },
      context: { includeDeclaration },
    });
    return asLocations(result);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try { await this.request("shutdown", undefined, 2_000); } catch { /* server may already be gone */ }
    try { this.notify("exit", {}); } catch { /* ditto */ }
    // Close the pipe: well-behaved servers exit when stdin closes, which also
    // releases their CWD handle (on Windows a live child blocks deleting the
    // directory it was started in). Then enforce.
    try { this.proc.stdin?.end(); } catch { /* gone */ }
    const proc = this.proc;
    const kill = () => { try { if (!proc.killed) proc.kill(); } catch { /* gone */ } };
    setTimeout(kill, 250).unref?.();
    proc.once("exit", kill);
  }
}

function asLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.filter((l): l is LspLocation =>
    !!l && typeof (l as LspLocation).uri === "string" && !!((l as LspLocation).range?.start));
}

function timeout(ms: number, what: string, code: "timeout"): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new LspError(`${what} timed out after ${ms}ms`, code)), ms));
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript",
  ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby",
  ".java": "java", ".cs": "csharp", ".php": "php", ".kt": "kotlin", ".swift": "swift",
};
