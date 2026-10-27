import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMessageReader, encodeMessage } from "./protocol";
import { LspClient, LspError } from "./client";
import { parseCommand, commandOnPath, resolveServerCommand } from "./servers";
import { createLspFinder, disposeAllLspClients } from "./index";
import { SqliteStore } from "../sqlite-store";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";

const MOCK = path.resolve(import.meta.dirname ?? __dirname, "fixtures", "mock-lsp.mjs");

describe("protocol framing", () => {
  it("encodes Content-Length framing", () => {
    const buf = encodeMessage({ jsonrpc: "2.0", id: 1, method: "x", params: {} });
    const header = buf.slice(0, buf.indexOf("\r\n\r\n")).toString();
    expect(header).toMatch(/Content-Length: \d+/);
    const declared = Number(/Content-Length: (\d+)/.exec(header)![1]);
    expect(buf.length - buf.indexOf("\r\n\r\n") - 4).toBe(declared);
  });

  it("emits one message per frame across arbitrarily split chunks", () => {
    const got: any[] = [];
    const reader = createMessageReader(m => got.push(m));
    const a = encodeMessage({ jsonrpc: "2.0", id: 1, result: { n: 1 } });
    const b = encodeMessage({ jsonrpc: "2.0", id: 2, result: { n: 2 } });
    const both = Buffer.concat([a, b]);
    // Feed byte-by-byte to prove no frame is lost or merged.
    for (const byte of both) reader.feed(Buffer.from([byte]));
    expect(got.map(m => m.id)).toEqual([1, 2]);
    expect(got[0].result.n).toBe(1);
  });

  it("skips unframeable garbage without wedging", () => {
    const got: any[] = [];
    const reader = createMessageReader(m => got.push(m));
    reader.feed(Buffer.from("not-a-header-at-all\r\n\r\n"));
    reader.feed(encodeMessage({ jsonrpc: "2.0", id: 7, result: "ok" }));
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe(7);
  });
});

describe("LspClient against the mock server", () => {
  it("handshakes and returns definition locations", async () => {
    const client = await LspClient.start({ command: process.execPath, args: [MOCK], cwd: os.tmpdir(), rootPath: os.tmpdir(), timeoutMs: 8000 });
    try {
      const locs = await client.definition("/ws/src/app.ts", 3, 10);
      expect(locs).toHaveLength(1);
      expect(locs[0].range.start.line).toBe(11);
    } finally {
      await client.dispose();
    }
  });

  it("returns references including an outside-workspace URI (caller filters)", async () => {
    const client = await LspClient.start({ command: process.execPath, args: [MOCK], cwd: os.tmpdir(), rootPath: os.tmpdir(), timeoutMs: 8000 });
    try {
      const refs = await client.references("/ws/src/app.ts", 0, 0, true);
      expect(refs).toHaveLength(2);
      expect(refs[0].uri).toContain("/inside.ts");
      expect(refs[1].uri).toContain("outside-the-workspace");
    } finally {
      await client.dispose();
    }
  });

  it("surfaces server errors as LspError with protocol code", async () => {
    const client = await LspClient.start({ command: process.execPath, args: [MOCK, "--fail", "textDocument/definition"], cwd: os.tmpdir(), rootPath: os.tmpdir(), timeoutMs: 8000 });
    try {
      await expect(client.definition("/ws/x.ts", 0, 0)).rejects.toMatchObject({ code: "protocol" });
    } finally {
      await client.dispose();
    }
  });

  it("times out a slow server with a clear error", async () => {
    const client = await LspClient.start({ command: process.execPath, args: [MOCK, "--delay", "3000"], cwd: os.tmpdir(), rootPath: os.tmpdir(), timeoutMs: 1000 });
    try {
      await expect(client.definition("/ws/x.ts", 0, 0)).rejects.toMatchObject({ code: "timeout" });
    } finally {
      await client.dispose();
    }
  }, 15_000);

  it("rejects startup of a nonexistent command with a spawn error", async () => {
    await expect(LspClient.start({ command: "definitely-not-a-real-lsp-binary", cwd: os.tmpdir(), rootPath: os.tmpdir(), timeoutMs: 3000 }))
      .rejects.toMatchObject({ code: "spawn" });
  });
});

describe("server discovery", () => {
  it("parses multi-word env overrides", () => {
    expect(parseCommand("npx --yes tsserver --stdio")).toEqual({ command: "npx", args: ["--yes", "tsserver", "--stdio"] });
  });

  it("finds node itself on PATH", () => {
    expect(commandOnPath("node")).toBe(true);
  });

  it("returns null for an extension with no server installed", () => {
    const spec = resolveServerCommand(".zig");
    expect(spec).toBeNull();
  });

  it("honours the OCE_LSP_*_CMD override even when not on PATH", () => {
    process.env.OCE_LSP_PY_CMD = "/opt/special/pylsp --flag";
    try {
      const spec = resolveServerCommand(".py");
      expect(spec).toEqual({ command: "/opt/special/pylsp", args: ["--flag"] });
    } finally {
      delete process.env.OCE_LSP_PY_CMD;
    }
  });
});

// --- The finder, end-to-end: real store anchored to a temp workspace, mock
// server resolving through actual file paths. ---

let workspace = "";
let store: SqliteStore;
let storeDir = "";

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oce-lsp-"));
  storeDir = path.join(workspace, ".store");
  store = new SqliteStore(storeDir, 4);
  await store.initialize();
  const root = path.join(workspace, "src");
  fs.mkdirSync(root, { recursive: true });
  const contents = "export function loadConfig() {\n  return 1;\n}\n";
  fs.writeFileSync(path.join(root, "app.ts"), contents);
  fs.writeFileSync(path.join(root, "inside.ts"), "// reference target\n");
  store.addBatch([{
    id: "src/app.ts:1-3",
    path: "src/app.ts",
    startLine: 1,
    endLine: 3,
    symbolName: "loadConfig",
    contents,
    vector: [0.1, 0.2, 0.3, 0.4], // matches the store's expectedDim=4; unused by the LSP path
  }]);
});

afterEach(async () => {
  await disposeAllLspClients();
  store.close();
  // The killed child may release its CWD handle a beat after exit; Windows
  // refuses to delete a directory a process still has open. Retry briefly.
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(workspace, { recursive: true, force: true }); break; }
    catch (e) {
      if (attempt >= 8) throw e;
      await new Promise(r => setTimeout(r, 150));
    }
  }
});

function mockEnvFor(ext: string): void {
  // Node itself is on PATH; the mock is driven by pointing the override at it.
  // Quotes matter: this repo's path contains spaces, and parseCommand is
  // quote-aware for exactly that reason.
  process.env[`OCE_LSP_${ext.replace(".", "").toUpperCase()}_CMD`] = `"${process.execPath}" "${MOCK}"`;
}

describe("createLspFinder", () => {
  it("maps LSP definition results to workspace-relative paths", async () => {
    mockEnvFor(".ts");
    const finder = createLspFinder(workspace, store);
    const hits = await finder.definition("loadConfig");
    expect(hits).not.toBeNull();
    expect(hits![0].path).toBe("src/app.ts");
    expect(hits![0].startLine).toBe(12); // mock's line 11 (0-based) + 1
  });

  it("filters outside-workspace reference URIs and converts to 1-based lines", async () => {
    mockEnvFor(".ts");
    const finder = createLspFinder(workspace, store);
    const refs = await finder.references("loadConfig");
    expect(refs).not.toBeNull();
    expect(refs).toHaveLength(1); // the /outside URI is dropped
    expect(refs![0].path).toBe("src/inside.ts"); // mock derives the URI from the requested doc.s directory
    expect(refs![0].startLine).toBe(5);
  });

  it("returns null (not an error) when no server is configured for the language", async () => {
    delete process.env.OCE_LSP_TS_CMD;
    const finder = createLspFinder(workspace, store);
    expect(await finder.definition("loadConfig")).toBeNull();
  });

  it("returns null for symbols the index cannot anchor", async () => {
    mockEnvFor(".ts");
    const finder = createLspFinder(workspace, store);
    expect(await finder.definition("neverIndexedSymbol")).toBeNull();
  });

  it("survives a server that errors mid-session (graceful null)", async () => {
    process.env.OCE_LSP_TS_CMD = `${process.execPath} ${MOCK} --fail textDocument/definition`;
    const finder = createLspFinder(workspace, store);
    expect(await finder.definition("loadConfig")).toBeNull();
  });
});
