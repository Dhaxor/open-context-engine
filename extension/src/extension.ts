import * as vscode from "vscode";
import * as path from "path";
import { ContextService } from "./services/ContextService";
import { ChatView } from "./chat/ChatView";
import { IndexedFilesProvider } from "./providers/IndexedFilesProvider";
import { SearchProvider } from "./providers/SearchProvider";
import { SearchResult } from "../../src/core/types";

let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const svc = ContextService.getInstance();
    svc.bindExtensionContext(context);
    const chatView = new ChatView(context.extensionUri, context);
    const treeProvider = new IndexedFilesProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatView.viewType, chatView),
    );

    const treeView = vscode.window.createTreeView("indexedFiles", {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "openContext.showStatus";
    statusBarItem.text = "$(database) Open Context";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    const refreshStatus = async () => {
        try {
            const s = await svc.getStatus();
            statusBarItem.text = `$(database) Open Context: ${s.indexedFiles} files, ${s.totalChunks} chunks`;
            treeProvider.refresh();
        } catch {}
    };
    context.subscriptions.push(svc.onReindex(refreshStatus));

    context.subscriptions.push(
        vscode.commands.registerCommand("openContext.indexWorkspace", async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: "Indexing workspace...", cancellable: true },
                async (progress, token) => {
                    try {
                        await svc.indexWorkspace((status, current, total) => {
                            progress.report({ message: total > 0 ? `${status}: ${current}/${total}` : status });
                        }, token);
                        await refreshStatus();
                        const s = await svc.getStatus();
                        vscode.window.showInformationMessage(`Indexed ${s.indexedFiles} files (${s.totalChunks} chunks)`);
                    } catch (err: any) {
                        if (err instanceof vscode.CancellationError) return;
                        vscode.window.showErrorMessage(`Indexing failed: ${err.message}`);
                    }
                },
            );
        }),

        vscode.commands.registerCommand("openContext.reindexFile", async (uri?: vscode.Uri) => {
            const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) return;
            try {
                const ctx = await svc.getContext();
                const filePath = vscode.workspace.asRelativePath(fileUri);
                const content = await vscode.workspace.fs.readFile(fileUri);
                await ctx.addFiles([{ path: filePath, contents: new TextDecoder().decode(content) }]);
                vscode.window.showInformationMessage(`Re-indexed: ${filePath}`);
                treeProvider.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Re-index failed: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand("openContext.removeFromIndex", async (item: any) => {
            if (!item?.file?.path) return;
            try {
                const ctx = await svc.getContext();
                await ctx.removeFromIndex([item.file.path]);
                vscode.window.showInformationMessage(`Removed: ${item.file.path}`);
                treeProvider.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Remove failed: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand("openContext.searchCodebase", async () => {
            const query = await vscode.window.showInputBox({ prompt: "Search codebase", placeHolder: "Describe what you are looking for..." });
            if (!query) return;
            try {
                const result = await svc.search(query);
                const doc = await vscode.workspace.openTextDocument({ content: result, language: "plaintext" });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Search failed: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand("openContext.quickSearch", async () => SearchProvider.search()),
        vscode.commands.registerCommand("openContext.openChat", () => chatView.focus()),
        vscode.commands.registerCommand("openContext.clearChat", () => chatView.clearChat()),

        vscode.commands.registerCommand("openContext.showStatus", async () => {
            try {
                const s = await svc.getStatus();
                vscode.window.showInformationMessage(`Open Context: ${s.indexedFiles} files, ${s.totalChunks} chunks | ${s.embeddingProvider}/${s.embeddingModel} | Last: ${s.lastSynced || "never"}`);
            } catch {
                vscode.window.showInformationMessage("Open Context: Not initialized yet");
            }
        }),

        vscode.commands.registerCommand("openContext.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "openContext");
        }),

        vscode.commands.registerCommand("openContext.setEmbeddingApiKey", async () => {
            const value = await vscode.window.showInputBox({ prompt: "Embedding API key (stored securely via VS Code SecretStorage)", password: true });
            if (value === undefined) return;
            await svc.setEmbeddingApiKey(value);
            await svc.dispose();
            vscode.window.showInformationMessage(value ? "Embedding API key saved." : "Embedding API key cleared.");
        }),

        vscode.commands.registerCommand("openContext.setLLMApiKey", async () => {
            const value = await vscode.window.showInputBox({ prompt: "LLM API key (stored securely via VS Code SecretStorage)", password: true });
            if (value === undefined) return;
            await svc.setLLMApiKey(value);
            vscode.window.showInformationMessage(value ? "LLM API key saved." : "LLM API key cleared.");
        }),

        vscode.commands.registerCommand("openContext.explainWithContext", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const selection = editor.document.getText(editor.selection);
            if (!selection) return;
            chatView.focus();
            setTimeout(() => chatView.addMessage("Explain this code with context from the codebase:\n\n```\n" + selection + "\n```"), 300);
        }),

        vscode.commands.registerCommand("openContext.findSimilar", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const selection = editor.document.getText(editor.selection);
            if (!selection) return;
            try {
                const ctx = await svc.getContext();
                const results = await ctx.searchRaw(selection);
                if (!results.length) { vscode.window.showInformationMessage("No similar code found."); return; }
                const wsFolder = vscode.workspace.workspaceFolders?.[0];
                const wsRoot = wsFolder?.uri.fsPath ?? "";
                const items = results.slice(0, 10).map((r: SearchResult) => ({
                    label: r.chunk.path,
                    description: `${(r.score * 100).toFixed(1)}%`,
                    detail: r.chunk.contents.split("\n").slice(0, 2).join(" ").trim(),
                    result: r,
                }));
                const picked = await vscode.window.showQuickPick(items);
                if (picked) {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(wsRoot, picked.result.chunk.path)));
                    const ed = await vscode.window.showTextDocument(doc);
                    const start = new vscode.Position(picked.result.chunk.startLine - 1, 0);
                    const end = new vscode.Position(picked.result.chunk.endLine, 0);
                    ed.selection = new vscode.Selection(start, end);
                    ed.revealRange(new vscode.Range(start, end));
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Search failed: ${err.message}`);
            }
        }),
    );

    const cfg = vscode.workspace.getConfiguration("openContext");
    if (cfg.get<boolean>("indexOnStartup", true)) {
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Indexing workspace..." }, async () => {
            try {
                await svc.indexWorkspace();
                await refreshStatus();
            } catch (err: any) {
                console.error("[openContext] startup index failed:", err);
            }
        });
    }

    if (cfg.get<boolean>("autoIndex", true)) {
        svc.startWatching().catch((err) => console.error("[openContext] watcher failed:", err));
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration("openContext")) return;
            await svc.dispose();
            svc.bindExtensionContext(context);
            if (vscode.workspace.getConfiguration("openContext").get<boolean>("autoIndex", true)) {
                svc.startWatching().catch(() => {});
            }
        }),
    );

    context.subscriptions.push({ dispose: () => svc.dispose() });
    context.subscriptions.push(treeView);
}

export function deactivate(): void {
    ContextService.getInstance().dispose().catch(() => {});
    statusBarItem?.dispose();
}
