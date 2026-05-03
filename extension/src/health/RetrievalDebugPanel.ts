import * as vscode from "vscode";
import { RetrievalDebugItem, RetrievalDebugReport } from "../../../src/core/retriever";
import { ContextService } from "../services/ContextService";

export class RetrievalDebugPanel {
    static async show(): Promise<void> {
        const query = await vscode.window.showInputBox({
            title: "Debug Open Context retrieval",
            prompt: "Enter a query to inspect vector/BM25/ranking/expansion stages",
            placeHolder: "Where is indexing implemented?",
        });
        if (!query) return;
        const report = await ContextService.getInstance().searchDebug(query, 8);
        const panel = vscode.window.createWebviewPanel(
            "openContext.retrievalDebug",
            "Open Context: Retrieval Debug",
            vscode.ViewColumn.Beside,
            { enableCommandUris: true },
        );
        panel.webview.html = render(report);
    }
}

function render(r: RetrievalDebugReport): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css()}</style></head><body>
      <header><h1>Retrieval Debug</h1><div class="query">${esc(r.query)}</div></header>
      <section><h2>Query Signals</h2><div>${r.signals.map(s => `<span class="tag">${esc(s)}</span>`).join("") || "none"}</div></section>
      ${section("Editor Context", `<table>${row("Active file", esc(r.editorContext?.activePath || "none"))}${row("Visible files", (r.editorContext?.openPaths ?? []).map(esc).join("<br>") || "none")}${row("Selection signals", (r.editorContext?.contextSignals ?? []).map(esc).join(", ") || "none")}</table>`)}
      ${stage("Vector Hits", r.vectorHits)}
      ${stage("BM25 Hits", r.bm25Hits)}
      ${stage("Fused + Symbol Boosted", r.fused)}
      ${stage("Ranked / Reranked", r.ranked)}
      ${stage("Expanded Context", r.expanded)}
      ${stage("Final Results Sent to Model", r.final)}
      ${packing(r)}
    </body></html>`;
}

function packing(r: RetrievalDebugReport): string {
    if (!r.packing) return "";
    const rows = r.packing.decisions.slice(0, 80).map(d => `<tr><td>${esc(d.action)}</td><td>${esc(d.path)}:${esc(d.lines)}</td><td>${esc(d.reason)}</td><td>${d.chars}</td></tr>`).join("");
    return section("Context Packing", `<table>${row("Included", `${r.packing.includedFiles} files / ${r.packing.includedChunks} chunks`)}` +
        `${row("Dropped", String(r.packing.droppedChunks))}${row("Packed chars", String(r.packing.totalChars))}</table>` +
        `<h3>Packed preview</h3><pre>${esc(r.packing.preview)}</pre>` +
        `<h3>Decisions</h3><table><thead><tr><th>Action</th><th>Location</th><th>Reason</th><th>Chars</th></tr></thead><tbody>${rows || `<tr><td colspan="4">No decisions</td></tr>`}</tbody></table>`);
}

function stage(title: string, items: RetrievalDebugItem[]): string {
    const rows = items.map(i => `<tr>
      <td>${i.rank}</td><td><a href="${openHref(i.path, Number(i.lines.split("-")[0]))}">${esc(i.path)}:${esc(i.lines)}</a></td><td>${esc(i.symbolName || "")}</td>
      <td>${i.score}</td><td>${scoreBits(i)}</td><td>${esc(i.reason || "")}</td><td>${esc(i.preview)}</td>
    </tr>`).join("") || `<tr><td colspan="7">No results</td></tr>`;
    return `<section><h2>${esc(title)}</h2><table><thead><tr><th>#</th><th>Location</th><th>Symbol</th><th>Score</th><th>Components</th><th>Reason</th><th>Preview</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function section(title: string, body: string): string { return `<section><h2>${esc(title)}</h2>${body}</section>`; }
function row(k: string, v: string): string { return `<tr><th>${esc(k)}</th><td>${v}</td></tr>`; }
function scoreBits(i: RetrievalDebugItem): string { return [`vec ${num(i.vectorScore)}`, `bm25 ${num(i.bm25Score)}`, `rerank ${num(i.rerankScore)}`].filter(x => !x.endsWith("—")).join("<br>") || "—"; }
function num(v: number | undefined): string { return v == null ? "—" : Number(v).toFixed(4); }
function openHref(path: string, line: number): string { return `command:openContext.openIndexedFile?${encodeURIComponent(JSON.stringify([path, line]))}`; }
function esc(s: unknown): string { return String(s).replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]!)); }
function css(): string { return `
body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);padding:20px;line-height:1.45}
header{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}h1{margin:0}.query{padding:6px 10px;border:1px solid var(--vscode-panel-border);border-radius:6px;color:var(--vscode-descriptionForeground)}
section{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:14px;margin:14px 0;background:rgba(128,128,128,.06)}h2{margin:0 0 10px;font-size:16px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;vertical-align:top;border-top:1px solid var(--vscode-panel-border);padding:6px}th{color:var(--vscode-descriptionForeground)}td:nth-child(2){min-width:190px}.tag{display:inline-block;border:1px solid var(--vscode-panel-border);border-radius:999px;padding:2px 8px;margin:2px;color:var(--vscode-textLink-foreground)}pre{white-space:pre-wrap;background:rgba(0,0,0,.2);border-radius:6px;padding:10px;max-height:360px;overflow:auto}
`; }
