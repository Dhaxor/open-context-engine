// Verify the desktop shell's wiring without launching Electron.
//
// Electron needs a display and a GPU process, so it cannot run in CI or over a
// plain shell. What actually breaks in practice is not Electron — it is a
// require path that drifted or an export that got renamed. This checks exactly
// that, and it runs anywhere Node does.
//
//   npm run build && node scripts/check-desktop.js

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const problems = [];

function load(rel) {
  try {
    return require(path.join(root, rel));
  } catch (err) {
    problems.push(`cannot require ${rel}: ${String((err && err.message) || err).slice(0, 160)}`);
    return null;
  }
}

const REQUIRED = {
  "dist/trace/desktop/shell": [
    "MENU_ACTION_IDS", "WindowStateStore", "attentionFor",
    "isTrustedUrl", "menuTemplate", "parseDeepLink", "studioUrl",
  ],
  "dist/trace/desktop/config": ["resolveDesktopConfig"],
  "dist/cli/session": ["buildSession"],
  "dist/trace/server": ["startTraceServer"],
};

for (const [rel, exports] of Object.entries(REQUIRED)) {
  const mod = load(rel);
  if (!mod) continue;
  for (const name of exports) {
    if (typeof mod[name] === "undefined") problems.push(`${rel} does not export ${name}`);
  }
}

const FILES = [
  "desktop/main.js",
  "desktop/preload.js",
  "desktop/package.json",
  "dist/trace/studio/index.html",
  "dist/trace/studio/studio.js",
  "dist/trace/studio/studio.css",
];
for (const rel of FILES) {
  if (!fs.existsSync(path.join(root, rel))) problems.push(`missing ${rel}`);
}

// The shell binds menu clicks by id; a template that stopped declaring one
// would silently produce a dead menu item.
const shell = load("dist/trace/desktop/shell");
if (shell) {
  const template = JSON.stringify(shell.menuTemplate("darwin"));
  for (const id of shell.MENU_ACTION_IDS) {
    if (!template.includes(`"${id}"`)) problems.push(`menu template is missing the "${id}" item`);
  }
  const url = shell.studioUrl(4319, "tok");
  if (!url.includes("#token=")) problems.push("studioUrl no longer puts the token in the fragment");
}

// The shell serves Studio from disk; the shell HTML must reference the bundle
// that was actually built.
const indexHtml = path.join(root, "dist/trace/studio/index.html");
if (fs.existsSync(indexHtml)) {
  const html = fs.readFileSync(indexHtml, "utf8");
  if (!/studio\.js\?v=[a-f0-9]+/.test(html)) problems.push("index.html does not reference a stamped studio.js");
}

if (problems.length) {
  console.error("Desktop wiring problems:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("Desktop wiring OK — every require resolves, every export and asset is present.");
