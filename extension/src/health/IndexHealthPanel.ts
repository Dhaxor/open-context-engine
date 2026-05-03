import * as vscode from "vscode";
import { ContextService, IndexHealthReport } from "../services/ContextService";

export class IndexHealthPanel {
    static async show(): Promise<void> {
        const panel = vscode.window.createWebviewPanel(
            "openContext.indexHealth",
            "Open Context: Index Health",
            vscode.ViewColumn.Beside,
            { enableCommandUris: true },
        );
        panel.webview.html = render(await ContextService.getInstance().getIndexHealthReport());
    }
}

function render(r: IndexHealthReport): string {
    const status = r.contextReady && !r.lastIndexError ? "ok" : "warn";
    const notes = r.notes.length ? r.notes.map(n => `<li>${esc(n)}</li>`).join("") : "<li>No obvious issues detected.</li>";
    const skipped = Object.entries(r.fileScan?.skippedByReason ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `<tr><td>${esc(reason)}</td><td>${count}</td><td>${examples(r.fileScan?.examplesByReason[reason])}</td></tr>`)
        .join("") || `<tr><td colspan="3">No skipped-file stats available.</td></tr>`;
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css()}</style></head><body>
        <header><h1>Index Health / Debug</h1><span class="pill ${status}">${status === "ok" ? "Ready" : "Needs attention"}</span></header>
        <div class="actions">
          <a href="command:openContext.selectIndexWorkspace">Select Index Workspace</a>
          <a href="command:openContext.indexWorkspace">Re-index Current Workspace</a>
          <a href="command:openContext.debugRetrieval">Debug Retrieval</a>
          <a href="command:openContext.setEmbeddingApiKey">Set Embedding API Key</a>
          <a href="command:openContext.openSettings">Open Settings</a>
        </div>
        ${section("Workspace", rows([
            ["Indexed workspace", r.workspaceRoot || "(none)"],
            ["Explicitly selected", r.selectedWorkspaceRoot || "(not set; using first VS Code workspace)"],
            ["First VS Code workspace", r.vscodeWorkspaceRoot || "(none)"],
            ["Generated", r.generatedAt],
        ]))}
        ${section("Embedding", rows([
            ["Provider", r.embedding.provider], ["Model", r.embedding.model], ["API key required", yn(r.embedding.apiKeyRequired)],
            ["API key present", yn(r.embedding.apiKeyPresent)], ["Dimension", String(r.embedding.dimension)], ["Batch size", String(r.embedding.batchSize)],
        ]))}
        ${section("Index Store", rows([
            ["Store directory", r.index.storeDir || "(none)"], ["Database", r.index.dbPath || "(none)"],
            ["Store exists", yn(r.index.storeExists)], ["DB exists", yn(r.index.dbExists)],
            ["DB size", r.index.dbSizeBytes == null ? "(unknown)" : formatBytes(r.index.dbSizeBytes)],
            ["Indexed files", val(r.index.indexedFiles)], ["Chunks", val(r.index.totalChunks)],
            ["Potentially stale", r.index.potentiallyStale == null ? "unknown" : yn(r.index.potentiallyStale)],
        ]))}
        ${section("Freshness", rows([
            ["State", r.freshness?.state ?? "unknown"], ["Reasons", list(r.freshness?.reasons)],
            ["Added files", list(r.freshness?.added)], ["Changed files", list(r.freshness?.changed)], ["Removed files", list(r.freshness?.removed)],
            ["Active file", esc(r.activeFile?.path || "none")], ["Active file indexed", r.activeFile ? yn(r.activeFile.indexed) : "unknown"],
        ]))}
        ${section("Current File Scan", rows([
            ["Scanned files", val(r.fileScan?.scannedFiles)], ["Includable files", val(r.fileScan?.includedFiles)],
            ["Skipped files", val(r.fileScan?.skippedFiles)], ["Unreadable examples", (r.fileScan?.unreadableFiles ?? []).map(esc).join("<br>") || "none"],
        ]))}
        <section><h2>Skipped Files by Reason</h2><table><thead><tr><th>Reason</th><th>Count</th><th>Examples</th></tr></thead><tbody>${skipped}</tbody></table></section>
        ${section("Errors & Notes", `<ul>${notes}</ul>${r.initializationError ? pre("Initialization error", r.initializationError) : ""}${r.lastIndexError ? pre("Last index error", r.lastIndexError) : ""}`)}
    </body></html>`;
}

function section(title: string, body: string): string { return `<section><h2>${esc(title)}</h2>${body}</section>`; }
function rows(items: [string, string][]): string { return `<table>${items.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table>`; }
function examples(items?: string[]): string { return items?.length ? items.map(esc).join("<br>") : ""; }
function list(items?: string[]): string { return items?.length ? items.map(esc).join("<br>") : "none"; }
function pre(title: string, text: string): string { return `<h3>${esc(title)}</h3><pre>${esc(text)}</pre>`; }
function val(v: number | undefined): string { return v == null ? "unknown" : String(v); }
function yn(v: boolean): string { return v ? "yes" : "no"; }
function esc(s: unknown): string { return String(s).replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]!)); }
function formatBytes(n: number): string { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
function css(): string { return `
body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);padding:20px;line-height:1.45}
header{display:flex;align-items:center;gap:12px}h1{margin:0 0 8px}section{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:14px;margin:14px 0;background:rgba(128,128,128,.06)}
h2{margin:0 0 10px;font-size:16px}h3{font-size:13px;margin:14px 0 6px}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-top:1px solid var(--vscode-panel-border);padding:7px 8px}th{width:210px;color:var(--vscode-descriptionForeground);font-weight:600}.pill{border-radius:999px;padding:3px 10px;font-size:12px}.ok{background:rgba(16,185,129,.2);color:#34d399}.warn{background:rgba(245,158,11,.2);color:#fbbf24}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 16px}.actions a{border:1px solid var(--vscode-panel-border);border-radius:5px;padding:5px 9px;color:var(--vscode-textLink-foreground);text-decoration:none}pre{white-space:pre-wrap;background:rgba(0,0,0,.2);padding:10px;border-radius:6px;overflow:auto}
`; }
