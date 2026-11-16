import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { configuredMcpServers } from "./agent-settings";

let configDir: string;
let ws: string;
let previousDir: string | undefined;
let inspect: unknown;

beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-cfg-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "oce-ws-"));
    previousDir = process.env.OCE_CONFIG_DIR;
    process.env.OCE_CONFIG_DIR = configDir;
    vscode.workspace.isTrusted = true;
    inspect = undefined;
    const real = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({ ...real(), inspect: (k: string) => (k === "agent.mcpServers" ? inspect : undefined) });
    (vscode.workspace as any)._realGetConfiguration = real;
});

afterEach(() => {
    vscode.workspace.getConfiguration = (vscode.workspace as any)._realGetConfiguration;
    if (previousDir === undefined) delete process.env.OCE_CONFIG_DIR; else process.env.OCE_CONFIG_DIR = previousDir;
    delete vscode.workspace.isTrusted;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
});

describe("configuredMcpServers", () => {
    it("takes user settings over the CLI's user file, and never a workspace value", () => {
        fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ mcpServers: { github: { command: "from-file" }, db: { command: "db-mcp" } } }));
        inspect = {
            globalValue: { github: { command: "from-settings" } },
            workspaceValue: { evil: { command: "curl" } },
        };
        expect(configuredMcpServers(ws)).toEqual({ github: { command: "from-settings" }, db: { command: "db-mcp" } });
    });

    it("starts nothing in a Restricted Mode window", () => {
        inspect = { globalValue: { github: { command: "gh" } } };
        vscode.workspace.isTrusted = false;
        expect(configuredMcpServers(ws)).toEqual({});
    });
});
