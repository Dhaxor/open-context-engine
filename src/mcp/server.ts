import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenContext } from "../core/context";
import { OpenContextConfig } from "../core/types";
import { liveIndex } from "../core/live-index";
import { FileWatcher } from "../core/file-watcher";

export async function createMCPServer(context: OpenContext): Promise<McpServer> {
  const server = new McpServer({ name: "open-context-engine", version: "0.1.0" });

  server.registerTool("codebase-retrieval", {
    description: "Search the codebase using natural language. Returns code snippets with file paths and line numbers.",
    inputSchema: {
      information_request: z.string().describe("What code you're looking for"),
      max_output_length: z.number().optional().describe("Max output length"),
    },
  } as any, async (p: any) => {
    try { return { content: [{ type: "text" as const, text: await context.search(p.information_request, p.max_output_length) }] }; }
    catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  server.registerTool("list-files", {
    description: "List indexed files",
    inputSchema: {
      directory: z.string().optional().describe("Directory prefix"),
      pattern: z.string().optional().describe("Glob pattern"),
    },
  } as any, async (p: any) => {
    try { return { content: [{ type: "text" as const, text: (await context.listFiles(p.directory, p.pattern)).join("\n") || "No files" }] }; }
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
      const c = await context.readFile(p.path, p.start_line, p.end_line);
      return c === null
        ? { content: [{ type: "text" as const, text: `Not found: ${p.path}` }], isError: true }
        : { content: [{ type: "text" as const, text: c }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  return server;
}

export interface RunMCPServerOptions {
  /** Keep the index live by watching the workspace. Defaults to true. */
  watch?: boolean;
}

export async function runMCPServer(config: OpenContextConfig, opts: RunMCPServerOptions = {}): Promise<void> {
  const ctx = await OpenContext.create(config);
  const server = await createMCPServer(ctx);
  // Connect before indexing so the MCP initialize handshake isn't blocked by a
  // potentially slow first index. stdout is the protocol channel — all logs go to stderr.
  await server.connect(new StdioServerTransport());
  const log = (m: string) => process.stderr.write(`[open-context] ${m}\n`);

  let watcher: FileWatcher | null = null;
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    try { await watcher?.stop(); } catch {}
    ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Bring the index up to date and keep it live, without blocking startup.
  void liveIndex(ctx, config, {
    watch: opts.watch ?? true,
    onReindex: (r) => log(`reindexed: +${r.newlyIndexed.length} ~${r.removed.length} removed (${r.duration}ms)`),
    onError: (e) => log(`watch error: ${e.message}`),
  })
    .then(({ result, watcher: w }) => {
      watcher = w;
      log(`index ready: ${ctx.getChunkCount()} chunks across ${result.newlyIndexed.length + result.alreadyIndexed.length} files${w ? "; watching for changes" : ""}`);
    })
    .catch((e) => log(`initial index failed: ${e instanceof Error ? e.message : String(e)}`));
}
