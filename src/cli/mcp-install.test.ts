import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyInstall, parseJsonc, planInstall, serverCommand } from "./mcp-install";
import { buildProgram } from "./index";
import { createCliIo } from "./io";

let ws: string;
let home: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "oce-mcp-ws-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "oce-mcp-home-"));
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

describe("planInstall", () => {
  it("writes each client's documented file, key, and entry", () => {
    const oce = serverCommand(true);
    const cc = planInstall({ client: "claude-code", workspace: ws, home, server: oce });
    expect(cc).toMatchObject({ file: path.join(ws, ".mcp.json"), key: "mcpServers", entry: { command: "oce", args: ["mcp"] }, pinned: false });

    const cursor = planInstall({ client: "cursor", workspace: ws, home, server: oce });
    expect(cursor).toMatchObject({ file: path.join(ws, ".cursor", "mcp.json"), entry: { command: "oce", args: ["mcp", "--workspace", "${workspaceFolder}"] } });

    const vscode = planInstall({ client: "vscode", workspace: ws, home, server: oce });
    expect(vscode).toMatchObject({ file: path.join(ws, ".vscode", "mcp.json"), key: "servers", entry: { type: "stdio", command: "oce" } });

    // A global config has no "current folder": it is pinned to this project.
    const windsurf = planInstall({ client: "windsurf", workspace: ws, home, server: oce });
    expect(windsurf).toMatchObject({ file: path.join(home, ".codeium", "windsurf", "mcp_config.json"), entry: { args: ["mcp", "--workspace", ws] }, pinned: true });

    expect(planInstall({ client: "claude-desktop", workspace: ws, home, platform: "darwin", server: oce }).file)
      .toBe(path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    expect(planInstall({ client: "claude-desktop", workspace: ws, home, platform: "win32", appData: "C:/AppData", server: oce }).file)
      .toBe(path.join("C:/AppData", "Claude", "claude_desktop_config.json"));
  });

  it("starts the server with npx when oce is not installed", () => {
    const plan = planInstall({ client: "cursor", workspace: ws, home, server: serverCommand(false) });
    expect(plan.entry).toEqual({ command: "npx", args: ["-y", "@dhaxor/open-context", "mcp", "--workspace", "${workspaceFolder}"] });
  });

  it("hands user-level Claude Code and VS Code to their own CLIs", () => {
    expect(planInstall({ client: "claude-code", scope: "user", workspace: ws, home }).shell)
      .toBe("claude mcp add --scope user open-context -- oce mcp");
    expect(planInstall({ client: "vscode", scope: "user", workspace: ws, home }).shell)
      .toBe(`code --add-mcp '{"name":"open-context","type":"stdio","command":"oce","args":["mcp","--workspace","\${workspaceFolder}"]}'`);
  });

  it("rejects a scope the client does not have", () => {
    expect(() => planInstall({ client: "windsurf", scope: "project", workspace: ws, home })).toThrow(/no project-level MCP config/);
    expect(() => planInstall({ client: "zed" as any, workspace: ws, home })).toThrow(/Unknown client/);
  });
});

describe("applyInstall", () => {
  it("merges into the servers already there, and is idempotent", () => {
    const file = path.join(ws, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } }, other: true }));
    const plan = planInstall({ client: "cursor", workspace: ws, home });
    expect(applyInstall(plan).status).toBe("added");
    expect(read(file)).toEqual({ mcpServers: { github: { command: "gh-mcp" }, "open-context": plan.entry }, other: true });
    expect(applyInstall(plan).status).toBe("unchanged");
    expect(applyInstall(plan, { remove: true }).status).toBe("removed");
    expect(read(file).mcpServers).toEqual({ github: { command: "gh-mcp" } });
    expect(applyInstall(plan, { remove: true }).status).toBe("absent");
  });

  it("keeps a commented VS Code mcp.json readable, and never clobbers an unreadable one", () => {
    const file = path.join(ws, ".vscode", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{\n  // my servers\n  "servers": { "web": { "url": "https://example.com/mcp", }, },\n}\n`);
    const plan = planInstall({ client: "vscode", workspace: ws, home });
    expect(applyInstall(plan).status).toBe("added");
    expect(read(file).servers.web).toEqual({ url: "https://example.com/mcp" });

    fs.writeFileSync(file, "{ not json");
    expect(() => applyInstall(plan)).toThrow(/not valid JSON.*left it alone/s);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("parseJsonc", () => {
  it("strips comments and trailing commas outside strings only", () => {
    expect(parseJsonc(`{"a": "http://x/*y*/", /* c */ "b": [1, 2,], // d\n "c": "a,}"}`)).toEqual({ a: "http://x/*y*/", b: [1, 2], c: "a,}" });
  });
});

describe("oce mcp install", () => {
  let out = "";
  const run = (...args: string[]) => {
    const io = createCliIo({ out: s => { out += s; }, err: s => { out += s; } });
    return buildProgram(io).parseAsync(args, { from: "user" });
  };
  beforeEach(() => { out = ""; });

  it("lists the clients with no argument", async () => {
    await run("mcp", "install");
    expect(out).toContain("oce mcp install claude-code");
    expect(out).toContain("oce mcp install claude-desktop");
  });

  it("writes the project config for the workspace given to mcp", async () => {
    await run("mcp", "install", "claude-code", "-w", ws, "--npx");
    expect(read(path.join(ws, ".mcp.json"))).toEqual({ mcpServers: { "open-context": { command: "npx", args: ["-y", "@dhaxor/open-context", "mcp"] } } });
    expect(out).toContain("Added \"open-context\"");
  });

  it("previews without writing", async () => {
    await run("mcp", "install", "cursor", "-w", ws, "--print");
    expect(out).toContain("\"mcpServers\"");
    expect(fs.existsSync(path.join(ws, ".cursor"))).toBe(false);
  });
});
