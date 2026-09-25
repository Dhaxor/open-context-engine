#!/usr/bin/env node
/**
 * verify-vsix — make sure a packaged .vsix actually contains native binaries
 * matching its target (os, arch). Catches the silent failure mode where a
 * cross-compile produced the wrong arch, or where npm's optional-dep
 * platform filter skipped the sqlite-vec package we needed.
 *
 * Run from a CI matrix leg after `scripts/package-vsix.mjs <target>`:
 *   node scripts/verify-vsix.mjs ../artifacts/open-context-engine-<target>.vsix <target>
 *
 * Expected: exit 0 with one OK line per checked binary.
 *           Any architecture mismatch is exit 1 with a clear "expected X, got Y".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const [vsixPath, target] = process.argv.slice(2);
if (!vsixPath || !target) {
  console.error("Usage: verify-vsix.mjs <path-to-vsix> <target> (e.g. linux-x64, win32-x64, darwin-arm64)");
  process.exit(2);
}
if (!fs.existsSync(vsixPath)) {
  console.error(`VSIX not found: ${vsixPath}`);
  process.exit(2);
}

const [targetOs, targetArch] = target.split("-");
if (!targetOs || !targetArch) {
  console.error(`Bad --target shape: "${target}". Expected "<os>-<arch>" like "linux-x64".`);
  process.exit(2);
}

// The bytes we expect to see at the start of each native binary, keyed by the
// vsce --target value. `file` output strings vary by version/locale, so we also
// fall back to magic-byte inspection.
const ARCH_RULES = {
  "linux-x64":     { magic: ["7f454c46"], extraDescriptors: ["ELF 64", "x86-64", "x86_64"], badDescriptors: ["aarch64", "arm64", "i386"] },
  "linux-arm64":   { magic: ["7f454c46"], extraDescriptors: ["ELF 64", "aarch64", "ARM aarch64"], badDescriptors: ["x86-64", "x86_64", "i386"] },
  "darwin-x64":    { magic: ["cffaedfe", "feedfacf"], extraDescriptors: ["Mach-O 64-bit", "x86_64"], badDescriptors: ["arm64"] },
  "darwin-arm64":  { magic: ["cffaedfe", "feedfacf"], extraDescriptors: ["Mach-O 64-bit", "arm64"], badDescriptors: ["x86_64"] },
  "win32-x64":     { magic: ["4d5a"], extraDescriptors: ["PE32+", "x86-64", "x86_64"], badDescriptors: ["Aarch64", "ARM"] },
  "win32-arm64":   { magic: ["4d5a"], extraDescriptors: ["PE32+", "ARM64", "Aarch64"], badDescriptors: ["x86-64", "x86_64"] },
};
const rule = ARCH_RULES[target];
if (!rule) {
  console.error(`No verification rule for target "${target}". Add one to verify-vsix.mjs.`);
  process.exit(2);
}

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-verify-"));
try {
  // VSIX is a zip; use the bundled `unzip` on *nix, and PowerShell's
  // Expand-Archive on Windows runners. Expand-Archive (PS 5.1) refuses any
  // file extension other than .zip, so stage a .zip-named copy first.
  if (process.platform === "win32") {
    const zipCopy = path.join(stagingDir, "_vsix_copy.zip");
    fs.copyFileSync(vsixPath, zipCopy);
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath "${zipCopy}" -DestinationPath "${stagingDir}" -Force`], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", "-o", vsixPath, "-d", stagingDir]);
  }

  const extensionRoot = path.join(stagingDir, "extension");
  const expectedBins = [];
  const sqliteVecPkgName = `sqlite-vec-${targetOs === "win32" ? "windows" : targetOs}-${targetArch}`;
  const vecSuffix = targetOs === "win32" ? "dll" : targetOs === "darwin" ? "dylib" : "so";

  // better-sqlite3 13 is Node-API: one prebuild serves every Electron and
  // Node ABI, loaded from prebuilds/<platform>-<arch>.node by its own loader.
  const bs3Dir = path.join(extensionRoot, "node_modules", "better-sqlite3");
  expectedBins.push({
    label: "better-sqlite3 (Node-API prebuild)",
    expected: path.join(bs3Dir, "prebuilds", `${target}.node`),
  });
  expectedBins.push({
    label: `sqlite-vec (${sqliteVecPkgName})`,
    expected: path.join(extensionRoot, "node_modules", sqliteVecPkgName, `vec0.${vecSuffix}`),
  });

  let failed = false;

  // Exactly this target's prebuild: the package carries all eight platforms,
  // and scripts/package-vsix.mjs keeps only one. The C++ sources, the SQLite
  // amalgamation and node-gyp's build/ are source-build material; the loader
  // takes the prebuild whenever it exists.
  const prebuilds = fs.existsSync(path.join(bs3Dir, "prebuilds")) ? fs.readdirSync(path.join(bs3Dir, "prebuilds")) : [];
  if (prebuilds.length !== 1 || prebuilds[0] !== `${target}.node`) {
    console.error(`FAIL  better-sqlite3 prebuilds: expected exactly ${target}.node, found [${prebuilds.join(", ") || "none"}].`);
    failed = true;
  } else {
    console.log(`OK    better-sqlite3 prebuilds: exactly ${target}.node.`);
  }
  for (const sourceOnly of ["deps", "src", "build", "binding.gyp"]) {
    if (fs.existsSync(path.join(bs3Dir, sourceOnly))) {
      console.error(`FAIL  better-sqlite3/${sourceOnly} shipped: source-build input, excluded by .vscodeignore.`);
      failed = true;
    }
  }
  if (fs.existsSync(path.join(extensionRoot, "dist-native"))) {
    console.error("FAIL  dist-native/ shipped: per-ABI bindings from before 0.4, excluded by .vscodeignore.");
    failed = true;
  }

  for (const { label, expected } of expectedBins) {
    if (!fs.existsSync(expected)) {
      console.error(`FAIL  ${label}: not found at ${path.relative(stagingDir, expected)}`);
      failed = true;
      continue;
    }
    const magic = fs.readFileSync(expected).slice(0, 4).toString("hex");
    let info = "";
    try { info = execFileSync("file", ["-b", expected], { encoding: "utf8" }).trim(); } catch { info = "(file(1) unavailable)"; }
    const magicMatch = rule.magic.some(m => magic.startsWith(m));
    const descriptorMatch = rule.extraDescriptors.some(s => info.includes(s));
    const conflictingDescriptor = rule.badDescriptors.find(s => info.includes(s));
    if (!magicMatch) {
      console.error(`FAIL  ${label}: magic ${magic} doesn't match any of ${rule.magic.join(", ")} for ${target} — ${info}`);
      failed = true;
    } else if (conflictingDescriptor) {
      console.error(`FAIL  ${label}: file reports "${conflictingDescriptor}" which conflicts with ${target} — ${info}`);
      failed = true;
    } else if (!descriptorMatch) {
      console.warn(`WARN  ${label}: file output didn't match any expected descriptor ${rule.extraDescriptors.join(", ")} — ${info}. Magic OK; continuing.`);
    } else {
      console.log(`OK    ${label}: ${info}`);
    }
  }

  // Sanity: there should be exactly one sqlite-vec-* package, and it must match the target.
  const nmDir = path.join(extensionRoot, "node_modules");
  const vecPkgs = fs.existsSync(nmDir)
    ? fs.readdirSync(nmDir).filter(n => /^sqlite-vec-[a-z]+-[a-z0-9]+$/.test(n))
    : [];
  if (vecPkgs.length !== 1) {
    console.error(`FAIL  sqlite-vec packages: expected exactly 1 in the VSIX, found ${vecPkgs.length} (${vecPkgs.join(", ") || "none"}).`);
    failed = true;
  } else if (vecPkgs[0] !== sqliteVecPkgName) {
    console.error(`FAIL  sqlite-vec packages: expected ${sqliteVecPkgName}, found ${vecPkgs[0]}.`);
    failed = true;
  } else {
    console.log(`OK    sqlite-vec packages: exactly ${sqliteVecPkgName}.`);
  }

  // --- VSIX-diet guards (the .vscodeignore prunes ~60 MB; these prove the
  // pruning never cuts into the runtime) -----------------------------------

  // 1) tree-sitter grammars: exactly the languages languageForPath() can
  //    request (src/core/ast-graph-shared.ts). A new language needs BOTH the
  //    .vscodeignore negation and this list updated.
  const EXPECTED_WASMS = [
    "typescript", "tsx", "javascript", "python", "go", "rust", "java", "c_sharp",
    "c", "cpp", "ruby", "php", "kotlin", "swift",
  ];
  const wasmDir = path.join(nmDir, "tree-sitter-wasms", "out");
  const shippedWasms = fs.existsSync(wasmDir)
    ? fs.readdirSync(wasmDir).filter(f => f.endsWith(".wasm")).map(f => f.replace(/^tree-sitter-/, "").replace(/\.wasm$/, "")).sort()
    : [];
  const expectedSorted = [...EXPECTED_WASMS].sort();
  if (JSON.stringify(shippedWasms) !== JSON.stringify(expectedSorted)) {
    console.error(`FAIL  tree-sitter grammars: shipped [${shippedWasms.join(", ")}], expected [${expectedSorted.join(", ")}].`);
    failed = true;
  } else {
    console.log(`OK    tree-sitter grammars: exactly the ${EXPECTED_WASMS.length} supported languages.`);
  }

  // 2) build-time-only renderer deps must be pruned (they live inside
  //    dist/webview.js; shipping them is dead weight).
  for (const pruned of ["highlight.js", "markdown-it"]) {
    if (fs.existsSync(path.join(nmDir, pruned))) {
      console.error(`FAIL  pruned package shipped: ${pruned} should be excluded by .vscodeignore.`);
      failed = true;
    }
  }

  // 3) Runtime require check: every pure-JS external dist/extension.js loads
  //    must be fully loadable from the extracted tree — this walks transitive
  //    deps for real, so an over-aggressive exclusion fails HERE, not on a
  //    user's machine.
  const req = createRequire(path.join(extensionRoot, "noop.js"));
  for (const mod of ["chokidar", "minimatch", "ignore", "openai", "web-tree-sitter"]) {
    try {
      req(mod);
      console.log(`OK    runtime require: ${mod}`);
    } catch (err) {
      console.error(`FAIL  runtime require: ${mod} — ${err.message}`);
      failed = true;
    }
  }

  // 4) Native smoke: load both native modules from the extracted tree and run
  //    a real store through them (WAL, vec0 KNN, FTS5) under this Node — the
  //    runtime remote extension hosts use. It needs a host of the target's own
  //    platform, which every CI leg is; the release workflow repeats it under
  //    Electron for desktop VS Code.
  const hostTarget = `${process.platform}-${process.arch}`;
  if (hostTarget === target) {
    const smoke = path.join(path.dirname(fileURLToPath(import.meta.url)), "smoke-native.cjs");
    try {
      execFileSync(process.execPath, [smoke, extensionRoot], { stdio: "inherit" });
    } catch {
      failed = true; // smoke-native.cjs printed the FAIL line
    }
  } else {
    for (const mod of ["better-sqlite3", "sqlite-vec"]) {
      try {
        req.resolve(mod);
        console.log(`OK    runtime resolve: ${mod}`);
      } catch (err) {
        console.error(`FAIL  runtime resolve: ${mod} — ${err.message}`);
        failed = true;
      }
    }
    console.log(`SKIP  native smoke: this host is ${hostTarget}, the VSIX is ${target}.`);
  }

  if (failed) process.exit(1);
  console.log(`\nVerified ${path.basename(vsixPath)} against target ${target}.`);
} finally {
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
}
