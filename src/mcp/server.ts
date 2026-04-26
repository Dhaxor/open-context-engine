import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenContext } from "../core/context";
import { OpenContextConfig } from "../core/types";

function addTool(
  server: McpServer,
  name: string,
  description: string,
  schema: object,
  handler: (args: any) => Promise<any>
): void {
  (server as any).tool(name, description, schema, handler);
}

export async function createMCPServer(context: OpenContext): Promise<McpServer> {
  const server = new McpServer({ name: "open-context-engine", version: "0.1.0" });

  addTool(server, "codebase-retrieval", "Search the codebase using natural language. Returns code snippets with file paths and line numbers.", {
    information_request: z.string().describe("What code you're looking for"),
    max_output_length: z.number().optional().describe("Max output length"),
  }, async (p) => {
    try { return { content: [{ type: "text" as const, text: await context.search(p.information_request, p.max_output_length) }] }; }
    catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  addTool(server, "list-files", "List indexed files", {
    directory: z.string().optional().describe("Directory prefix"),
    pattern: z.string().optional().describe("Glob pattern"),
  }, async (p) => {
    try { return { content: [{ type: "text" as const, text: (await context.listFiles(p.directory, p.pattern)).join("\n") || "No files" }] }; }
    catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  addTool(server, "read-file", "Read file contents", {
    path: z.string().describe("Relative file path"),
    start_line: z.number().optional().describe("Start line"),
    end_line: z.number().optional().describe("End line"),
  }, async (p) => {
    try {
      const c = await context.readFile(p.path, p.start_line, p.end_line);
      return c === null
        ? { content: [{ type: "text" as const, text: `Not found: ${p.path}` }], isError: true }
        : { content: [{ type: "text" as const, text: c }] };
    } catch (e: any) { return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true }; }
  });

  return server;
}

export async function runMCPServer(config: OpenContextConfig): Promise<void> {
  const ctx = await OpenContext.create(config);
  const server = await createMCPServer(ctx);
  await server.connect(new StdioServerTransport());
}
