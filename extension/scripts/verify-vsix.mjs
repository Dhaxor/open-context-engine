#!/usr/bin/env node
/**
 * verify-vsix — make sure a packaged .vsix actually contains native binaries
 * matching its target (os, arch). Catches the silent failure mode where a
 * cross-compile produced the wrong arch, or where npm's optional-dep
 * platform filter skipped the sqlite-vec package we needed.
 *
 * Run from a CI matrix leg after `vsce package --target <target>`:
 *   node scripts/verify-vsix.mjs ../artifacts/open-context-engine-<target>.vsix <target>
 *
 * Expected: exit 0 with one OK line per checked binary.
 *           Any architecture mismatch is exit 1 with a clear "expected X, got Y".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

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
  // Expand-Archive on Windows runners.
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath "${vsixPath}" -DestinationPath "${stagingDir}" -Force`], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", "-o", vsixPath, "-d", stagingDir]);
  }

  const extensionRoot = path.join(stagingDir, "extension");
  const expectedBins = [];
  const sqliteVecPkgName = `sqlite-vec-${targetOs === "win32" ? "windows" : targetOs}-${targetArch}`;
  const vecSuffix = targetOs === "win32" ? "dll" : targetOs === "darwin" ? "dylib" : "so";

  expectedBins.push({
    label: "better-sqlite3 (default)",
    expected: path.join(extensionRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  });
  expectedBins.push({
    label: `sqlite-vec (${sqliteVecPkgName})`,
    expected: path.join(extensionRoot, "node_modules", sqliteVecPkgName, `vec0.${vecSuffix}`),
  });

  // Multi-ABI bundle: one better_sqlite3.node per supported Electron ABI.
  // A packaged VSIX without dist-native/abi-* would make the runtime selector
  // silently no-op — only one VS Code Electron line would work.
  const nativeDir = path.join(extensionRoot, "dist-native");
  const abiDirs = fs.existsSync(nativeDir)
    ? fs.readdirSync(nativeDir).filter(n => /^abi-\d+$/.test(n))
    : [];
  if (!abiDirs.length) {
    console.error("FAIL  dist-native: no abi-* directories in the VSIX — multi-ABI bundle missing.");
    process.exit(1);
  }
  console.log(`OK    dist-native: shipping ABIs ${abiDirs.map(d => d.slice(4)).join(", ")}`);
  for (const dirName of abiDirs) {
    expectedBins.push({
      label: `better-sqlite3 (${dirName})`,
      expected: path.join(nativeDir, dirName, "better_sqlite3.node"),
    });
  }

  let failed = false;
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

  if (failed) process.exit(1);
  console.log(`\nVerified ${path.basename(vsixPath)} against target ${target}.`);
} finally {
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
}
