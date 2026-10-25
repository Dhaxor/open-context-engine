import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_BOUNDS, MENU_ACTION_IDS, WindowStateStore, attentionFor, isTrustedUrl,
  menuTemplate, parseDeepLink, reconcileBounds, studioUrl, type Display, type MenuItemSpec,
} from "./shell";

const LAPTOP: Display = { x: 0, y: 0, width: 1440, height: 900 };
const EXTERNAL: Display = { x: 1440, y: 0, width: 2560, height: 1440 };

let tmp: string | null = null;
afterEach(() => {
  if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

describe("reconcileBounds", () => {
  it("restores bounds that sit on an attached display", () => {
    const saved = { x: 100, y: 80, width: 1200, height: 800 };
    expect(reconcileBounds(saved, [LAPTOP])).toEqual(saved);
  });

  it("drops a position remembered on a display that is gone", () => {
    // Reopening off-screen is indistinguishable from the app failing to start.
    const saved = { x: 2000, y: 200, width: 1200, height: 800 };
    const result = reconcileBounds(saved, [LAPTOP]);
    expect(result).toEqual({ width: 1200, height: 800 });
  });

  it("keeps a position on a second display while it is attached", () => {
    const saved = { x: 1600, y: 100, width: 1200, height: 800 };
    expect(reconcileBounds(saved, [LAPTOP, EXTERNAL])).toEqual(saved);
  });

  it("rejects a window barely overlapping a display", () => {
    // A few pixels on screen is not "visible" in any useful sense.
    const saved = { x: 1400, y: 860, width: 1200, height: 800 };
    expect(reconcileBounds(saved, [LAPTOP])).toEqual({ width: 1200, height: 800 });
  });

  it("clamps a size larger than any display", () => {
    const result = reconcileBounds({ width: 9000, height: 9000 }, [LAPTOP]);
    expect(result.width).toBe(1440);
    expect(result.height).toBe(900);
  });

  it("enforces a usable minimum", () => {
    const result = reconcileBounds({ width: 10, height: 10 }, [LAPTOP]);
    expect(result.width).toBeGreaterThanOrEqual(720);
    expect(result.height).toBeGreaterThanOrEqual(480);
  });

  it("falls back to defaults for anything malformed", () => {
    for (const bad of [null, undefined, {}, "nope", { width: NaN, height: 100 }, { width: -5, height: 5 }, { width: 100, height: 100, x: "left" }]) {
      expect(reconcileBounds(bad, [LAPTOP])).toEqual(DEFAULT_BOUNDS);
    }
  });

  it("still returns something usable with no displays reported", () => {
    expect(reconcileBounds({ width: 1200, height: 800 }, [])).toEqual({ width: 1200, height: 800 });
  });
});

describe("WindowStateStore", () => {
  function store() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trace-window-"));
    return { dir: tmp, store: WindowStateStore.forUserData(tmp) };
  }

  it("round-trips bounds", () => {
    const { store: s } = store();
    s.save({ x: 20, y: 30, width: 1100, height: 700 });
    expect(s.load([LAPTOP])).toEqual({ x: 20, y: 30, width: 1100, height: 700 });
  });

  it("returns defaults when nothing has been saved", () => {
    const { store: s } = store();
    expect(s.load([LAPTOP])).toEqual(DEFAULT_BOUNDS);
  });

  it("survives a corrupt state file", () => {
    const { dir, store: s } = store();
    fs.writeFileSync(path.join(dir, "window-state.json"), "{ not json");
    expect(s.load([LAPTOP])).toEqual(DEFAULT_BOUNDS);
  });

  it("never throws when the location is unwritable", () => {
    // A regular file standing where a directory should be: mkdir fails with
    // ENOTDIR immediately. Failing to remember a window size must never be
    // able to block quitting.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trace-window-"));
    const blocker = path.join(tmp, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const s = new WindowStateStore(path.join(blocker, "state.json"));
    expect(() => s.save({ width: 800, height: 600 })).not.toThrow();
    expect(s.load([LAPTOP])).toEqual(DEFAULT_BOUNDS);
  });
});

describe("studioUrl and navigation trust", () => {
  it("puts the token in the fragment, never the query", () => {
    const url = studioUrl(4319, "tok en/+1");
    expect(url).toBe("http://127.0.0.1:4319/#token=tok%20en%2F%2B1");
    expect(url).not.toContain("?token=");
  });

  it("trusts only our own loopback origin", () => {
    expect(isTrustedUrl("http://127.0.0.1:4319/", 4319)).toBe(true);
    expect(isTrustedUrl("http://localhost:4319/x", 4319)).toBe(true);
    expect(isTrustedUrl("http://127.0.0.1:4320/", 4319)).toBe(false);
    expect(isTrustedUrl("https://evil.example/", 4319)).toBe(false);
    expect(isTrustedUrl("file:///etc/passwd", 4319)).toBe(false);
    expect(isTrustedUrl("not a url", 4319)).toBe(false);
  });
});

describe("parseDeepLink", () => {
  it("reads session and rewind links", () => {
    expect(parseDeepLink("trace://session/2026-07-28-abcd")).toEqual({ action: "session", value: "2026-07-28-abcd" });
    expect(parseDeepLink("trace://rewind/9b02")).toEqual({ action: "rewind", value: "9b02" });
  });

  it("treats a bare link as open", () => {
    expect(parseDeepLink("trace://")).toEqual({ action: "open" });
    expect(parseDeepLink("trace:///")).toEqual({ action: "open" });
  });

  it("degrades an unknown shape to open rather than throwing", () => {
    // A malformed link from the OS should still bring the window forward.
    expect(parseDeepLink("trace://whatever/1/2/3")).toEqual({ action: "open" });
    expect(parseDeepLink("trace://session")).toEqual({ action: "open" });
  });

  it("ignores other protocols", () => {
    expect(parseDeepLink("https://example.com")).toBeNull();
  });
});

describe("menuTemplate", () => {
  function ids(template: MenuItemSpec[]): string[] {
    return template.flatMap(item => [
      ...(item.id ? [item.id] : []),
      ...(item.submenu ? ids(item.submenu) : []),
    ]);
  }
  function labels(template: MenuItemSpec[]): string[] {
    return template.map(item => item.label ?? item.role ?? "");
  }

  it("declares every id the shell binds", () => {
    const declared = ids(menuTemplate("darwin"));
    for (const id of MENU_ACTION_IDS) expect(declared).toContain(id);
  });

  it("puts the app menu first on macOS only", () => {
    expect(labels(menuTemplate("darwin"))[0]).toBe("Trace");
    expect(labels(menuTemplate("win32"))[0]).toBe("Session");
    expect(labels(menuTemplate("linux"))[0]).toBe("Session");
  });

  it("uses the platform's modifier", () => {
    const mac = JSON.stringify(menuTemplate("darwin"));
    const win = JSON.stringify(menuTemplate("win32"));
    expect(mac).toContain("Cmd+K");
    expect(win).toContain("Ctrl+K");
  });

  it("matches Studio's own shortcuts so a key never means two things", () => {
    const template = JSON.stringify(menuTemplate("win32"));
    expect(template).toContain('"accelerator":"Ctrl+K"');
    expect(template).toContain('"accelerator":"Esc"');
    expect(template).toContain('"accelerator":"Ctrl+R"');
  });

  it("offers quit on Windows and close on macOS in the session menu", () => {
    const macSession = menuTemplate("darwin").find(i => i.label === "Session")!;
    const winSession = menuTemplate("win32").find(i => i.label === "Session")!;
    expect(JSON.stringify(macSession)).toContain('"role":"close"');
    expect(JSON.stringify(winSession)).toContain('"role":"quit"');
  });
});

describe("attentionFor", () => {
  const approval = { type: "approval_request", request: { title: "edit src/a.ts" } };

  it("says nothing while the window is focused", () => {
    // You are already looking at it.
    expect(attentionFor(approval, true)).toBeNull();
  });

  it("notifies when the agent is blocked on you", () => {
    expect(attentionFor(approval, false)).toEqual({
      title: "Trace needs approval",
      body: "edit src/a.ts",
    });
  });

  it("notifies when a turn finishes in the background", () => {
    const notice = attentionFor({ type: "turn_end", stats: { steps: 3, toolCalls: 1 } }, false)!;
    expect(notice.title).toBe("Trace finished a turn");
    expect(notice.body).toBe("3 steps · 1 tool");
  });

  it("notifies on errors but not on ordinary progress", () => {
    expect(attentionFor({ type: "notice", level: "error", message: "boom" }, false)).toMatchObject({ body: "boom" });
    // Notifying on progress trains people to ignore the app.
    expect(attentionFor({ type: "text", text: "…" }, false)).toBeNull();
    expect(attentionFor({ type: "retrieval" }, false)).toBeNull();
    expect(attentionFor({ type: "notice", level: "info", message: "fyi" }, false)).toBeNull();
  });

  it("copes with a malformed event", () => {
    expect(attentionFor({ type: "approval_request" }, false)).toMatchObject({
      body: "A change is waiting for you.",
    });
    expect(attentionFor({ type: "turn_end" }, false)?.body).toBe("0 steps · 0 tools");
  });
});
