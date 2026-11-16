// Social cards (Open Graph / Twitter, 1200×630) rendered from card.html with
// real type, so a shared link reads "Open Context Engine — …" instead of an
// anonymous pattern. build-site.mjs picks web/og/<slug>.png for a page when
// it exists, else web/og-image.png.
//
//   xvfb-run -a npx --yes electron@37.2.3 --no-sandbox scripts/og/render.cjs
//
// (Electron needs a display; on a headless box run it under xvfb, as the
// README screenshots are.)
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("hide-scrollbars");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

const web = path.resolve(__dirname, "..", "..", "web");

const CARDS = [
  { out: "og-image.png", kicker: "open context engine", title: "Codebase context for AI coding agents", sub: "npm i -g @dhaxor/open-context", chunk: "README.md" },
  { out: "og/claude-code.png", kicker: "setup · claude code", title: "Give Claude Code your whole codebase", sub: "oce mcp install claude-code", chunk: "setup/claude-code" },
  { out: "og/cursor.png", kicker: "setup · cursor", title: "Give Cursor your whole codebase", sub: "oce mcp install cursor", chunk: "setup/cursor" },
  { out: "og/vscode.png", kicker: "vs code extension", title: "An AI agent in VS Code that shows its work", sub: "oce mcp install vscode", chunk: "setup/vscode" },
  { out: "og/windsurf.png", kicker: "setup · windsurf", title: "Codebase context for Windsurf's Cascade", sub: "oce mcp install windsurf", chunk: "setup/windsurf" },
  { out: "og/claude-desktop.png", kicker: "setup · claude desktop", title: "Ask Claude Desktop about your code", sub: "oce mcp install claude-desktop", chunk: "setup/claude-desktop" },
  { out: "og/mcp-server.png", kicker: "guide · mcp", title: "The MCP server for code search", sub: "oce mcp", chunk: "src/mcp/server.ts" },
  { out: "og/comparison.png", kicker: "compare", title: "OCE vs Cursor, Copilot and MCP context tools", chunk: "compare/context-options" },
  { out: "og/augment-alternative.png", kicker: "compare · augment", title: "An open-source alternative to Augment's Context Engine", chunk: "compare/augment" },
];

async function load(win, query) {
  for (let attempt = 1; ; attempt++) {
    try { return await win.loadFile(path.join(__dirname, "card.html"), { query }); } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(web, "og"), { recursive: true });
  for (const card of CARDS) {
    const win = new BrowserWindow({ width: 1200, height: 630, show: false, useContentSize: true, backgroundColor: "#0a0d12" });
    const { out, ...query } = card;
    await load(win, Object.fromEntries(Object.entries(query).filter(([, v]) => v)));
    // Web fonts first — a card in a fallback face is not the brand.
    await win.webContents.executeJavaScript("document.fonts.ready.then(() => document.fonts.check('600 66px \"IBM Plex Sans\"'))")
      .then(ok => { if (!ok) console.warn(`  ${out}: IBM Plex didn't load; rendered with a fallback font`); });
    await new Promise(r => setTimeout(r, 300));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(web, out), image.toPNG());
    console.log(`wrote web/${out} (${image.getSize().width}x${image.getSize().height})`);
    win.destroy();
  }
  app.quit();
});
