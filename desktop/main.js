// Trace desktop — the Electron shell.
//
// Deliberately thin. The server, the session, and Studio are all the same code
// the CLI runs; this process starts them in-process and puts a window in front.
// Everything worth testing (bounds validation, the menu, deep links, when to
// notify) lives in src/trace/desktop/shell.ts and runs in the normal suite.
//
// Why Electron rather than a lighter shell: the index is a native SQLite handle
// that has to live in the same process as the server, and the VS Code extension
// already runs the same better-sqlite3 inside Electron. A Rust shell would need
// Node shipped alongside it as a sidecar.

const { app, BrowserWindow, Menu, Notification, dialog, shell } = require("electron");
const path = require("path");

const {
  MENU_ACTION_IDS, WindowStateStore, attentionFor, isTrustedUrl,
  menuTemplate, parseDeepLink, studioUrl,
} = require("../dist/trace/desktop/shell");
const { buildSession } = require("../dist/cli/session");
const { startTraceServer } = require("../dist/trace/server");

const PROTOCOL = "trace";

let mainWindow = null;
let server = null;
let built = null;
let windowState = null;
let pendingDeepLink = null;

// One instance owns the index; a second would open the same SQLite file twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = argv.find(a => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
    focusWindow();
  });
  main();
}

async function main() {
  await app.whenReady();
  windowState = WindowStateStore.forUserData(app.getPath("userData"));

  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox("Trace could not start", String((err && err.message) || err));
    app.quit();
    return;
  }

  createWindow();
  installMenu();
  registerProtocol();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusWindow();
  });
}

async function startBackend() {
  const workspace = workspaceFromArgv() || process.cwd();
  built = await buildSession({
    opts: { workspace, watch: true },
    diag: { progress: log, info: log, warn: log, error: log, debug: () => {} },
    interactive: true,
    traced: true,
    resolveConfig: requireResolveConfig(),
    fatal: (message) => { throw new Error(message); },
  });
  if (!built.trace) throw new Error("Trace session could not be built.");

  server = await startTraceServer({
    session: built.trace,
    port: 0,
    staticDir: path.join(__dirname, "..", "dist", "trace", "studio"),
    onLog: log,
  });

  // Desktop notifications are the one thing the shell adds to the web surface:
  // an agent that blocks on approval while you are in another window is
  // otherwise invisible.
  built.trace.subscribe(envelope => {
    const focused = !!(mainWindow && mainWindow.isFocused());
    const notice = attentionFor(envelope.event, focused);
    if (!notice || !Notification.isSupported()) return;
    const notification = new Notification({ title: notice.title, body: notice.body });
    notification.on("click", focusWindow);
    notification.show();
  });
}

/** The CLI owns config resolution; reuse it rather than duplicating defaults. */
function requireResolveConfig() {
  const { resolveDesktopConfig } = require("../dist/trace/desktop/config");
  return resolveDesktopConfig;
}

function createWindow() {
  const bounds = windowState.load(displayList());
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // Matches --void so the frame does not flash white before Studio paints.
    backgroundColor: "#0a0d12",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (pendingDeepLink) { handleDeepLink(pendingDeepLink); pendingDeepLink = null; }
  });

  const persist = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      windowState.save(mainWindow.getBounds());
    }
  };
  mainWindow.on("resize", persist);
  mainWindow.on("move", persist);
  mainWindow.on("close", persist);
  mainWindow.on("closed", () => { mainWindow = null; });

  // The renderer may only ever be our own loopback origin; anything else is a
  // link the user clicked and belongs in their real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url, server.port)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void mainWindow.loadURL(studioUrl(server.port, server.token));
}

function installMenu() {
  const actions = {
    "new-session": () => send("trace:new-session"),
    "open-workspace": openWorkspace,
    "command-palette": () => send("trace:command-palette"),
    interrupt: () => send("trace:interrupt"),
    "toggle-rail": () => send("trace:toggle-rail"),
  };
  const template = bindMenu(menuTemplate(process.platform), actions);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Attach click handlers to the ids the shared template declares. */
function bindMenu(template, actions) {
  return template.map(item => {
    const next = { ...item };
    if (next.submenu) next.submenu = bindMenu(next.submenu, actions);
    if (next.id && MENU_ACTION_IDS.includes(next.id) && actions[next.id]) {
      next.click = actions[next.id];
    }
    return next;
  });
}

async function openWorkspace() {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return;
  // Re-indexing in place would strand the open session; a new window on the
  // chosen workspace is both simpler and what the user means.
  app.relaunch({ args: [...process.argv.slice(1), "--workspace", result.filePaths[0]] });
  app.exit(0);
}

function registerProtocol() {
  if (process.defaultApp) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
}

function handleDeepLink(url) {
  const link = parseDeepLink(url);
  if (!link) return;
  if (!mainWindow) { pendingDeepLink = url; return; }
  focusWindow();
  if (link.action !== "open") send(`trace:${link.action}`, link.value);
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function displayList() {
  const { screen } = require("electron");
  return screen.getAllDisplays().map(d => ({ ...d.workArea }));
}

function workspaceFromArgv() {
  const index = process.argv.indexOf("--workspace");
  return index !== -1 ? process.argv[index + 1] : null;
}

function log(message) {
  process.stdout.write(String(message).endsWith("\n") ? String(message) : `${message}\n`);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  try { await (server && server.close()); } catch {}
  try { await (built && built.close()); } catch {}
});
