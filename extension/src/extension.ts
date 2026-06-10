import * as vscode from "vscode";
import * as path from "path";
import { ContextService } from "./services/ContextService";
import { ChatView } from "./chat/ChatView";
import { IndexedFilesProvider } from "./providers/IndexedFilesProvider";
import { SearchProvider } from "./providers/SearchProvider";
import { IndexHealthPanel } from "./health/IndexHealthPanel";
import { RetrievalDebugPanel } from "./health/RetrievalDebugPanel";
import { EditReviewService } from "./services/EditReviewService";
import { SearchResult } from "../../src/core/types";
import { classifyNativeBindingError } from "../../src/core/native-binding-error";

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel | undefined;

/** Show the user a real, actionable error for any failure that initializes the
 *  native SQLite binding (NMV mismatch, glibc skew, wrong arch, etc.). Until
 *  v0.1.1 the startup-index catch site swallowed these with a console.error
 *  the user could never see, which is why "indexing silently failed" was the
 *  first-run experience for paying customers on mismatched VS Code builds. */
function reportIndexingError(err: unknown): void {
  const diag = classifyNativeBindingError(err);
  outputChannel?.appendLine("");
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${diag.title}`);
  outputChannel?.appendLine(diag.raw);
  if (!diag.recognized) {
    vscode.window.showErrorMessage(`Open Context Engine: indexing failed — ${diag.title}`, "Open Output").then((pick) => {
      if (pick === "Open Output") outputChannel?.show(true);
    });
    return;
  }
  vscode.window.showErrorMessage(diag.title + " — " + diag.message, "Open Output", "Open Releases").then((pick) => {
    if (pick === "Open Output") outputChannel?.show(true);
    else if (pick === "Open Releases") vscode.env.openExternal(vscode.Uri.parse("https://github.com/Dhaxor/open-context-engine/releases"));
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel("Open Context Engine");
    context.subscriptions.push(outputChannel);
    const svc = ContextService.getInstance();
    svc.bindExtensionContext(context);
    const reviewService = new EditReviewService(async () => (await svc.getContext()).getWorkspaceRoot());
    context.subscriptions.push(reviewService);
    const chatView = new ChatView(context.extensionUri, context, reviewService);
    const treeProvider = new IndexedFilesProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatView.viewType, chatView, {
            // Keep the chat DOM (and any in-progress stream) alive when the panel is
            // hidden or moved, instead of tearing it down and losing the conversation.
            webviewOptions: { retainContextWhenHidden: true },
        }),
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
            const rootName = path.basename(s.workspaceRoot) || s.workspaceRoot;
            statusBarItem.text = `$(database) Open Context: ${rootName} · ${s.indexedFiles} files`;
            statusBarItem.tooltip = `Open Context index: ${s.workspaceRoot}\n${s.totalChunks} chunks`;
            treeProvider.refresh();
        } catch {}
    };
    context.subscriptions.push(svc.onReindex(refreshStatus));

    const restartWatching = async () => {
        if (vscode.workspace.getConfiguration("openContext").get<boolean>("autoIndex", true)) {
            await svc.startWatching().catch((err) => console.error("[openContext] watcher failed:", err));
        }
    };

    const runIndex = async (label: string, op: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<void>) => {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: label, cancellable: true },
            async (progress, token) => {
                try {
                    await op(progress, token);
                    await refreshStatus();
                    const s = await svc.getStatus();
                    vscode.window.showInformationMessage(`Indexed ${path.basename(s.workspaceRoot)}: ${s.indexedFiles} files (${s.totalChunks} chunks)`);
                } catch (err: any) {
                    if (err instanceof vscode.CancellationError) return;
                    vscode.window.showErrorMessage(`Indexing failed: ${err.message}`);
                }
            },
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("openContext.indexWorkspace", async () => {
            await runIndex("Indexing workspace...", async (progress, token) => {
                await svc.indexWorkspace((status, current, total) => {
                    progress.report({ message: total > 0 ? `${status}: ${current}/${total}` : status });
                }, token);
            });
        }),

        vscode.commands.registerCommand("openContext.selectIndexWorkspace", async () => {
            const current = svc.getIndexWorkspaceRoot();
            const picked = await vscode.window.showOpenDialog({
                title: "Select folder to index",
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: "Index Folder",
                defaultUri: current ? vscode.Uri.file(current) : undefined,
            });
            const dir = picked?.[0]?.fsPath;
            if (!dir) return;
            await runIndex(`Indexing ${path.basename(dir)}...`, async (progress, token) => {
                await svc.indexDirectory(dir, (status, current, total) => {
                    progress.report({ message: total > 0 ? `${status}: ${current}/${total}` : status });
                }, token);
            });
            await restartWatching();
            chatView.refreshConfig();
        }),

        vscode.commands.registerCommand("openContext.reindexFile", async (uri?: vscode.Uri) => {
            const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) return;
            try {
                const ctx = await svc.getContext();
                const root = ctx.getWorkspaceRoot();
                const filePath = path.relative(root, fileUri.fsPath);
                if (!filePath || filePath.startsWith("..") || path.isAbsolute(filePath)) {
                    throw new Error(`Current file is not under the indexed workspace: ${root}`);
                }
                const content = await vscode.workspace.fs.readFile(fileUri);
                await ctx.addFiles([{ path: filePath, contents: new TextDecoder().decode(content) }]);
                vscode.window.showInformationMessage(`Re-indexed: ${filePath}`);
                treeProvider.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Re-index failed: ${err.message}`);
            }
        }),

        vscode.commands.registerCommand("openContext.removeFromIndex", async (item: any) => {
            const indexedPath = item?.file?.path ?? item?.path;
            if (!indexedPath) return;
            try {
                const ctx = await svc.getContext();
                await ctx.removeFromIndex([indexedPath]);
                vscode.window.showInformationMessage(`Removed: ${indexedPath}`);
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
        vscode.commands.registerCommand("openContext.showIndexHealth", () => IndexHealthPanel.show()),
        vscode.commands.registerCommand("openContext.debugRetrieval", () => RetrievalDebugPanel.show()),
        vscode.commands.registerCommand("openContext.openIndexedFile", async (relPath: string, line?: number) => {
            const ctx = await svc.getContext();
            const uri = vscode.Uri.file(path.resolve(ctx.getWorkspaceRoot(), relPath));
            const doc = await vscode.workspace.openTextDocument(uri);
            const ed = await vscode.window.showTextDocument(doc, { preview: false });
            if (line && line > 0) {
                const pos = new vscode.Position(line - 1, 0);
                ed.selection = new vscode.Selection(pos, pos);
                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        }),

        vscode.commands.registerCommand("openContext.showStatus", async () => {
            try {
                const s = await svc.getStatus();
                vscode.window.showInformationMessage(`Open Context: ${s.workspaceRoot} | ${s.indexedFiles} files, ${s.totalChunks} chunks | ${s.embeddingProvider}/${s.embeddingModel} | Last: ${s.lastSynced || "never"}`);
            } catch {
                vscode.window.showInformationMessage("Open Context: Not initialized yet");
            }
        }),

        vscode.commands.registerCommand("openContext.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "openContext");
        }),

        vscode.commands.registerCommand("openContext.activateLicense", async () => {
            const key = await vscode.window.showInputBox({ prompt: "Paste your Open Context license key", ignoreFocusOut: true });
            if (!key) return;
            const r = svc.activateLicense(key.trim());
            if (r.ok) vscode.window.showInformationMessage(`Activated ${r.status.plan} license.`);
            else vscode.window.showErrorMessage(`Activation failed: ${r.error}`);
            chatView.refreshLicense();
        }),

        vscode.commands.registerCommand("openContext.undoLastEdit", async () => {
            try {
                const reverted = await reviewService.undoLast();
                if (reverted) {
                    treeProvider.refresh();
                    vscode.window.showInformationMessage(`Reverted agent edit to ${reverted}`);
                } else {
                    vscode.window.showInformationMessage("No agent edits to undo.");
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Undo failed: ${err?.message ?? String(err)}`);
            }
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
                const results = await svc.searchRaw(selection);
                if (!results.length) { vscode.window.showInformationMessage("No similar code found."); return; }
                const wsRoot = ctx.getWorkspaceRoot();
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
                reportIndexingError(err);
            }
        });
    }

    if (cfg.get<boolean>("autoIndex", true)) {
        svc.startWatching().catch((err) => {
            outputChannel?.appendLine(`[${new Date().toISOString()}] watcher failed: ${err?.message ?? String(err)}`);
        });
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
