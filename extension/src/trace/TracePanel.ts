import * as vscode from "vscode";
import type { EditReviewService } from "../services/EditReviewService";
import { TraceBridge } from "./TraceBridge";
import type { TraceHost } from "./TraceHost";
import { webviewHtml } from "./webview-html";

/**
 * Trace Studio in an editor tab: the full workspace — checkpoint spine,
 * transcript, and evidence rail — for when the sidebar is too narrow to
 * inspect what the model saw. Same sessions as the sidebar, its own bridge, so
 * the two can watch different sessions side by side.
 */
export class TracePanel implements vscode.Disposable {
    private static current: TracePanel | undefined;
    private readonly bridge: TraceBridge;

    static show(extensionUri: vscode.Uri, host: TraceHost, review: EditReviewService): TracePanel {
        if (TracePanel.current) {
            TracePanel.current.panel.reveal();
            return TracePanel.current;
        }
        const panel = vscode.window.createWebviewPanel("openContext.trace", "Trace", vscode.ViewColumn.Active, {
            enableScripts: true,
            // A running turn keeps streaming while the tab is in the background.
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
        });
        panel.iconPath = vscode.Uri.joinPath(extensionUri, "icon.png");
        TracePanel.current = new TracePanel(panel, extensionUri, host, review);
        return TracePanel.current;
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        host: TraceHost,
        review: EditReviewService,
    ) {
        this.bridge = new TraceBridge(host, review, panel.webview, "studio");
        panel.webview.html = webviewHtml(panel.webview, extensionUri, "trace-studio", "Trace");
        panel.onDidDispose(() => this.dispose());
    }

    dispose(): void {
        if (TracePanel.current === this) TracePanel.current = undefined;
        this.bridge.dispose();
    }
}
