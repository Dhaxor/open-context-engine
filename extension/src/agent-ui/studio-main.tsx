/**
 * Trace Studio, mounted in a VS Code editor tab.
 *
 * The Studio app itself is unchanged — only its transport (postMessage to the
 * extension host instead of HTTP to `oce trace`) and its host (VS Code's modal
 * dialogs, open-in-editor citations) are swapped, through the seams Studio
 * exposes for exactly this.
 */

import "../../../src/trace/studio/styles.css";
import "./studio-vscode.css";
import { mount } from "../../../src/trace/studio/app";
import { cssVariables } from "../../../src/trace/tokens";
import { VsCodeTransport } from "./transport";

// build-studio.js inlines the tokens into Studio's HTML shell; this webview has
// no such shell, so they go in first, ahead of the VS Code theme mapping.
const tokens = document.createElement("style");
tokens.textContent = cssVariables();
document.head.prepend(tokens);

let transport: VsCodeTransport | null = null;

mount(document.getElementById("root")!, {
  transport: handlers => (transport = new VsCodeTransport("studio", handlers)),
  host: {
    confirm: message => transport!.confirm(message),
    ask: (message, placeholder) => transport!.ask(message, placeholder),
    openFile: (path, line) => void transport!.openFile(path, line),
  },
});
