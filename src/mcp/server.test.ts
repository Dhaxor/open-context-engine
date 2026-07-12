import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMCPServer, startHttpServer } from "./server";
import { OpenContext } from "../core/context";
import { EmbeddingProvider } from "../core/embedder";
import { AuditLogger, readAuditEvents } from "../core/audit";

const DIM = 4;
const embedder: EmbeddingProvider = {
  embed: async (texts: string[]) => texts.map(t => [t.length % 5, 0.2, 0.3, 0.4]),
  getDimension: () => DIM,
  getModel: () => "mock",
};

let dir: string;
let ctx: OpenContext;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-mcp-"));
  ctx = await OpenContext.create({
    workspaceRoot: dir,
    storePath: path.join(dir, ".store"),
    embedding: { provider: "ollama", model: "mock", dimension: DIM, batchSize: 32 },
    embedder,
    policy: false,
  });
  const files = [
    { path: "src/auth.ts", contents: "export function authenticate(user: string) {\n  return user.length > 0;\n}\n" },
    { path: "src/main.ts", contents: "import { authenticate } from './auth';\nauthenticate('admin');\n" },
  ];
  // read-file serves from disk, the rest from the index — materialize both.
  for (const f of files) {
    await fs.promises.mkdir(path.join(dir, path.dirname(f.path)), { recursive: true });
    await fs.promises.writeFile(path.join(dir, f.path), f.contents);
  }
  await ctx.addFiles(files);
});

afterAll(async () => {
  ctx.close();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

async function connectedClient(audit?: AuditLogger): Promise<Client> {
  const server = await createMCPServer(ctx, { audit });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("MCP server tools", () => {
  it("exposes the full retrieval + symbol toolset", async () => {
    const client = await connectedClient();
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    expect(tools).toEqual([
      "codebase-retrieval",
      "find-symbol-definition",
      "find-symbol-references",
      "index-status",
      "list-files",
      "read-file",
    ]);
  });

  it("find-symbol-definition returns the defining chunk", async () => {
    const client = await connectedClient();
    const res: any = await client.callTool({ name: "find-symbol-definition", arguments: { symbol: "authenticate" } });
    const text = res.content[0].text as string;
    expect(text).toContain("src/auth.ts");
    expect(text).toContain("function authenticate");
  });

  it("find-symbol-references lists usage sites", async () => {
    const client = await connectedClient();
    const res: any = await client.callTool({ name: "find-symbol-references", arguments: { symbol: "authenticate" } });
    const text = res.content[0].text as string;
    expect(text).toContain("src/main.ts");
  });

  it("index-status reports mode and chunk count", async () => {
    const client = await connectedClient();
    const res: any = await client.callTool({ name: "index-status", arguments: {} });
    const parsed = JSON.parse(res.content[0].text as string);
    expect(parsed.chunks).toBeGreaterThan(0);
    expect(["hybrid", "keyword-only"]).toContain(parsed.searchMode);
  });

  it("audits tool invocations when a logger is provided", async () => {
    const auditDir = path.join(dir, "audit-mcp");
    const client = await connectedClient(new AuditLogger({ dir: auditDir }));
    await client.callTool({ name: "list-files", arguments: {} });
    const events = readAuditEvents(auditDir, { type: "mcp" });
    expect(events).toHaveLength(1);
    expect(events[0].data.tool).toBe("list-files");
  });
});

describe("MCP over Streamable HTTP", () => {
  it("serves tools over HTTP and enforces bearer auth", async () => {
    const httpServer = await startHttpServer(() => createMCPServer(ctx), { port: 0, authToken: "sekrit" }, () => {});
    const port = (httpServer.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    try {
      // Wrong token → the transport surfaces a 401 as a connect/request error.
      const badClient = new Client({ name: "bad", version: "0.0.0" });
      await expect(
        badClient.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer wrong" } } })),
      ).rejects.toThrow();

      const client = new Client({ name: "good", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer sekrit" } } }));
      const tools = (await client.listTools()).tools.map(t => t.name);
      expect(tools).toContain("codebase-retrieval");
      const res: any = await client.callTool({ name: "read-file", arguments: { path: "src/auth.ts" } });
      expect(res.content[0].text).toContain("authenticate");
      await client.close();
    } finally {
      httpServer.close();
    }
  });

  it("answers /health without auth", async () => {
    const httpServer = await startHttpServer(() => createMCPServer(ctx), { port: 0, authToken: "sekrit" }, () => {});
    const port = (httpServer.address() as AddressInfo).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
    } finally {
      httpServer.close();
    }
  });
});
