// README / Marketplace screenshots, rendered from the REAL webview bundles via
// the scripted harness (dev/agent-harness.mjs), so they always match the code.
//
//   node build.js --minify && node dev/agent-harness.mjs
//   xvfb-run -a npx --yes electron@37.2.3 --no-sandbox dev/capture-screenshots.cjs
//   xvfb-run -a npx --yes electron@37.2.3 --no-sandbox dev/capture-screenshots.cjs --only=trace-studio --scale=1
//
// Writes media/screenshots/*.png (excluded from the VSIX: the README references
// them from GitHub, which is where the Marketplace page loads them from).

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

// --scale=N (default 2) and --only=name: a 2x capture of the full-width Studio
// tab is larger than one capture can carry, so it runs as its own 1x pass.
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1];
app.commandLine.appendSwitch("force-device-scale-factor", arg("scale") ?? "2");
app.commandLine.appendSwitch("hide-scrollbars");
// Headless (Xvfb) GPU processes fail to hand back large captures; software
// compositing captures any size.
app.disableHardwareAcceleration();
// One window per shot: closing the last one would otherwise quit the app
// before the next shot starts.
app.on("window-all-closed", () => {});

const dev = __dirname;
const out = path.join(dev, "..", "media", "screenshots");

const SHOTS = [
  { file: "agent-approval.png", page: "agent-harness.html", scene: "running", width: 420, height: 900 },
  { file: "agent-changes.png", page: "agent-harness.html", scene: "done", width: 420, height: 900 },
  { file: "agent-parallel.png", page: "agent-harness.html", scene: "parallel", width: 420, height: 900 },
  { file: "agent-context.png", page: "agent-harness.html", scene: "done", width: 420, height: 900, click: ".meter" },
  { file: "trace-studio.png", page: "studio-harness.html", scene: "done", width: 1280, height: 800 },
];

/** A fresh window's first file load occasionally fails with ERR_FAILED under
 *  Xvfb; a retry is enough. */
async function load(win, file, search) {
  for (let attempt = 1; ; attempt++) {
    try { return await win.loadFile(file, { search }); } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const only = arg("only");
  for (const shot of SHOTS.filter(s => only ? s.file.startsWith(only) : !s.file.startsWith("trace-studio"))) {
    const win = new BrowserWindow({ width: shot.width, height: shot.height, show: false, useContentSize: true, backgroundColor: "#181818" });
    await load(win, path.join(dev, shot.page), `scene=${shot.scene}`);
    await new Promise(r => setTimeout(r, 1200));
    if (shot.click) {
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(shot.click)})?.click(); true`);
      await new Promise(r => setTimeout(r, 600));
    }
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, shot.file), image.toPNG());
    console.log(`wrote media/screenshots/${shot.file} (${image.getSize().width}x${image.getSize().height})`);
    win.destroy();
  }
  app.quit();
});
