// A tiny stdio MCP server for mcp-client.test.ts: one read-only tool, one
// that mutates, one that reports an error. Built on the same SDK as OCE's own.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool("echo", {
  description: "Echo the text back",
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
server.registerTool("create_ticket", {
  description: "Create a ticket",
  inputSchema: { title: z.string() },
}, async ({ title }) => ({ content: [{ type: "text", text: `created "${title}"` }, { type: "image", data: "", mimeType: "image/png" }] }));
server.registerTool("explode", {
  description: "Always fails",
  inputSchema: {},
}, async () => ({ isError: true, content: [{ type: "text", text: "kaboom" }] }));

process.stderr.write("echo server ready\n");
server.connect(new StdioServerTransport());
