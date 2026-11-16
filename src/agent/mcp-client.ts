/**
 * The agent's own MCP client: the tools of the MCP servers you already use
 * (GitHub, Linear, a database, a browser…) offered to the agent beside its
 * codebase tools — what Claude Code, Cursor, and Cline all do.
 *
 * Servers are configured the way every other client configures them
 * (`mcpServers`: command/args/env for stdio, url/headers for HTTP), and only
 * from user-level settings: a server is a program the agent starts, and a
 * cloned repository must not be able to start programs by shipping a config.
 *
 * Safety: a tool the server marks read-only (`readOnlyHint`) runs freely; any
 * other asks in every approval mode — full-auto included — until you answer
 * "always" or list it in the server's `autoApprove`. full-auto was chosen for
 * edits and the shell; it is not consent to whatever a third-party tool does.
 */

import * as crypto from "crypto";
import * as os from "os";
import type { ToolDefinition } from "./types";

export interface McpServerConfig {
  /** stdio: the program to start. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP: a Streamable HTTP endpoint (falls back to SSE). */
  url?: string;
  headers?: Record<string, string>;
  /** Tools that never ask — names, or true for all of this server's tools. */
  autoApprove?: boolean | string[];
  disabled?: boolean;
}

export interface McpServerStatus {
  name: string;
  state: "connected" | "failed" | "disabled" | "skipped";
  tools: number;
  error?: string;
  transport?: "stdio" | "http" | "sse";
}

export interface McpHubOptions {
  workspaceRoot: string;
  clientName?: string;
  clientVersion?: string;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** A server's stderr and connection notes (stderr is drained, never inherited). */
  onLog?: (server: string, line: string) => void;
}

interface Connected {
  close: () => Promise<void>;
}

const PREFIX = "mcp__";
const NAME_MAX = 64;

/** `mcp__<server>__<tool>`, in the character set every provider accepts. */
export function mcpToolName(server: string, tool: string, taken: Set<string> = new Set()): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  let name = `${PREFIX}${slug(server)}__${slug(tool)}`;
  if (name.length > NAME_MAX || taken.has(name)) {
    const hash = crypto.createHash("sha1").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
    name = `${name.slice(0, NAME_MAX - 9)}_${hash}`;
  }
  return name;
}

/** "github · create_issue" for an mcp__ tool name the hub made, else null. */
export function describeMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const split = rest.indexOf("__");
  return split > 0 ? { server: rest.slice(0, split), tool: rest.slice(split + 2) } : null;
}

/** `${env:NAME}`, `${workspaceFolder}`, `${userHome}` — the variables other clients expand. */
export function expandVars(value: string, workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return value
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => env[name] ?? "")
    .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
    .replace(/\$\{userHome\}/g, os.homedir());
}

/** This is Open Context's own server — connecting the agent to itself would
 *  start a second index of the same workspace for tools it already has. */
export function isSelf(cfg: McpServerConfig): boolean {
  const all = [cfg.command ?? "", ...(cfg.args ?? [])].join(" ");
  if (/@dhaxor\/open-context\b/.test(all)) return true;
  // Either separator: a config written on Windows is read anywhere.
  const bin = (cfg.command ?? "").split(/[\\/]/).pop()!.replace(/\.(cmd|exe)$/i, "");
  return bin === "oce" && (cfg.args ?? [])[0] === "mcp";
}

export class McpToolHub {
  private connections = new Map<string, Connected>();
  private toolDefs: ToolDefinition[] = [];
  private asking: string[] = [];
  private statuses: McpServerStatus[] = [];

  private constructor(private readonly opts: McpHubOptions) {}

  /** Connect every enabled server (in parallel, each with a timeout). A server
   *  that fails is reported in status(), never thrown: one broken server must
   *  not take the agent down. */
  static async connect(servers: Record<string, McpServerConfig>, opts: McpHubOptions): Promise<McpToolHub> {
    const hub = new McpToolHub(opts);
    const taken = new Set<string>();
    const results = await Promise.all(Object.entries(servers).map(([name, cfg]) => hub.connectOne(name, cfg)));
    // Tool order is the config's server order, so names are stable across runs.
    for (const r of results) {
      hub.statuses.push(r.status);
      for (const t of r.tools) {
        const def = r.toDefinition(t, mcpToolName(r.status.name, t.name, taken));
        taken.add(def.name);
        hub.toolDefs.push(def);
        if (def.mutates && !r.trusted(t.name)) hub.asking.push(def.name);
      }
    }
    return hub;
  }

  tools(): ToolDefinition[] { return [...this.toolDefs]; }
  /** Tool names that ask in every approval mode. */
  alwaysAsk(): string[] { return [...this.asking]; }
  status(): McpServerStatus[] { return this.statuses.map(s => ({ ...s })); }

  async close(): Promise<void> {
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map(c => c.close().catch(() => {})));
  }

  private async connectOne(name: string, raw: McpServerConfig): Promise<{
    status: McpServerStatus;
    tools: McpTool[];
    toDefinition: (t: McpTool, toolName: string) => ToolDefinition;
    trusted: (tool: string) => boolean;
  }> {
    const empty = { tools: [] as McpTool[], toDefinition: () => { throw new Error("unreachable"); }, trusted: () => false };
    if (raw.disabled) return { ...empty, status: { name, state: "disabled", tools: 0 } };
    if (isSelf(raw)) return { ...empty, status: { name, state: "skipped", tools: 0, error: "this is Open Context's own server — its tools are already built in" } };
    if (!raw.command && !raw.url) return { ...empty, status: { name, state: "failed", tools: 0, error: "needs a command (stdio) or a url (HTTP)" } };

    const ws = this.opts.workspaceRoot;
    const x = (s: string) => expandVars(s, ws);
    const cfg: McpServerConfig = {
      ...raw,
      ...(raw.command ? { command: x(raw.command) } : {}),
      ...(raw.args ? { args: raw.args.map(x) } : {}),
      ...(raw.env ? { env: Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, x(String(v))])) } : {}),
      ...(raw.cwd ? { cwd: x(raw.cwd) } : {}),
      ...(raw.url ? { url: x(raw.url) } : {}),
      ...(raw.headers ? { headers: Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, x(String(v))])) } : {}),
    };

    let closeTransport: () => Promise<void> = async () => {};
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const client = new Client({ name: this.opts.clientName ?? "open-context-agent", version: this.opts.clientVersion ?? "0.0.0" });
      let transport: "stdio" | "http" | "sse";
      const timeout = this.opts.connectTimeoutMs ?? 20_000;
      if (cfg.command) {
        const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
        const t = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
          cwd: cfg.cwd ?? ws,
          stderr: "pipe",
        });
        t.stderr?.on("data", (d: Buffer) => {
          for (const line of String(d).split("\n")) if (line.trim()) this.opts.onLog?.(name, line);
        });
        closeTransport = () => t.close();
        await withTimeout(client.connect(t), timeout, `did not start within ${timeout / 1000}s`);
        transport = "stdio";
      } else {
        const url = new URL(cfg.url!);
        const requestInit = cfg.headers ? { headers: cfg.headers } : undefined;
        try {
          const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
          const t = new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : {});
          closeTransport = () => t.close();
          await withTimeout(client.connect(t), timeout, `did not answer within ${timeout / 1000}s`);
          transport = "http";
        } catch (err) {
          // Older servers speak SSE only.
          await closeTransport().catch(() => {});
          const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
          const t = new SSEClientTransport(url, requestInit ? { requestInit } : {});
          closeTransport = () => t.close();
          try {
            await withTimeout(client.connect(t), timeout, `did not answer within ${timeout / 1000}s`);
          } catch {
            throw err;
          }
          transport = "sse";
        }
      }

      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), timeout, "did not list its tools in time");
        tools.push(...(page.tools as McpTool[]));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);

      this.connections.set(name, { close: () => client.close().catch(() => closeTransport()) });
      const callTimeout = this.opts.callTimeoutMs ?? 120_000;
      const trusted = (tool: string) => raw.autoApprove === true || (Array.isArray(raw.autoApprove) && raw.autoApprove.includes(tool));
      return {
        status: { name, state: "connected", tools: tools.length, transport },
        tools,
        trusted,
        toDefinition: (t, toolName) => ({
          name: toolName,
          description: `[MCP: ${name}] ${(t.description ?? t.title ?? t.name).trim()}`.slice(0, 1024),
          parameters: toParameters(t.inputSchema),
          mutates: t.annotations?.readOnlyHint !== true,
          handler: async (args, signal) => {
            const res: any = await client.callTool({ name: t.name, arguments: args ?? {} }, undefined, { ...(signal ? { signal } : {}), timeout: callTimeout });
            const text = renderToolResult(res);
            if (res?.isError) throw new Error(text || `${t.name} reported an error`);
            return text || "(no output)";
          },
        }),
      };
    } catch (err: any) {
      await closeTransport().catch(() => {});
      const error = String(err?.message ?? err).split("\n")[0].slice(0, 300);
      this.opts.onLog?.(name, `failed: ${error}`);
      return { ...empty, status: { name, state: "failed", tools: 0, error } };
    }
  }
}

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, any>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

/** A tool's input schema as every provider accepts it: an object schema with
 *  properties, without the `$schema` header some providers reject. */
export function toParameters(schema: Record<string, any> | undefined): Record<string, any> {
  const { $schema: _drop, ...rest } = schema && typeof schema === "object" ? schema : {};
  return { ...rest, type: "object", properties: rest.properties && typeof rest.properties === "object" ? rest.properties : {} };
}

/** An MCP tool result as text for the model. */
export function renderToolResult(res: any): string {
  const parts: string[] = [];
  for (const c of Array.isArray(res?.content) ? res.content : []) {
    if (c?.type === "text") parts.push(String(c.text ?? ""));
    else if (c?.type === "image") parts.push(`[image: ${c.mimeType ?? "unknown type"}]`);
    else if (c?.type === "audio") parts.push(`[audio: ${c.mimeType ?? "unknown type"}]`);
    else if (c?.type === "resource") parts.push(c.resource?.text !== undefined ? String(c.resource.text) : `[resource: ${c.resource?.uri ?? "?"}]`);
    else if (c?.type === "resource_link") parts.push(`[link: ${c.uri ?? "?"}${c.name ? ` (${c.name})` : ""}]`);
  }
  if (!parts.length && res?.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent, null, 2));
  if (!parts.length && res?.toolResult !== undefined) parts.push(typeof res.toolResult === "string" ? res.toolResult : JSON.stringify(res.toolResult));
  return parts.join("\n\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}
