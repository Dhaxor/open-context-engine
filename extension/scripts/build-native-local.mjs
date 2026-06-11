// Local mirror of the release workflow's BINDING_TARGETS loop: produce
// dist-native/abi-<N>/better_sqlite3.node for every supported ABI so the
// F5 dev host and `vsce package` get the same multi-ABI bundle CI ships.
//
// Keep TARGETS in sync with BINDING_TARGETS in
// .github/workflows/release-vsix.yml (same dual-convention reasoning:
// Node prebuilds cover ABIs 127/137, Electron rebuilds cover 136/140).
//
// Node targets use better-sqlite3's official prebuilds — no compiler
// needed, always succeed. Electron targets need a local C++ toolchain;
// when one is missing we warn and continue, because the Node-convention
// ABIs are the ones real VS Code runtimes have been observed to request.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getAbi } = require("node-abi");

const TARGETS = [
  "electron:37.2.3",
  "electron:39.8.8",
  "node:22.16.0",
  // node:24 last on purpose — its binary stays in build/Release as the
  // default for environments that bypass the runtime selector.
  "node:24.15.0",
];

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bs3Dir = path.join(extRoot, "node_modules", "better-sqlite3");
const buildDir = path.join(bs3Dir, "build");
const builtBinding = path.join(buildDir, "Release", "better_sqlite3.node");
const distNative = path.join(extRoot, "dist-native");

fs.rmSync(distNative, { recursive: true, force: true });

let built = 0;
for (const target of TARGETS) {
  const [kind, version] = target.split(":");
  const abi = getAbi(version, kind);
  console.log(`\n=== better-sqlite3 for ${kind} ${version} (ABI ${abi}) ===`);
  // Clean slate per target — a stale config.gypi from the previous
  // iteration would defeat the ABI assertion below.
  fs.rmSync(buildDir, { recursive: true, force: true });
  try {
    if (kind === "electron") {
      execSync(`npx electron-rebuild -f -w better-sqlite3 -v ${version}`, {
        cwd: extRoot,
        stdio: "inherit",
      });
    } else {
      // Same order as CI: official prebuild first, source build against the
      // requested version's headers as the fallback (12.10 ships no Node-24
      // prebuild). --target is load-bearing: a bare build-release compiles
      // against the SHELL's Node and silently mislabels the ABI.
      try {
        execSync(`npx prebuild-install -r node -t ${version} -f`, {
          cwd: bs3Dir,
          stdio: "inherit",
        });
      } catch {
        console.warn(`No prebuild for node ${version}; compiling from source…`);
        execSync(`npm run build-release -- --target=${version}`, {
          cwd: bs3Dir,
          stdio: "inherit",
        });
      }
    }
  } catch (err) {
    console.warn(
      `WARN: build for ${target} (ABI ${abi}) failed — ${err.message}. ` +
        "Source builds need a C++20 toolchain (gcc 10+ / recent clang or MSVC); " +
        "any ABI that does build still lands in dist-native.",
    );
    continue;
  }
  // If this target went through a source build, config.gypi records which
  // headers were used — they must match the ABI we label the binary with.
  // Prebuilds leave no config.gypi; their download is keyed on the ABI.
  const gypi = path.join(buildDir, "config.gypi");
  if (fs.existsSync(gypi)) {
    const m = fs.readFileSync(gypi, "utf8").match(/"node_module_version": (\d+)/);
    if (!m || Number(m[1]) !== abi) {
      console.error(`ERROR: ABI mismatch for ${target}: built ${m?.[1] ?? "?"}, wanted ${abi}.`);
      process.exit(1);
    }
  }
  const dest = path.join(distNative, `abi-${abi}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(builtBinding, path.join(dest, "better_sqlite3.node"));
  built++;
}

if (built === 0) {
  console.error("ERROR: no native bindings could be built.");
  process.exit(1);
}
console.log(`\nDone: ${built}/${TARGETS.length} ABI bindings in ${distNative}`);
