import { describe, expect, it } from "vitest";
import type { HostToWebviewMessage, WebviewToHostMessage } from "./messages";

describe("webview message contracts", () => {
  it("type-checks representative host-to-webview messages", () => {
    const messages: HostToWebviewMessage[] = [
      { type: "chunk", text: "hi" }, { type: "tool_update", id: "1", name: "read-file", status: "complete", label: "Read", args: { path: "a.ts" } },
      { type: "model", provider: "openai", model: "gpt" }, { type: "context", activeFile: "a.ts", hasSelection: true }, { type: "clear" },
    ];
    expect(messages.map(m => m.type)).toEqual(["chunk", "tool_update", "model", "context", "clear"]);
  });
  it("type-checks representative webview-to-host messages", () => {
    const messages: WebviewToHostMessage[] = [
      { type: "ready" }, { type: "query", text: "hello", mode: "agent", multi: false }, { type: "openFile", path: "a.ts", line: 2 },
      { type: "undoEdits", ids: ["e1"] }, { type: "setModel", provider: "openai", model: "gpt", baseUrl: "" },
    ];
    expect(messages[1]).toMatchObject({ type: "query", mode: "agent" });
  });
});
