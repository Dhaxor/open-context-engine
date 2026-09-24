#!/usr/bin/env node
// Package one platform's VSIX — the same command CI runs for each matrix leg:
//
//   node scripts/package-vsix.mjs <target> [outDir]      (outDir: ../artifacts)
//
// better-sqlite3 13 ships a Node-API prebuild for every platform inside its npm
// package. .vscodeignore drops them all; this adds one negation for the
// target's own binary. vsce's negations are order-insensitive — any matching
// `!pattern` wins — so appending it to a copy of .vscodeignore is enough.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
const [target, outDir = "../artifacts"] = process.argv.slice(2);
if (!TARGETS.includes(target)) {
  console.error(`Usage: package-vsix.mjs <${TARGETS.join("|")}> [outDir]`);
  process.exit(2);
}

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prebuild = path.join(extRoot, "node_modules", "better-sqlite3", "prebuilds", `${target}.node`);
if (!fs.existsSync(prebuild)) {
  console.error(`No better-sqlite3 prebuild for ${target} at ${prebuild}. Run npm ci in extension/.`);
  process.exit(1);
}

// Outside the extension root, so the generated file can't end up in the VSIX.
const ignoreFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oce-vsix-")), ".vscodeignore");
fs.writeFileSync(
  ignoreFile,
  fs.readFileSync(path.join(extRoot, ".vscodeignore"), "utf8") +
    `\n# Added by scripts/package-vsix.mjs for --target ${target}\n!node_modules/better-sqlite3/prebuilds/${target}.node\n`,
);

// Run vsce's own CLI with this Node rather than through npx: npx is npx.cmd on
// Windows, which needs a shell, and a shell would split paths with spaces.
const require = createRequire(import.meta.url);
const vscePkg = require.resolve("@vscode/vsce/package.json", { paths: [extRoot] });
const vsce = path.join(path.dirname(vscePkg), JSON.parse(fs.readFileSync(vscePkg, "utf8")).bin.vsce);

const out = path.resolve(extRoot, outDir);
fs.mkdirSync(out, { recursive: true });
try {
  execFileSync(process.execPath, [vsce, "package", "--target", target, "--ignoreFile", ignoreFile, "--out", out + path.sep], {
    cwd: extRoot,
    stdio: "inherit",
  });
} finally {
  fs.rmSync(path.dirname(ignoreFile), { recursive: true, force: true });
}
