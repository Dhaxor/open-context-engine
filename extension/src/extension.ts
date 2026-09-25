import * as vscode from "vscode";
import * as path from "path";
import { ContextService } from "./services/ContextService";
import { ChatView } from "./chat/ChatView";
import { IndexedFilesProvider } from "./providers/IndexedFilesProvider";
import { SearchProvider } from "./providers/SearchProvider";
import { IndexHealthPanel } from "./health/IndexHealthPanel";
import { RetrievalDebugPanel } from "./health/RetrievalDebugPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { EditReviewService } from "./services/EditReviewService";
import { ensureNativeBinding } from "./services/NativeBindingSelector";
import { SearchResult } from "../../src/core/types";
import { classifyNativeBindingError } from "../../src/core/native-binding-error";

let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel | undefined;

/** Settings the store is built from (ContextService.getConfigForPath, the watcher). */
const STORE_SETTINGS = [
    "openContext.embedding",
    "openContext.search",
    "openContext.chunkSize",
    "openContext.chunkOverlap",
    "openContext.autoIndex",
];
/** Changes that switch the store's embedding space, so it must be re-indexed. */
const EMBEDDING_SETTINGS = [
    "openContext.embedding.provider",
    "openContext.embedding.model",
    "openContext.embedding.apiKey",
];

/** Show the user a real, actionable error for any failure that initializes the
 *  native SQLite binding (NMV mismatch, glibc skew, wrong arch, etc.). Until
 *  v0.1.1 the startup-index catch site swallowed these with a console.error
 *  the user could never see, which is why "indexing silently failed" was the
 *  first-run experience for paying customers on mismatched VS Code builds. */
function reportIndexingError(err: unknown): void {
  if (err instanceof Error && err.name === "KeywordFallbackRefusedError") {
    // The store holds embeddings built with a key that is no longer set. The
    // core refuses to wipe them for a keyword-only fallback; its message names
    // CLI commands, so say it the extension's way.
    outputChannel?.appendLine(`[${new Date().toISOString()}] ${err.message}`);
    vscode.window.showWarningMessage(
      "Open Context: this workspace's index was built with semantic search, but no embedding API key is set. Set the key it was built with to keep using it.",
      "Set API Key",
    ).then((pick) => {
      if (pick === "Set API Key") void vscode.commands.executeCommand("openContext.setEmbeddingApiKey");
    });
    return;
  }
  const diag = classifyNativeBindingError(err);
  outputChannel?.appendLine("");
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${diag.title}`);
  outputChannel?.appendLine(diag.raw);
  if (!diag.recognized) {
    // Not a native-binding failure the classifier knows, so its generic title
    // ("failed to load native SQLite binding") would misdiagnose it. Say what
    // actually failed.
    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    vscode.window.showErrorMessage(`Open Context Engine: indexing failed — ${reason}`, "Open Output").then((pick) => {
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

    // Prove the native SQLite binding loads before anything can touch the
    // store: one Node-API binary serves every Electron ABI, so a failure here
    // is the host (musl, old glibc, wrong arch), and it deserves a clear error.
    const binding = ensureNativeBinding();
    outputChannel.appendLine(`[${new Date().toISOString()}] native binding: ${binding.detail} (ABI ${binding.abi})`);
    // The loader's own error (dlopen text, .node path, stack): what anyone
    // debugging an inert extension actually needs.
    if (binding.raw) outputChannel.appendLine(binding.raw);
    if (!binding.ok) {
        vscode.window.showErrorMessage(`Open Context Engine cannot start — ${binding.detail}`, "Open Output").then((pick) => {
            if (pick === "Open Output") outputChannel?.show(true);
        });
        return; // Inert rather than broken: no commands that would all fail anyway.
    }

    const svc = ContextService.getInstance();
    svc.bindExtensionContext(context);
    const reviewService = new EditReviewService(async () => (await svc.getContext()).getWorkspaceRoot());
    context.subscriptions.push(reviewService);
    const chatView = new ChatView(context.extensionUri, context, reviewService);
    SettingsPanel.onLicenseChanged = () => chatView.refreshLicense();
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
            const modeSuffix = s.searchMode === "keyword-only" ? " · keyword-only" : "";
            statusBarItem.text = `$(database) Open Context: ${rootName} · ${s.indexedFiles} files${modeSuffix}`;
            const keywordOnlyWhy = s.degradedKind === "keyword_only" ? "no embedding API key set" : "sqlite-vec unavailable on this platform";
            statusBarItem.tooltip = `Open Context index: ${s.workspaceRoot}\n${s.totalChunks} chunks${s.searchMode === "keyword-only" ? `\nKeyword-only (BM25) search — ${keywordOnlyWhy}.` : ""}`;
            treeProvider.refresh();
        } catch {}
    };
    context.subscriptions.push(svc.onReindex((result) => {
        // Watch-mode reindexes are background work — failures shouldn't toast
        // on every save, but they must not be invisible either.
        if (result.failed?.length) {
            outputChannel?.appendLine(`[${new Date().toISOString()}] watch reindex: ${result.failed.length} file(s) failed to embed (will retry on next index). ${result.failedReason ?? ""}`);
        }
        void refreshStatus();
    }));
    // One debounced re-index for every change that reopens the store in a new
    // embedding space. Settling first matters: a second change moments later
    // would close the store under a run the first one started.
    let reindexTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReindex = () => {
        if (reindexTimer) clearTimeout(reindexTimer);
        reindexTimer = setTimeout(() => {
            reindexTimer = undefined;
            void vscode.commands.executeCommand("openContext.indexWorkspace");
        }, 1500);
    };
    context.subscriptions.push({ dispose: () => { if (reindexTimer) clearTimeout(reindexTimer); } });

    context.subscriptions.push(svc.onEmbeddingKeyChanged((hasKey) => {
        // Every key-save path lands here — the command, the settings panel,
        // the chat's key form. A new key reopens the store empty in vector
        // mode, so rebuild it now instead of leaving search empty until files
        // change.
        if (hasKey) scheduleReindex();
        else void refreshStatus();
    }));

    const restartWatching = async () => {
        if (vscode.workspace.getConfiguration("openContext").get<boolean>("autoIndex", true)) {
            await svc.startWatching().catch((err) => console.error("[openContext] watcher failed:", err));
        }
    };

    const runIndex = async (label: string, op: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<import("../../src/core/types").IndexingResult | void>) => {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: label, cancellable: true },
            async (progress, token) => {
                const generation = svc.getContextGeneration();
                try {
                    const result = await op(progress, token);
                    await refreshStatus();
                    const s = await svc.getStatus();
                    if (result?.failed?.length) {
                        // Partial success: be honest about what didn't make it in,
                        // and that the next index run will retry those files.
                        vscode.window.showWarningMessage(
                            `Indexed ${s.indexedFiles} files, but ${result.failed.length} failed to embed and will be retried on the next index. ${result.failedReason ?? ""}`.trim(),
                        );
                    } else {
                        vscode.window.showInformationMessage(`Indexed ${path.basename(s.workspaceRoot)}: ${s.indexedFiles} files (${s.totalChunks} chunks)`);
                    }
                } catch (err: any) {
                    // The run may have rebuilt the store before failing; don't
                    // leave the status bar showing the old count.
                    await refreshStatus();
                    if (err instanceof vscode.CancellationError) return;
                    // The store was reopened under this run (a setting or key
                    // changed). Not a failure to report: run again once things
                    // settle — the debounce folds this into any run the reopen
                    // itself scheduled.
                    if (svc.getContextGeneration() !== generation) {
                        scheduleReindex();
                        return;
                    }
                    vscode.window.showErrorMessage(`Indexing failed: ${err.message}`);
                }
            },
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("openContext.indexWorkspace", async () => {
            await runIndex("Indexing workspace...", (progress, token) =>
                svc.indexWorkspace((status, current, total) => {
                    progress.report({ message: total > 0 ? `${status}: ${current}/${total}` : status });
                }, token),
            );
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
            await runIndex(`Indexing ${path.basename(dir)}...`, (progress, token) =>
                svc.indexDirectory(dir, (status, current, total) => {
                    progress.report({ message: total > 0 ? `${status}: ${current}/${total}` : status });
                }, token),
            );
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
                const r = await ctx.addFiles([{ path: filePath, contents: new TextDecoder().decode(content) }]);
                if (r.failed?.length) {
                    vscode.window.showWarningMessage(`Failed to embed ${filePath}: ${r.failedReason ?? "embedding error"} — it will be retried on the next index.`);
                } else {
                    vscode.window.showInformationMessage(`Re-indexed: ${filePath}`);
                }
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
        vscode.commands.registerCommand("openContext.restartTour", () => chatView.startTour(true)),
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
                vscode.window.showInformationMessage(`Open Context: ${s.workspaceRoot} | ${s.indexedFiles} files, ${s.totalChunks} chunks | ${s.embeddingProvider}/${s.embeddingModel}${s.searchMode === "keyword-only" ? " | ⚠ keyword-only (BM25) search" : ""} | Last: ${s.lastSynced || "never"}`);
            } catch {
                vscode.window.showInformationMessage("Open Context: Not initialized yet");
            }
        }),

        vscode.commands.registerCommand("openContext.openSettings", () => {
            SettingsPanel.show(context.extensionUri, "model-keys");
        }),

        vscode.commands.registerCommand("openContext.activateLicense", async () => {
            const key = await vscode.window.showInputBox({ prompt: "Paste your Open Context license key", ignoreFocusOut: true });
            if (!key) return;
            const r = svc.activateLicense(key.trim());
            if (r.ok) vscode.window.showInformationMessage(`Activated ${r.status.plan} license.`);
            else vscode.window.showErrorMessage(`Activation failed: ${r.error}`);
            chatView.refreshLicense();
        }),

        vscode.commands.registerCommand("openContext.showMemories", async () => {
            try {
                const ctx = await svc.getContext();
                const memPath = path.join(ctx.getWorkspaceRoot(), ".open-context", "memories.json");
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(memPath));
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch {
                vscode.window.showInformationMessage("No memories stored yet for this workspace.");
            }
        }),

        vscode.commands.registerCommand("openContext.clearMemories", async () => {
            const pick = await vscode.window.showWarningMessage(
                "Clear all remembered codebase insights for this workspace?",
                { modal: true },
                "Clear",
            );
            if (pick !== "Clear") return;
            let cleared = chatView.getAgentService().clearMemories();
            if (cleared === null) {
                // Agent (and its memory) not built this session — clear the file directly.
                try {
                    const ctx = await svc.getContext();
                    const memPath = path.join(ctx.getWorkspaceRoot(), ".open-context", "memories.json");
                    await vscode.workspace.fs.delete(vscode.Uri.file(memPath));
                    cleared = -1;
                } catch { cleared = 0; }
            }
            vscode.window.showInformationMessage(cleared === 0 ? "No memories to clear." : "Memories cleared.");
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
            // The key belongs to whichever provider is selected, so name it.
            const provider = vscode.workspace.getConfiguration("openContext").get<string>("embedding.provider", "voyage");
            const label = ({ voyage: "Voyage", openai: "OpenAI" } as Record<string, string>)[provider] ?? provider;
            const value = await vscode.window.showInputBox({
                prompt: `${label} embedding API key (stored in VS Code SecretStorage). To use another provider, change openContext.embedding.provider first.`,
                password: true,
            });
            if (value === undefined) return;
            // setEmbeddingApiKey fires onEmbeddingKeyChanged, which re-indexes.
            await svc.setEmbeddingApiKey(value);
            vscode.window.showInformationMessage(value ? `${label} key saved — re-indexing with semantic search.` : "Embedding API key cleared.");
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
                const r = await svc.indexWorkspace();
                await refreshStatus();
                // One-time keyword-only notice: persistent signal lives in the
                // status bar + health panel, so don't toast on every command.
                const status = await svc.getStatus();
                if (status.searchMode === "keyword-only" && status.degradedKind === "keyword_only") {
                    // No embedding key yet — the first run for most installs. Keyword
                    // search works; say so once and offer the way to semantic search.
                    if (!context.globalState.get<boolean>("openContext.noKeyNoticeShown")) {
                        await context.globalState.update("openContext.noKeyNoticeShown", true);
                        // Only Voyage and OpenAI need a key, so the keyless fallback means one of them.
                        const chosen = vscode.workspace.getConfiguration("openContext").get<string>("embedding.provider", "voyage") === "openai" ? "OpenAI" : "Voyage";
                        const other = chosen === "OpenAI" ? "Voyage" : "OpenAI";
                        vscode.window.showInformationMessage(
                            `Open Context: indexed with keyword search. For semantic search, set a ${chosen} API key, or choose another embedding provider — ${other}, or Ollama for free local embeddings.`,
                            "Set API Key",
                            "Choose Provider",
                        ).then((pick) => {
                            if (pick === "Set API Key") void vscode.commands.executeCommand("openContext.setEmbeddingApiKey");
                            else if (pick === "Choose Provider") void vscode.commands.executeCommand("workbench.action.openSettings", "openContext.embedding");
                        });
                    }
                } else if (status.searchMode === "keyword-only" && !context.globalState.get<boolean>("openContext.keywordOnlyNoticeShown")) {
                    await context.globalState.update("openContext.keywordOnlyNoticeShown", true);
                    outputChannel?.appendLine(`[${new Date().toISOString()}] keyword-only mode: ${status.degradedReason ?? "sqlite-vec unavailable"}`);
                    vscode.window.showWarningMessage(
                        "Open Context: semantic search is unavailable on this platform — running keyword-only (BM25) search. Indexing and search still work.",
                        "Open Output",
                    ).then((pick) => { if (pick === "Open Output") outputChannel?.show(true); });
                } else if (status.searchMode === "hybrid") {
                    // Healthy again — re-arm so a future degraded period gets
                    // its one toast instead of being suppressed forever.
                    for (const flag of ["openContext.keywordOnlyNoticeShown", "openContext.noKeyNoticeShown"]) {
                        if (context.globalState.get<boolean>(flag)) await context.globalState.update(flag, undefined);
                    }
                }
                if (r.failed?.length) {
                    outputChannel?.appendLine(`[${new Date().toISOString()}] startup index: ${r.failed.length} file(s) failed to embed (will retry on next index). ${r.failedReason ?? ""}`);
                    vscode.window.showWarningMessage(
                        `Open Context: ${r.failed.length} file(s) failed to embed during startup indexing — they'll be retried on the next index.`,
                        "Open Output",
                    ).then((pick) => { if (pick === "Open Output") outputChannel?.show(true); });
                }
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
            // Reopen the store only for settings it is built from. Chat and agent
            // settings are read per turn; reopening for them would close the
            // store under an index in flight — the model & keys form writes
            // llm.* on every save, right beside the key save that starts one.
            if (!STORE_SETTINGS.some((key) => e.affectsConfiguration(key))) return;
            await svc.dispose();
            svc.bindExtensionContext(context);
            if (vscode.workspace.getConfiguration("openContext").get<boolean>("autoIndex", true)) {
                await svc.startWatching().catch(() => {});
            }
            // A new embedding provider, model or key reopens the store empty in
            // the new mode, and the watcher only picks up files as they change.
            // Any other reopen can land there too — e.g. a key saved in another
            // window (SecretStorage is shared) takes effect here on this reopen —
            // so an empty store is rebuilt whatever the setting was.
            if (EMBEDDING_SETTINGS.some((key) => e.affectsConfiguration(key))) {
                scheduleReindex();
            } else {
                try {
                    if ((await svc.getStatus()).indexedFiles === 0) scheduleReindex();
                } catch { /* reported by the index run or the next command */ }
            }
            await refreshStatus();
        }),
    );

    context.subscriptions.push({ dispose: () => svc.dispose() });
    context.subscriptions.push(treeView);
}

export function deactivate(): void {
    ContextService.getInstance().dispose().catch(() => {});
    statusBarItem?.dispose();
}
