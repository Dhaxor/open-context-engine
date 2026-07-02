import * as fs from "fs";
import * as vscode from "vscode";
import { settingsBody } from "./settings-html";
import { buildConfigPayload, handleConfigMessage } from "../shared/open-context-config";
import { ContextService } from "../services/ContextService";

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

/** Full-page Open Context settings (sidebar nav + sections). */
export class SettingsPanel {
  private static current?: SettingsPanel;
  /** Called after license activate/deactivate so the chat webview can refresh. */
  static onLicenseChanged?: () => void;

  private panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    panel.webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
    panel.webview.html = this.getHtml();
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    panel.onDidDispose(() => {
      if (SettingsPanel.current === this) SettingsPanel.current = undefined;
    });

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("openContext")) void this.sendConfig();
    });
    panel.onDidDispose(() => configListener.dispose());
  }

  static show(extensionUri: vscode.Uri, section?: string): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal(vscode.ViewColumn.One);
      if (section) SettingsPanel.current.panel.webview.postMessage({ type: "navigate", section });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "openContext.settings",
      "Open Context Settings",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SettingsPanel.current = new SettingsPanel(panel, extensionUri);
    if (section) setTimeout(() => SettingsPanel.current?.panel.webview.postMessage({ type: "navigate", section }), 50);
  }

  private async onMessage(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.sendConfig();
        this.sendLicense();
        break;
      case "openVscodeSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "openContext");
        break;
      case "activateLicense":
        if (typeof msg.key === "string") {
          const r = ContextService.getInstance().activateLicense(msg.key.trim());
          if (r.ok) vscode.window.showInformationMessage(`Activated ${r.status.plan} license.`);
          else vscode.window.showErrorMessage(`Activation failed: ${r.error}`);
          this.notifyLicenseChanged();
        }
        break;
      case "deactivateLicense":
        ContextService.getInstance().deactivateLicense();
        vscode.window.showInformationMessage("License removed — running as Community edition.");
        this.notifyLicenseChanged();
        break;
      case "openExternal":
        if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
        break;
      default:
        await handleConfigMessage(msg, {
          onModelChange: () => { /* model badge lives in chat view */ },
          onConfigSent: () => this.sendConfig(),
        });
    }
  }

  private async sendConfig(): Promise<void> {
    this.panel.webview.postMessage(await buildConfigPayload());
  }

  private sendLicense(): void {
    this.panel.webview.postMessage({ type: "license", status: ContextService.getInstance().getLicenseStatus() });
  }

  private notifyLicenseChanged(): void {
    this.sendLicense();
    SettingsPanel.onLicenseChanged?.();
  }

  private getHtml(): string {
    const nonce = getNonce();
    const distDir = vscode.Uri.joinPath(this.extensionUri, "dist");
    let js = "";
    let css = "";
    try { js = fs.readFileSync(vscode.Uri.joinPath(distDir, "settings-webview.js").fsPath, "utf8"); } catch { /* missing */ }
    try { css = fs.readFileSync(vscode.Uri.joinPath(distDir, "settings-webview.css").fsPath, "utf8"); } catch { /* missing */ }
    if (!js) {
      return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground)">Open Context settings: run <code>npm run build</code> in <code>extension/</code>.</body></html>`;
    }
    const cspSource = this.panel.webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource};">
<style>${css}</style>
</head>
<body>
${settingsBody}
<script nonce="${nonce}">${js}</script>
</body>
</html>`;
  }
}
