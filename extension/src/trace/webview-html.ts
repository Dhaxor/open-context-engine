import * as fs from "fs";
import * as vscode from "vscode";

function nonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}

/**
 * The HTML for an agent webview. The bundle (dist/<name>.js + .css) is inlined
 * rather than loaded by URI, so the CSP stays a single nonce and there are no
 * asWebviewUri paths to get wrong across remote/WSL windows.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: string, title: string): string {
    const dist = vscode.Uri.joinPath(extensionUri, "dist");
    let js = "", css = "";
    try { js = fs.readFileSync(vscode.Uri.joinPath(dist, `${bundle}.js`).fsPath, "utf8"); } catch {}
    try { css = fs.readFileSync(vscode.Uri.joinPath(dist, `${bundle}.css`).fsPath, "utf8"); } catch {}
    if (!js) {
        return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground)">Open Context: the ${bundle} webview bundle is missing. Run <code>npm run build</code> in <code>extension/</code>.</body></html>`;
    }
    const n = nonce();
    // A `</script>` inside the bundle (a string literal) would end the tag early.
    const safeJs = js.replace(/<\/script/gi, "<\\/script");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${n}'; font-src ${webview.cspSource};">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script nonce="${n}">${safeJs}</script>
</body>
</html>`;
}
