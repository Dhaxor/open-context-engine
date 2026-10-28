import * as vscode from "vscode";
import type { EditReviewService } from "../services/EditReviewService";
import { TraceBridge } from "./TraceBridge";
import type { TraceHost } from "./TraceHost";
import { webviewHtml } from "./webview-html";

/**
 * The agent sidebar. Keeps the legacy view id (`openContext.chat`) so existing
 * keybindings, the walkthrough, and `openContext.openChat` keep working.
 */
export class AgentView implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = "openContext.chat";
    private view?: vscode.WebviewView;
    private bridge?: TraceBridge;
    private pending: { text: string; send: boolean } | null = null;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly host: TraceHost,
        private readonly review: EditReviewService,
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        this.bridge?.dispose();
        this.bridge = new TraceBridge(this.host, this.review, view.webview, "sidebar");
        view.webview.html = webviewHtml(view.webview, this.extensionUri, "agent", "Open Context");
        if (this.pending) { this.bridge.compose(this.pending.text, this.pending.send); this.pending = null; }
        view.onDidDispose(() => {
            this.bridge?.dispose();
            this.bridge = undefined;
            this.view = undefined;
        });
    }

    focus(): void {
        if (this.view) this.view.show(true);
        else void vscode.commands.executeCommand(`${AgentView.viewType}.focus`);
    }

    /** Fill the composer — and send it, for commands like "Explain with context". */
    compose(text: string, send = false): void {
        this.focus();
        if (this.bridge) this.bridge.compose(text, send);
        else this.pending = { text, send };
    }

    async newConversation(): Promise<void> {
        await this.host.newConversation(null).catch(err => vscode.window.showErrorMessage(String(err?.message ?? err)));
    }

    dispose(): void {
        this.bridge?.dispose();
        this.bridge = undefined;
    }
}
