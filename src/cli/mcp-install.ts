/**
 * `oce mcp install <client>` — add Open Context to an MCP client's config.
 *
 * Every client keeps its MCP servers in a JSON file of its own shape and
 * location, and getting one detail wrong (the key, the path, a missing
 * workspace) fails silently: the client just shows no tools. This writes the
 * entry each client documents, merged into whatever servers are already
 * there, and refuses to touch a file it cannot parse.
 *
 * Pure planning (planInstall) is separate from writing (applyInstall), so the
 * CLI, the VS Code extension, and the tests share one source of truth.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type McpClient = "claude-code" | "cursor" | "windsurf" | "vscode" | "claude-desktop";
export type McpScope = "project" | "user";

export interface McpClientSpec {
  id: McpClient;
  label: string;
  scopes: McpScope[];
  defaultScope: McpScope;
}

export const MCP_CLIENTS: McpClientSpec[] = [
  { id: "claude-code", label: "Claude Code", scopes: ["project", "user"], defaultScope: "project" },
  { id: "cursor", label: "Cursor", scopes: ["project", "user"], defaultScope: "project" },
  { id: "vscode", label: "VS Code (Copilot agent mode)", scopes: ["project", "user"], defaultScope: "project" },
  { id: "windsurf", label: "Windsurf", scopes: ["user"], defaultScope: "user" },
  { id: "claude-desktop", label: "Claude Desktop", scopes: ["user"], defaultScope: "user" },
];

export const DEFAULT_SERVER_NAME = "open-context";
export const NPM_PACKAGE = "@dhaxor/open-context";

/** How the client starts the server: `oce` when it is installed, else npx. */
export interface ServerCommand { command: string; args: string[] }

export function serverCommand(onPath: boolean): ServerCommand {
  return onPath ? { command: "oce", args: [] } : { command: "npx", args: ["-y", NPM_PACKAGE] };
}

/** Whether an executable is on PATH (no shell, no spawning). */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, name + ext.toLowerCase());
        if (fs.statSync(candidate).isFile()) return true;
      } catch {}
      if (ext) {
        try { if (fs.statSync(path.join(dir, name + ext)).isFile()) return true; } catch {}
      }
    }
  }
  return false;
}

export interface InstallInput {
  client: McpClient;
  scope?: McpScope;
  /** The project to index. Absolute. */
  workspace: string;
  name?: string;
  server?: ServerCommand;
  /** Overrides for tests. */
  home?: string;
  platform?: NodeJS.Platform;
  appData?: string;
}

export interface InstallPlan {
  client: McpClient;
  label: string;
  scope: McpScope;
  name: string;
  /** The config file to merge into, or — for a client managed through its own
   *  CLI — undefined, with `shell` set instead. */
  file?: string;
  /** The key the client keeps its servers under. */
  key: "mcpServers" | "servers";
  entry: Record<string, unknown>;
  /** A command that registers the server (Claude Code user scope, VS Code user). */
  shell?: string;
  /** Pinned to one project (a global config has no "current folder"). */
  pinned: boolean;
}

export function clientSpec(id: string): McpClientSpec | undefined {
  return MCP_CLIENTS.find(c => c.id === id);
}

export function planInstall(input: InstallInput): InstallPlan {
  const spec = clientSpec(input.client);
  if (!spec) throw new Error(`Unknown client "${input.client}". Use one of: ${MCP_CLIENTS.map(c => c.id).join(", ")}.`);
  const scope = input.scope ?? spec.defaultScope;
  if (!spec.scopes.includes(scope)) throw new Error(`${spec.label} has no ${scope}-level MCP config — use --scope ${spec.scopes.join(" or ")}.`);
  const name = input.name ?? DEFAULT_SERVER_NAME;
  const server = input.server ?? serverCommand(true);
  const home = input.home ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const ws = path.resolve(input.workspace);
  const args = (...rest: string[]) => [...server.args, "mcp", ...rest];
  const stdio = (extra: string[]) => ({ command: server.command, args: args(...extra) });
  const base = { client: spec.id, label: spec.label, scope, name };

  switch (spec.id) {
    case "claude-code":
      // Claude Code starts a server in the folder it was opened in, so no
      // workspace is pinned: one install serves every project.
      if (scope === "project") {
        return { ...base, file: path.join(ws, ".mcp.json"), key: "mcpServers", entry: stdio([]), pinned: false };
      }
      return {
        ...base, key: "mcpServers", entry: stdio([]), pinned: false,
        shell: `claude mcp add --scope user ${name} -- ${[server.command, ...args()].map(shellQuote).join(" ")}`,
      };
    case "cursor":
      return scope === "project"
        ? { ...base, file: path.join(ws, ".cursor", "mcp.json"), key: "mcpServers", entry: stdio(["--workspace", "${workspaceFolder}"]), pinned: false }
        : { ...base, file: path.join(home, ".cursor", "mcp.json"), key: "mcpServers", entry: stdio(["--workspace", ws]), pinned: true };
    case "vscode": {
      const entry = { type: "stdio", ...stdio(["--workspace", "${workspaceFolder}"]) };
      if (scope === "project") return { ...base, file: path.join(ws, ".vscode", "mcp.json"), key: "servers", entry, pinned: false };
      // The user-level file lives in the profile; `code --add-mcp` finds it.
      return { ...base, key: "servers", entry, pinned: false, shell: `code --add-mcp ${shellQuote(JSON.stringify({ name, ...entry }))}` };
    }
    case "windsurf":
      return { ...base, file: path.join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", entry: stdio(["--workspace", ws]), pinned: true };
    case "claude-desktop":
      return { ...base, file: claudeDesktopConfig(home, platform, input.appData), key: "mcpServers", entry: stdio(["--workspace", ws]), pinned: true };
  }
}

function claudeDesktopConfig(home: string, platform: NodeJS.Platform, appData?: string): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(appData ?? process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

export type InstallStatus = "added" | "updated" | "unchanged" | "removed" | "absent";

/** Merge the plan's entry into its file (or take it out, with `remove`). */
export function applyInstall(plan: InstallPlan, opts: { remove?: boolean } = {}): { status: InstallStatus; file: string } {
  if (!plan.file) throw new Error(`${plan.label} ${plan.scope}-level servers are registered with a command: ${plan.shell}`);
  const file = plan.file;
  let config: Record<string, any> = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    try {
      config = text.trim() ? parseJsonc(text) : {};
    } catch (err: any) {
      throw new Error(`${file} is not valid JSON (${err?.message ?? err}) — left it alone. Add this under "${plan.key}" yourself:\n${snippet(plan)}`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`${file} does not hold a JSON object — left it alone.`);
    }
  }
  const servers: Record<string, unknown> = config[plan.key] && typeof config[plan.key] === "object" ? config[plan.key] : {};
  const existing = servers[plan.name];
  let status: InstallStatus;
  if (opts.remove) {
    if (existing === undefined) return { status: "absent", file };
    delete servers[plan.name];
    status = "removed";
  } else {
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(plan.entry)) return { status: "unchanged", file };
    status = existing === undefined ? "added" : "updated";
    servers[plan.name] = plan.entry;
  }
  config[plan.key] = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return { status, file };
}

/** The entry as the client's docs show it, for printing or pasting. */
export function snippet(plan: InstallPlan): string {
  return JSON.stringify({ [plan.key]: { [plan.name]: plan.entry } }, null, 2);
}

/**
 * JSON with comments and trailing commas — VS Code's own config dialect, which
 * `.vscode/mcp.json` files are written in. Comments are stripped outside of
 * strings only, so a URL in a value survives.
 */
export function parseJsonc(text: string): any {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
      if (ch === "\"") inString = false;
      i++;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; i++; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
