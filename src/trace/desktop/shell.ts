/**
 * Desktop shell logic, kept out of the Electron main process.
 *
 * `desktop/main.js` is deliberately thin — it wires Electron APIs to the pure
 * functions here. Electron code cannot be unit-tested without launching a
 * browser and a GPU process, so everything worth asserting (window bounds
 * validation, the menu, deep links, the studio URL) lives on this side of the
 * line and runs in the ordinary test suite.
 */

import * as fs from "fs";
import * as path from "path";

export interface Bounds { x?: number; y?: number; width: number; height: number; }
export interface Display { x: number; y: number; width: number; height: number; }

export const DEFAULT_BOUNDS: Bounds = { width: 1440, height: 900 };
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;

/**
 * Restore saved window bounds, but never trust them blindly. A window remembered
 * on a monitor that is no longer attached opens off-screen and looks, to the
 * user, exactly like the app failing to start.
 */
export function reconcileBounds(saved: unknown, displays: Display[]): Bounds {
  if (!isBounds(saved)) return { ...DEFAULT_BOUNDS };

  const width = clamp(saved.width, MIN_WIDTH, maxOf(displays, d => d.width, DEFAULT_BOUNDS.width));
  const height = clamp(saved.height, MIN_HEIGHT, maxOf(displays, d => d.height, DEFAULT_BOUNDS.height));
  const { x, y } = saved;
  if (x === undefined || y === undefined) return { width, height };

  // Require a meaningful overlap with some display, not merely a corner on it.
  const visible = displays.some(d => overlapArea({ x, y, width, height }, d) > (width * height) * 0.25);
  return visible ? { x, y, width, height } : { width, height };
}

function isBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!finite(b.width) || !finite(b.height)) return false;
  if (b.x !== undefined && !finite(b.x)) return false;
  if (b.y !== undefined && !finite(b.y)) return false;
  return (b.width as number) > 0 && (b.height as number) > 0;
}

function overlapArea(a: Required<Bounds>, b: Display): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

function maxOf<T>(items: T[], pick: (item: T) => number, fallback: number): number {
  return items.length ? Math.max(...items.map(pick)) : fallback;
}

/** Window bounds persisted next to the rest of the workspace state. */
export class WindowStateStore {
  constructor(private file: string) {}

  static forUserData(dir: string): WindowStateStore {
    return new WindowStateStore(path.join(dir, "window-state.json"));
  }

  load(displays: Display[]): Bounds {
    try {
      return reconcileBounds(JSON.parse(fs.readFileSync(this.file, "utf8")), displays);
    } catch {
      return { ...DEFAULT_BOUNDS };
    }
  }

  /** Best-effort: failing to remember a window size must never block quitting. */
  save(bounds: Bounds): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(bounds));
    } catch {}
  }
}

// ─── url + deep links ────────────────────────────────────────────────────────

/** The token rides in the fragment so it never reaches the server as a query
 *  string a log or proxy could retain. */
export function studioUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`;
}

export interface DeepLink {
  action: "open" | "session" | "rewind";
  value?: string;
}

/**
 * Parse a `trace://` URL. Unknown shapes resolve to a plain open rather than
 * throwing: a malformed link handed over by the OS should still bring the
 * window forward.
 */
export function parseDeepLink(url: string): DeepLink | null {
  if (!url.startsWith("trace://")) return null;
  const rest = url.slice("trace://".length).replace(/\/+$/, "");
  if (!rest) return { action: "open" };
  const [head, value] = rest.split("/", 2);
  if (head === "session" && value) return { action: "session", value };
  if (head === "rewind" && value) return { action: "rewind", value };
  return { action: "open" };
}

/** Only ever navigate the window to our own loopback origin. */
export function isTrustedUrl(url: string, port: number): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      && parsed.port === String(port);
  } catch {
    return false;
  }
}

// ─── menu ────────────────────────────────────────────────────────────────────

export interface MenuItemSpec {
  label?: string;
  role?: string;
  accelerator?: string;
  type?: "separator";
  id?: string;
  submenu?: MenuItemSpec[];
}

export interface MenuActions {
  newSession?: () => void;
  openWorkspace?: () => void;
  interrupt?: () => void;
  toggleRail?: () => void;
  commandPalette?: () => void;
  reload?: () => void;
}

/**
 * The application menu. Accelerators match Studio's in-page shortcuts so the
 * same keystroke does the same thing whether the web page or the shell handles
 * it — a menu that shadows a page shortcut with different behaviour is worse
 * than no menu.
 */
export function menuTemplate(platform: NodeJS.Platform, actions: MenuActions = {}): MenuItemSpec[] {
  const isMac = platform === "darwin";
  const mod = isMac ? "Cmd" : "Ctrl";

  const appMenu: MenuItemSpec[] = isMac
    ? [{
      label: "Trace",
      submenu: [
        { role: "about" }, { type: "separator" },
        { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { role: "quit" },
      ],
    }]
    : [];

  return [
    ...appMenu,
    {
      label: "Session",
      submenu: [
        { id: "new-session", label: "New session", accelerator: `${mod}+N` },
        { id: "open-workspace", label: "Open workspace…", accelerator: `${mod}+O` },
        { type: "separator" },
        { id: "command-palette", label: "Command palette", accelerator: `${mod}+K` },
        { id: "interrupt", label: "Interrupt", accelerator: "Esc" },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { id: "toggle-rail", label: "Evidence rail", accelerator: `${mod}+R` },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: isMac
        ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
        : [{ role: "minimize" }, { role: "close" }],
    },
  ];
}

/** Menu ids the shell binds to actions, so main.js and the tests agree. */
export const MENU_ACTION_IDS = ["new-session", "open-workspace", "command-palette", "interrupt", "toggle-rail"] as const;

// ─── attention ───────────────────────────────────────────────────────────────

export interface AttentionNotice { title: string; body: string; }

/**
 * What, if anything, deserves a desktop notification. Only two things do: the
 * agent is blocked on the user, or a turn finished while the window was in the
 * background. Notifying on ordinary progress trains people to ignore the app.
 */
export function attentionFor(
  event: { type: string; [key: string]: any },
  focused: boolean,
): AttentionNotice | null {
  if (focused) return null;
  if (event.type === "approval_request") {
    return { title: "Trace needs approval", body: String(event.request?.title ?? "A change is waiting for you.") };
  }
  if (event.type === "turn_end") {
    const stats = event.stats ?? {};
    const tools = stats.toolCalls ?? 0;
    return { title: "Trace finished a turn", body: `${stats.steps ?? 0} steps · ${tools} tool${tools === 1 ? "" : "s"}` };
  }
  if (event.type === "notice" && event.level === "error") {
    return { title: "Trace hit an error", body: String(event.message ?? "") };
  }
  return null;
}
