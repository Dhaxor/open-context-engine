import * as http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenContext } from "../core/context";
import { OpenContextConfig } from "../core/types";
import { liveIndex } from "../core/live-index";
import { FileWatcher } from "../core/file-watcher";
import { AuditLogger } from "../core/audit";
import { renderDefinition, renderReference } from "../agent/agent";

export interface CreateMCPServerOptions {
  /** When set, every MCP tool invocation is appended to the audit log. */
  audit?: AuditLogger;
}

export async function createMCPServer(context: OpenContext, opts: CreateMCPServerOptions = {}): Promise<McpServer> {
  const server = new McpServer({ name: "open-context-engine", version: "0.1.0" });
  const audit = (tool: string, args: Record<string, unknown>) =>
    opts.audit?.log("mcp", { tool, arguments: JSON.stringify(args) });

  server.registerTool("codebase-retrieval", {
    description: "Search the codebase using natural language. Returns code snippets with file paths and line numbers.",
    inputSchema: {
      information_request: z.string().describe("What code you're looking for"),
      max_output_length: z.number().optional().describe("Max output length"),
    },
  } as any, async (p: any) => {
    try {
      audit("codebase-retrieval", { information_request: p.information_request });
      return { content: [{ type: "text" as const, text: await context.search(p.information_request, p.max_output_length) }] };
    }
    catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("list-files", {
    description: "List indexed files",
    inputSchema: {
      directory: z.string().optional().describe("Directory prefix"),
      pattern: z.string().optional().describe("Glob pattern"),
    },
  } as any, async (p: any) => {
    try {
      audit("list-files", { directory: p.directory, pattern: p.pattern });
      return { content: [{ type: "text" as const, text: (await context.listFiles(p.directory, p.pattern)).join("\n") || "No files" }] };
    }
    catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("read-file", {
    description: "Read file contents",
    inputSchema: {
      path: z.string().describe("Relative file path"),
      start_line: z.number().optional().describe("Start line"),
      end_line: z.number().optional().describe("End line"),
    },
  } as any, async (p: any) => {
    try {
      audit("read-file", { path: p.path, start_line: p.start_line, end_line: p.end_line });
      const c = await context.readFile(p.path, p.start_line, p.end_line);
      return c === null
        ? { content: [{ type: "text" as const, text: `Not found: ${p.path}` }], isError: true }
        : { content: [{ type: "text" as const, text: c }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("find-symbol-definition", {
    description: "Find where a symbol (function, class, method, type) is DEFINED, by exact name. Precise and instant — prefer over codebase-retrieval when the exact identifier is known. Returns defining chunk(s) with path, line range, and source.",
    inputSchema: {
      symbol: z.string().describe("Exact symbol name, e.g. 'HybridRetriever'. Case-sensitive."),
    },
  } as any, async (p: any) => {
    try {
      const symbol = String(p.symbol ?? "").trim();
      audit("find-symbol-definition", { symbol });
      if (!symbol) return { content: [{ type: "text" as const, text: "No symbol given." }], isError: true };
      const defs = context.findSymbolDefinitions(symbol, 5);
      const text = defs.length
        ? defs.map(c => renderDefinition(c)).join("\n\n")
        : `No definition found for '${symbol}'. The name must match the declared identifier exactly (case-sensitive) — try codebase-retrieval for fuzzy lookup.`;
      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("find-symbol-references", {
    description: "Find every indexed place a symbol/identifier is USED (exact word-boundary match, case-sensitive). Use to trace callers, check impact of a change, or find usage examples.",
    inputSchema: {
      symbol: z.string().describe("Exact identifier to look up, e.g. 'vectorSearch'."),
      path: z.string().optional().describe("Optional: restrict to one indexed file path."),
    },
  } as any, async (p: any) => {
    try {
      const symbol = String(p.symbol ?? "").trim();
      audit("find-symbol-references", { symbol, path: p.path });
      if (!symbol) return { content: [{ type: "text" as const, text: "No symbol given." }], isError: true };
      const refs = context.findSymbolReferences(symbol, p.path ? String(p.path) : undefined, 12);
      const text = refs.length
        ? refs.map(c => renderReference(c, symbol)).join("\n")
        : `No references to '${symbol}' found${p.path ? ` in ${p.path}` : ""} (exact, case-sensitive match).`;
      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("index-status", {
    description: "Report index health: chunk count, indexed file count, search mode (hybrid vs keyword-only), and embedding model.",
    inputSchema: {},
  } as any, async () => {
    try {
      const status = context.getStatus();
      audit("index-status", {});
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...status, chunks: context.getChunkCount() }, null, 2) }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  return server;
}

export interface HttpTransportOptions {
  port: number;
  /** Bind host. Default 127.0.0.1 — loopback-only unless explicitly widened. */
  host?: string;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  authToken?: string;
}

export interface RunMCPServerOptions {
  /** Keep the index live by watching the workspace. Defaults to true. */
  watch?: boolean;
  /** Serve over Streamable HTTP instead of stdio (e.g. a shared team endpoint). */
  http?: HttpTransportOptions;
  /** Audit every tool invocation to the workspace audit log. */
  audit?: AuditLogger;
}

/** Serve MCP over Streamable HTTP. Takes a server FACTORY: in stateless mode
 *  every request gets a fresh transport+server pair (the SDK's documented
 *  pattern — sharing one transport across clients corrupts the handshake).
 *  Tool registration is cheap; the heavy state (the index) lives in the shared
 *  OpenContext the factory closes over. Exported for tests. */
export async function startHttpServer(serverFactory: () => Promise<McpServer>, opts: HttpTransportOptions, log: (m: string) => void): Promise<http.Server> {
  // Lazy import: stdio users never pay for the HTTP transport.
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (opts.authToken) {
        const header = req.headers.authorization ?? "";
        if (header !== `Bearer ${opts.authToken}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : undefined;
      const server = await serverFactory();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e: any) {
      log(`http error: ${e?.message ?? e}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
      } else {
        res.end();
      }
    }
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, host, () => resolve());
  });
  log(`listening on http://${host}:${opts.port} (Streamable HTTP)${opts.authToken ? " — bearer auth required" : ""}`);
  return httpServer;
}

export async function runMCPServer(config: OpenContextConfig, opts: RunMCPServerOptions = {}): Promise<void> {
  const ctx = await OpenContext.create(config);
  const log = (m: string) => process.stderr.write(`[open-context] ${m}\n`);

  // Connect before indexing so the MCP initialize handshake isn't blocked by a
  // potentially slow first index. stdout is the protocol channel — all logs go to stderr.
  let httpServer: http.Server | null = null;
  if (opts.http) {
    httpServer = await startHttpServer(() => createMCPServer(ctx, { audit: opts.audit }), opts.http, log);
  } else {
    const server = await createMCPServer(ctx, { audit: opts.audit });
    await server.connect(new StdioServerTransport());
  }

  // Mode is known as soon as the store opened — warn now, not only after a
  // successful index (the initial index can fail while degraded search keeps
  // serving, and that path used to skip the warning entirely).
  {
    const status = ctx.getStatus();
    if (status.searchMode === "keyword-only") {
      log(`WARNING: sqlite-vec unavailable — running keyword-only (BM25) search without semantic ranking. ${status.degradedReason ?? ""}`);
    }
  }

  let watcher: FileWatcher | null = null;
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    try { await watcher?.stop(); } catch {}
    try { httpServer?.close(); } catch {}
    ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Bring the index up to date and keep it live, without blocking startup.
  void liveIndex(ctx, config, {
    watch: opts.watch ?? true,
    onReindex: (r) => log(`reindexed: +${r.newlyIndexed.length} ~${r.removed.length} removed (${r.duration}ms)${r.failed?.length ? ` — ${r.failed.length} FAILED to embed (will retry next index): ${r.failedReason ?? ""}` : ""}`),
    onError: (e) => log(`watch error: ${e.message}`),
  })
    .then(({ result, watcher: w }) => {
      watcher = w;
      log(`index ready: ${ctx.getChunkCount()} chunks across ${result.newlyIndexed.length + result.alreadyIndexed.length} files${w ? "; watching for changes" : ""}`);
      if (result.failed?.length) log(`WARNING: ${result.failed.length} file(s) failed to embed — they will be retried on the next index. ${result.failedReason ?? ""}`);
    })
    .catch((e) => log(`initial index failed: ${e instanceof Error ? e.message : String(e)}`));
}
