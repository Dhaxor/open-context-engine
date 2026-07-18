import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const created: any[] = [];
vi.mock("../../../src/core/context", () => ({ OpenContext: { create: vi.fn(async (config) => { const ctx = { config, incrementalIndex: vi.fn(async () => ({ indexedFiles: 1, totalChunks: 2 })), indexWorkspace: vi.fn(async () => ({ indexedFiles: 1, totalChunks: 2 })), getStatus: () => ({ indexedFiles: 1, totalChunks: 2, provider: config.embedding.provider, model: config.embedding.model, lastSynced: "now", searchMode: "hybrid" }), getWorkspaceRoot: () => config.workspaceRoot, search: vi.fn(async () => "answer"), searchRaw: vi.fn(async () => []), searchDebug: vi.fn(async () => ({})), checkFreshness: vi.fn(async () => ({ stale: false })), listFiles: vi.fn(async () => []), close: vi.fn() }; created.push(ctx); return ctx; }) } }));
vi.mock("../../../src/core/file-watcher", () => ({ FileWatcher: class { constructor(public ctx: any, public config: any) {} start = vi.fn(async () => {}); stop = vi.fn(async () => {}); } }));
vi.mock("../../../src/core/file-filter", () => ({ FileFilter: class { constructor(public max: number) {} collectStats = vi.fn(async () => ({ includedFiles: 1 })); } }));

import { ContextService } from "./ContextService";

function extCtx() { const state = new Map<string, any>(); const secrets = new Map<string, string>(); return { globalState: { get: (k: string) => state.get(k), update: async (k: string, v: any) => v === undefined ? state.delete(k) : state.set(k, v) }, secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => secrets.set(k, v), delete: async (k: string) => secrets.delete(k) } } as any; }

beforeEach(async () => { created.length = 0; vscode.workspace._config = new Map([["embedding.provider", "local"], ["embedding.model", "all-MiniLM-L6-v2"], ["search.topK", 7]]); await ContextService.getInstance().dispose(); });

describe("ContextService", () => {
  it("builds workspace config from VS Code settings and secret storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oce-ctx-")); vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    const ec = extCtx(); await ec.secrets.store("openContext.embedding.apiKey", "secret"); ContextService.getInstance().bindExtensionContext(ec);
    const cfg = await ContextService.getInstance().getWorkspaceConfig();
    expect(cfg.workspaceRoot).toBe(root); expect(cfg.embedding.provider).toBe("local"); expect(cfg.embedding.apiKey).toBe("secret"); expect(cfg.search.topK).toBe(7);
  });
  it("persists an explicit index workspace root and resets the cached context", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oce-ctx-")); const chosen = fs.mkdtempSync(path.join(os.tmpdir(), "oce-chosen-"));
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]; const ec = extCtx(); ContextService.getInstance().bindExtensionContext(ec);
    await ContextService.getInstance().setIndexWorkspaceRoot(chosen);
    expect(ContextService.getInstance().getIndexWorkspaceRoot()).toBe(chosen);
    const ctx = await ContextService.getInstance().getContext(); expect(ctx.getWorkspaceRoot()).toBe(chosen);
  });
  it("passes IDE context into raw searches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oce-ctx-")); vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]; ContextService.getInstance().bindExtensionContext(extCtx());
    vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file(path.join(root, "src/a.ts")), getText: () => "selected" }, selection: { isEmpty: false } };
    vscode.window.visibleTextEditors = [vscode.window.activeTextEditor];
    await ContextService.getInstance().searchRaw("q");
    expect(created[0].searchRaw.mock.calls[0][2]).toMatchObject({ activePath: "src/a.ts", openPaths: ["src/a.ts"], contextText: "selected" });
  });
});
