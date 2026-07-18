import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeEl {
  id = ""; className = ""; hidden = false; textContent = ""; innerHTML = ""; value = ""; style: any = {}; dataset: any = {}; children: any[] = []; onclick: any; onkeydown: any; oninput: any; scrollTop = 0; clientHeight = 100; scrollHeight = 100; selectionStart = 0; selectionEnd = 0; classList = { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => false };
  constructor(id = "") { this.id = id; }
  appendChild(c: any) { this.children.push(c); return c; } insertBefore(c: any) { this.children.unshift(c); return c; } remove() {}
  addEventListener(_t: string, cb: any) { (this as any)._listener = cb; }
  querySelector(sel: string) { if (sel === ".txt") return this._txt ||= new FakeEl(); return new FakeEl(); }
  querySelectorAll() { return []; } focus() {} dispatchEvent() {} closest() { return null; }
}

const ids = ["messages","q","sendBtn","stopBtn","modelBadge","planBadge","modeSeg","settingsPanel","historyPanel","accountPanel","histList","histEmpty","accountBody","reposBtn","contextBar","jumpBottom","newBtn","settingsBtn","openFullSettings","historyBtn","accountBtn","settingsClose","settingsCancel","historyClose","accountClose"];
let elements: Record<string, FakeEl>; let posted: any[]; let messageHandler: any;

beforeEach(() => {
  vi.resetModules(); posted = []; elements = Object.fromEntries(ids.map(id => [id, new FakeEl(id)]));
  (globalThis as any).document = { getElementById: (id: string) => elements[id] ||= new FakeEl(id), createElement: () => new FakeEl(), querySelector: () => null };
  (globalThis as any).window = { addEventListener: (_: string, cb: any) => { messageHandler = cb; } };
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage: (m: any) => posted.push(m) });
  (globalThis as any).requestAnimationFrame = (cb: any) => { cb(); return 1; };
  (globalThis as any).cancelAnimationFrame = () => {};
});

describe("chat webview main", () => {
  it("posts ready and query messages to the host", async () => {
    await import("./main");
    expect(posted[0]).toEqual({ type: "ready" });
    elements.q.value = "Explain this"; elements.sendBtn.onclick();
    expect(posted.at(-1)).toMatchObject({ type: "query", text: "Explain this", mode: "agent", multi: false });
  });
  it("handles host model/context/clear messages", async () => {
    await import("./main");
    messageHandler({ data: { type: "model", provider: "openai", model: "gpt-test" } });
    expect(elements.modelBadge.querySelector(".txt").textContent).toBe("gpt-test");
    messageHandler({ data: { type: "context", activeFile: "src/a.ts", hasSelection: true } });
    expect(elements.contextBar.innerHTML).toContain("src/a.ts");
    messageHandler({ data: { type: "clear" } });
    expect(elements.messages.innerHTML).toContain("New chat");
  });
});
