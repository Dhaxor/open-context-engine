# Publishing the Open Context Engine extension

The extension ships a native SQLite binding (`better-sqlite3`) and a per-OS
SQLite extension (`sqlite-vec`). Both are platform-specific. Getting either
wrong reproduces the class of error a real user hit on first index
(`NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 137`). This doc
captures the publishing model and the constraints behind it.

## What we ship

| `--target` | OS | CPU | Runner | Status |
|---|---|---|---|---|
| `win32-x64` | Windows | x64 | `windows-latest` | ✅ Supported |
| `linux-x64` | Linux glibc ≥ 2.34 | x64 | `ubuntu-22.04` | ✅ Supported |
| `darwin-x64` | macOS 11+ | Intel | `macos-15-intel` | ✅ Supported (macos-13 was retired; `macos-26-intel` is the next Intel label) |
| `darwin-arm64` | macOS 11+ | Apple Silicon | `macos-latest` | ✅ Supported |
| `win32-arm64` | Windows 11 ARM | arm64 | — | ❌ See "Unsupported platforms" |
| `linux-arm64` | Linux glibc ≥ 2.34 | arm64 | `ubuntu-22.04-arm` | ✅ Supported |
| `alpine-*` | musl libc | — | — | ❌ See "Unsupported platforms" |

VS Code Marketplace serves the matching `.vsix` to each client automatically
based on `--target`. Clients on unsupported platforms see "No compatible
version" — *that is the intended fail mode* until we ship binaries for them.

## Why these constraints

- **One binary per platform serves every VS Code (0.4).** `better-sqlite3` 13
  is a Node-API addon, and its npm package carries a prebuilt binary for every
  platform. Node-API is ABI-stable, so the same binary loads in every Electron
  VS Code runs extensions in (37 in 1.103 through 43 in 1.139) and in plain
  Node on remote hosts (SSH, WSL, Codespaces), which run the extension host
  on VS Code Server's bundled Node. `engines.vscode` stays `^1.103.0`, and a
  new Electron in VS Code needs no rebuild and no republish.
  Before 0.4, each VSIX carried one binary per Electron ABI
  (`dist-native/abi-<N>/`) and copied the matching one into place at
  activation. Each Electron bump opened a `release-blocker` drift issue, and
  VS Code 1.139 (Electron 43, ABI 148) broke every build that lacked a
  rebuild for it.
- **The Linux glibc floor is 2.34** (Ubuntu 22.04 / RHEL 9 / Debian 12). It
  is set by the `better-sqlite3` prebuild (`GLIBC_2.34`, `GLIBCXX_3.4.29`);
  `sqlite-vec` needs only glibc 2.14. On an older host the binding fails to
  load, and activation reports "system glibc too old" instead of breaking
  mid-index.
- **The npm CLI stays on `better-sqlite3` 12.** The CLI's users include
  glibc < 2.34 hosts (Ubuntu 20.04 among them), where 12's prebuilds still
  load. The core code runs on both drivers, and CI proves it: the "Core suite
  on the extension's SQLite driver" job runs the whole core test suite
  against the extension's version.
- **Each `.vsix` is verified on a runner of its own platform.** Nothing is
  compiled, but the native smoke test runs the packaged binaries for real,
  which needs matching hardware.

## Unsupported platforms (and what users should do)

Each of these has a documented failure path in the extension's runtime
guard, so affected users get a specific error message instead of a silent
"indexing didn't happen."

| Platform | Reason | Workaround |
|---|---|---|
| `win32-arm64` | No `sqlite-vec-windows-arm64` package exists — the VSIX would ship without vector search | Install the `win32-x64` VSIX manually — Windows-on-ARM runs it under emulation with a perf hit. Or use VS Code's WSL backend with `linux-arm64`/`linux-x64`. |
| Alpine / musl | `sqlite-vec` publishes glibc builds only | Use a glibc-based devcontainer image (debian, ubuntu, fedora). |
| glibc < 2.34 | Below the `better-sqlite3` prebuild's floor | Upgrade the distribution, or use the CLI/MCP server (`npm install -g open-context-engine`), which supports older glibc. |

## Local: build one VSIX for your own platform

```bash
cd extension
npm ci
npm run package -- linux-x64          # → ../artifacts/open-context-engine-linux-x64-<version>.vsix
node ./scripts/verify-vsix.mjs ../artifacts/open-context-engine-linux-x64-*.vsix linux-x64
code --install-extension ../artifacts/open-context-engine-linux-x64-*.vsix
```

`npm run package -- <target>` runs `scripts/package-vsix.mjs`, the command
CI runs on every leg. It keeps only that target's `better-sqlite3` prebuild.
`verify-vsix.mjs` checks the packaged binaries' architecture and, on a host
of the same platform, runs a real store through the unpacked VSIX
(`scripts/smoke-native.cjs`: WAL, sqlite-vec KNN, FTS5). To try the binding
under a specific Electron:

```bash
ELECTRON_RUN_AS_NODE=1 npx electron@43.6.0 scripts/smoke-native.cjs .
```

F5 (the dev host) needs no native step: `better-sqlite3` loads its prebuild
straight from `node_modules`.

**Windows without Visual Studio: use `npm ci --ignore-scripts`.** Lockfiles
don't record better-sqlite3's `"gypfile": false`, so `npm ci` runs
`node-gyp rebuild` for it. `binding.gyp` makes that a no-op when a prebuild
exists, but on Windows node-gyp looks for Visual Studio's C++ workload first
and fails without it. Skipping install scripts loses nothing here: the
prebuild ships in the package, and esbuild's binary comes from its platform
package.

## CI: build all five supported platforms

`.github/workflows/release-vsix.yml` defines a 5-leg matrix. Every leg
packages, verifies, and runs the native smoke under Node and under Electron
37.2.3 (VS Code 1.103) and 43.6.0 (VS Code 1.139); linux-arm64 skips the
Electron run. Trigger paths:

- **Tag push** (`git tag v0.4.0 && git push origin v0.4.0`) → builds all 5
  platforms and publishes each to the Marketplace via `VSCE_PAT`. The same
  tag publishes the npm package (`npm-publish.yml`).
- **`workflow_dispatch`** with `publish: false` → builds all 5 without
  publishing. Useful for verifying a release before tagging.
- **PR touching `extension/**`** → builds and verifies all 5 as a smoke test.

The publish job runs on a single Ubuntu runner and loops `vsce publish
--packagePath` explicitly. We do not glob (PowerShell doesn't and the workflow
needs to be portable if we ever move it).

## Marketplace secrets

- `VSCE_PAT` — Azure DevOps personal access token with **Marketplace →
  Manage** scope and organization **All accessible organizations**, from the
  Microsoft account that owns the `open-context` publisher. Store it in repo
  settings → Secrets and variables → Actions → New repository secret. The
  publish job is the only consumer.
- **Azure DevOps retires global PATs on 1 December 2026.** After that date
  `VSCE_PAT` stops working, and publishing has to move to Microsoft Entra ID
  (`vsce publish --azure-credential` with workload identity federation). See
  the VS Code docs, "Publishing Extensions" → "Secure automated publishing".
