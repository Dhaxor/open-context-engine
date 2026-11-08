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
import { createMcpStderrDiagnostics, Diagnostics } from "../core/diagnostics";
import { buildRepoMap } from "../core/repo-map";
import { createLspFinder, type LspFinder } from "../core/lsp";
import { packageVersion } from "../version";
import { SessionMemory, looksLikeSecret, type MemoryKind } from "../agent/session-memory";

/** Cheap tag extraction shared with the memory store's own tagging. */
function extractTagsPublic(content: string): string[] {
  const words = content.match(/[A-Z][a-z]+[A-Z]\w+|[a-z_]{4,}/g) ?? [];
  return [...new Set(words.map(w => w.toLowerCase()))].slice(0, 5);
}

export interface CreateMCPServerOptions {
  /** When set, every MCP tool invocation is appended to the audit log. */
  audit?: AuditLogger;
  /** Durable session memory backing the memory_* tools. When absent, one is
   *  created beside the index store (lexical recall only — no embedder). */
  memory?: SessionMemory;
}

/** LSP symbol lookup, best-effort. Returns null whenever no language server
 *  is installed or it misbehaves — callers then use the AST index untouched.
 *  OCE_LSP=off disables the layer entirely (same fallback). */
async function withLsp<T>(context: OpenContext, fn: (finder: LspFinder) => Promise<T | null>): Promise<T | null> {
  if (process.env.OCE_LSP === "off") return null;
  try {
    const finder = createLspFinder(context.getWorkspaceRoot(), context.getStore());
    return await fn(finder);
  } catch {
    return null;
  }
}

/** Render an LSP hit with real source when the index has a chunk covering it,
 *  as a bare location otherwise. Tagged "LSP" so callers can see the grade of
 *  the evidence. */
function renderLspHit(context: OpenContext, hit: { path: string; startLine: number; endLine: number }, symbol: string, kind: "definition" | "reference"): string {
  const chunks = context.getStore().getChunksByPath(hit.path, 200);
  const covering = chunks.find(c => c.startLine <= hit.startLine && c.endLine >= hit.endLine)
    ?? chunks.find(c => c.path === hit.path && c.symbolName === symbol);
  const chunk = covering ?? {
    id: `${hit.path}:${hit.startLine}-${hit.endLine}`,
    path: hit.path,
    startLine: hit.startLine,
    endLine: hit.endLine,
    contents: "",
  };
  const tag = kind === "definition" ? renderDefinition(chunk) : renderReference(chunk, symbol);
  return `${tag}\n  [LSP-verified]`;
}

export async function createMCPServer(context: OpenContext, opts: CreateMCPServerOptions = {}): Promise<McpServer> {
  const server = new McpServer({ name: "open-context-engine", version: packageVersion() });
  const audit = (tool: string, args: Record<string, unknown>) =>
    opts.audit?.log("mcp", { tool, arguments: JSON.stringify(args) });
  const memory = opts.memory ?? new SessionMemory({ storePath: context.getStorePath() });

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
      if (c === null) return { content: [{ type: "text" as const, text: `Not found: ${p.path}` }], isError: true };
      const isPathOutsideWorkspace = c.includes("path is outside the workspace");
      return {
        content: [{ type: "text" as const, text: c }],
        ...(isPathOutsideWorkspace ? { isError: true } : {}),
      };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("find-symbol-definition", {
    description: "Find where a symbol (function, class, method, type) is DEFINED, by exact name. Precise and instant — prefer over codebase-retrieval when the exact identifier is known. Returns defining chunk(s) with path, line range, and source. Uses a language server when one is installed (marked LSP); otherwise the AST index.",
    inputSchema: {
      symbol: z.string().describe("Exact symbol name, e.g. 'HybridRetriever'. Case-sensitive."),
    },
  } as any, async (p: any) => {
    try {
      const symbol = String(p.symbol ?? "").trim();
      audit("find-symbol-definition", { symbol });
      if (!symbol) return { content: [{ type: "text" as const, text: "No symbol given." }], isError: true };
      const lspHits = await withLsp(context, f => f.definition(symbol));
      if (lspHits) {
        const text = lspHits.length
          ? lspHits.map(h => renderLspHit(context, h, symbol, "definition")).join("\n\n")
          : `No definition found for '${symbol}' (language server).`;
        return { content: [{ type: "text" as const, text }] };
      }
      const defs = context.findSymbolDefinitions(symbol, 5);
      const text = defs.length
        ? defs.map(c => renderDefinition(c)).join("\n\n")
        : `No definition found for '${symbol}'. The name must match the declared identifier exactly (case-sensitive) — try codebase-retrieval for fuzzy lookup.`;
      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("find-symbol-references", {
    description: "Find every place a symbol/identifier is USED (exact word-boundary match, case-sensitive). Use to trace callers, check impact of a change, or find usage examples. Uses a language server when one is installed (compiler-accurate, marked LSP); otherwise the AST index.",
    inputSchema: {
      symbol: z.string().describe("Exact identifier to look up, e.g. 'vectorSearch'."),
      path: z.string().optional().describe("Optional: restrict to one indexed file path."),
    },
  } as any, async (p: any) => {
    try {
      const symbol = String(p.symbol ?? "").trim();
      audit("find-symbol-references", { symbol, path: p.path });
      if (!symbol) return { content: [{ type: "text" as const, text: "No symbol given." }], isError: true };
      // Path-filtered lookups stay on the index: LSP results are workspace-wide.
      if (!p.path) {
        const lspHits = await withLsp(context, f => f.references(symbol, 12));
        if (lspHits) {
          const text = lspHits.length
            ? lspHits.map(h => renderLspHit(context, h, symbol, "reference")).join("\n")
            : `No references to '${symbol}' found (language server).`;
          return { content: [{ type: "text" as const, text }] };
        }
      }
      const refs = context.findSymbolReferences(symbol, p.path ? String(p.path) : undefined, 12);
      const text = refs.length
        ? refs.map(c => renderReference(c, symbol)).join("\n")
        : `No references to '${symbol}' found${p.path ? ` in ${p.path}` : ""} (exact, case-sensitive match).`;
      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("repo-map", {
    description: "Get a compact structural map of the indexed codebase: files with their declared symbols (classes, functions, types) and line ranges, ranked by structure density. Use this FIRST for broad questions (architecture, overview, 'how is this organized') — it costs a few thousand tokens instead of dozens of retrieval calls, and tells you exactly which files and symbols to read or search next. Supports an optional path prefix to scope the map to a subtree.",
    inputSchema: {
      pathPrefix: z.string().optional().describe("Optional: restrict the map to files under this path prefix (e.g. 'src/core/')."),
      maxChars: z.number().optional().describe("Optional character budget for the map (default 4000)."),
    },
  } as any, async (p: any) => {
    try {
      const prefix = p.pathPrefix ? String(p.pathPrefix) : undefined;
      const maxChars = p.maxChars ? Math.max(200, Math.min(20000, Number(p.maxChars))) : undefined;
      audit("repo-map", { pathPrefix: prefix, maxChars });
      const map = buildRepoMap(context.getStore(), { pathPrefix: prefix, maxChars });
      return { content: [{ type: "text" as const, text: map || "The index is empty — run an index first." }] };
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

  // ─── session memory ────────────────────────────────────────────────────────
  // Durable cross-session memory, stored locally beside the index. These tools
  // make the memory layer available to ANY MCP client — Claude Code, Cursor,
  // CI bots — not just the built-in agent.

  server.registerTool("memory_remember", {
    description: "Persist a durable memory for future sessions (e.g. 'auth middleware lives in src/auth/jwt.ts', 'the team prefers pnpm'). Kind: codebase_insight (default for learned facts), preference (user-stated), fact, conversation_summary. Pass supersedes (a memory id) when this memory REPLACES an older one — the old memory stops being recalled.",
    inputSchema: {
      content: z.string().describe("The memory, one self-contained sentence."),
      kind: z.enum(["fact", "preference", "codebase_insight", "conversation_summary"]).optional().describe("Memory kind (default: codebase_insight)"),
      tags: z.array(z.string()).optional().describe("Optional lookup tags"),
      supersedes: z.string().optional().describe("Id (or exact content) of an older memory this one replaces"),
    },
  } as any, async (p: any) => {
    try {
      const content = String(p.content ?? "").trim();
      if (!memory) return { content: [{ type: "text" as const, text: "Error: memory store unavailable." }], isError: true };
      if (content.length < 5 || content.length > 500) {
        return { content: [{ type: "text" as const, text: "Error: memory must be one sentence between 5 and 500 characters." }], isError: true };
      }
      if (looksLikeSecret(content)) {
        return { content: [{ type: "text" as const, text: "Error: this looks like a secret (API key, token, credential) — memories never store secrets." }], isError: true };
      }
      const kind = (p.kind ?? "codebase_insight") as MemoryKind;
      audit("memory_remember", { kind, supersedes: p.supersedes ?? undefined });
      const entry = memory.add({
        kind,
        content,
        source: "mcp",
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 5).map(String) : extractTagsPublic(content),
        ...(p.supersedes ? { supersedes: String(p.supersedes) } : {}),
      });
      const replaced = entry.supersedes ? ` (supersedes ${entry.supersedes})` : "";
      return { content: [{ type: "text" as const, text: `Remembered ${entry.id}${replaced}: [${entry.kind}] ${entry.content}` }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("memory_recall", {
    description: "Recall durable memories relevant to a query — hybrid lexical + semantic retrieval over what was remembered in prior sessions. Memories may be stale: verify against the current code before relying on them.",
    inputSchema: {
      query: z.string().describe("What to recall, e.g. 'how is auth done'"),
      top_k: z.number().optional().describe("Max memories to return (default 5)"),
    },
  } as any, async (p: any) => {
    try {
      if (!memory) return { content: [{ type: "text" as const, text: "Error: memory store unavailable." }], isError: true };
      const query = String(p.query ?? "").trim();
      if (!query) return { content: [{ type: "text" as const, text: "No query given." }], isError: true };
      audit("memory_recall", { query });
      const topK = Math.max(1, Math.min(20, Number(p.top_k) || 5));
      const hits = await memory.recall(query, topK);
      if (!hits.length) return { content: [{ type: "text" as const, text: "No relevant memories." }] };
      const lines = hits.map(e => {
        const date = new Date(e.createdAt).toISOString().slice(0, 10);
        return `- [${e.kind}] ${e.content} (remembered ${date}, id ${e.id})`;
      });
      return { content: [{ type: "text" as const, text: `## Remembered (may be stale — verify against current code)\n${lines.join("\n")}` }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("memory_forget", {
    description: "Delete a durable memory by id (ids come from memory_recall or memory_remember). Use when a memory is wrong or no longer relevant.",
    inputSchema: {
      id: z.string().describe("Memory id, e.g. 'mem_abc123_x9'"),
    },
  } as any, async (p: any) => {
    try {
      if (!memory) return { content: [{ type: "text" as const, text: "Error: memory store unavailable." }], isError: true };
      const id = String(p.id ?? "").trim();
      audit("memory_forget", { id });
      const ok = memory.forget(id);
      return { content: [{ type: "text" as const, text: ok ? `Forgot ${id}.` : `No memory with id ${id}.` }], ...(ok ? {} : { isError: true }) };
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
export async function startHttpServer(serverFactory: () => Promise<McpServer>, opts: HttpTransportOptions, diagnosticsOrLog: Diagnostics | ((message: string) => void)): Promise<http.Server> {
  const diagnostics: Diagnostics = typeof diagnosticsOrLog === "function"
    ? { info: diagnosticsOrLog, warn: diagnosticsOrLog, error: diagnosticsOrLog, debug: diagnosticsOrLog, progress: diagnosticsOrLog }
    : diagnosticsOrLog;
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
      diagnostics.error(`http error: ${e?.message ?? e}`);
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
  diagnostics.info(`listening on http://${host}:${opts.port} (Streamable HTTP)${opts.authToken ? " — bearer auth required" : ""}`);
  return httpServer;
}

export async function runMCPServer(config: OpenContextConfig, opts: RunMCPServerOptions = {}): Promise<void> {
  const ctx = await OpenContext.create(config);
  const diagnostics = createMcpStderrDiagnostics();

  // One memory store for the whole server lifecycle — shared across HTTP's
  // stateless per-request servers, so remembered facts survive requests.
  const memory = new SessionMemory({
    storePath: ctx.getStorePath(),
    embedder: ctx.getEmbedder(),
  });

  // Connect before indexing so the MCP initialize handshake isn't blocked by a
  // potentially slow first index. stdout is the protocol channel — all logs go to stderr.
  let httpServer: http.Server | null = null;
  if (opts.http) {
    httpServer = await startHttpServer(() => createMCPServer(ctx, { audit: opts.audit, memory }), opts.http, diagnostics);
  } else {
    const server = await createMCPServer(ctx, { audit: opts.audit, memory });
    await server.connect(new StdioServerTransport());
  }

  // Mode is known as soon as the store opened — warn now, not only after a
  // successful index (the initial index can fail while degraded search keeps
  // serving, and that path used to skip the warning entirely).
  {
    const status = ctx.getStatus();
    if (status.searchMode === "keyword-only") {
      diagnostics.warn(`WARNING: sqlite-vec unavailable — running keyword-only (BM25) search without semantic ranking. ${status.degradedReason ?? ""}`);
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
    onReindex: (r) => diagnostics.info(`reindexed: +${r.newlyIndexed.length} ~${r.removed.length} removed (${r.duration}ms)${r.failed?.length ? ` — ${r.failed.length} FAILED to embed (will retry next index): ${r.failedReason ?? ""}` : ""}`),
    onError: (e) => diagnostics.error(`watch error: ${e.message}`),
  })
    .then(({ result, watcher: w }) => {
      watcher = w;
      diagnostics.info(`index ready: ${ctx.getChunkCount()} chunks across ${result.newlyIndexed.length + result.alreadyIndexed.length} files${w ? "; watching for changes" : ""}`);
      if (result.failed?.length) diagnostics.warn(`WARNING: ${result.failed.length} file(s) failed to embed — they will be retried on the next index. ${result.failedReason ?? ""}`);
    })
    .catch((e) => diagnostics.error(`initial index failed: ${e instanceof Error ? e.message : String(e)}`));
}
