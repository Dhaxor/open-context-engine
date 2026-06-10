# Publishing the Open Context Engine extension

The extension ships a native SQLite binding (`better-sqlite3`) and a per-OS
SQLite extension (`sqlite-vec`). Both are platform-specific *and*
ABI-specific. Getting either wrong reproduces the
`NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 137` error a real
user hit on first-index. This doc captures the publishing model and the
constraints behind it.

## What we ship

| `--target` | OS | CPU | Runner | Status |
|---|---|---|---|---|
| `win32-x64` | Windows | x64 | `windows-latest` | ✅ Supported |
| `linux-x64` | Linux glibc ≥ 2.35 | x64 | `ubuntu-22.04` | ✅ Supported |
| `darwin-x64` | macOS 11+ | Intel | `macos-13` | ✅ Supported until macos-13 retirement (see "Drift") |
| `darwin-arm64` | macOS 11+ | Apple Silicon | `macos-latest` | ✅ Supported |
| `win32-arm64` | Windows 11 ARM | arm64 | — | ❌ See "Unsupported platforms" |
| `linux-arm64` | Linux | arm64 | — | ❌ See "Unsupported platforms" |
| `alpine-*` | musl libc | — | — | ❌ See "Unsupported platforms" |

VS Code Marketplace serves the matching `.vsix` to each client automatically
based on `--target`. Clients on unsupported platforms see "No compatible
version" — *that is the intended fail mode* until we ship binaries for them.

## Why these constraints

- **`engines.vscode` is pinned to `^1.124.0`**. VS Code 1.124 ships
  Electron 42.3.0 (Node 24, `NODE_MODULE_VERSION` ≈ 137). The rebuilt
  `better-sqlite3` `.node` is locked to that ABI. Older VS Code uses
  Electron 37–41 (Node 22, NMV 127) — a single binary can't span both.
  Existing users on older VS Code stay on the previous `0.1.0` release.
- **Linux glibc floor is 2.35** (Ubuntu 22.04 / Debian 12 / RHEL 9). Building
  on `ubuntu-latest` would silently raise the floor to 2.39 and break RHEL 8
  + corporate-locked Ubuntu 22.04 with a cryptic `GLIBC_2.39 not found`
  loader error.
- **Each `.vsix` is built on a runner whose native arch matches `--target`.**
  Cross-compiling `better-sqlite3` against Electron headers for a foreign
  arch on a `ubuntu-latest` runner produces wrong-arch binaries without
  obvious failure. We don't do it.

## Unsupported platforms (and what users should do)

Each of these has a documented failure path in the extension's runtime
guard, so affected users get a specific error message instead of a silent
"indexing didn't happen."

| Platform | Reason | Workaround |
|---|---|---|
| `win32-arm64` | No `sqlite-vec-windows-arm64` build; `better-sqlite3` prebuild gaps | Install the `win32-x64` VSIX manually — Windows-on-ARM runs it under emulation with a perf hit. Or use VS Code's WSL backend with `linux-x64`. |
| `linux-arm64` | Cross-compile fragility on x64 GitHub runners; awaiting `ubuntu-24.04-arm` capacity | Use `oce` CLI / MCP server on a glibc-based arm64 host directly. |
| Alpine / musl | `better-sqlite3` is glibc-linked | Use a glibc-based devcontainer image (debian, ubuntu, fedora). |
| VS Code < 1.124 | Electron ABI mismatch | Stay on `open-context-engine@0.1.0`, or update VS Code to 1.124+. |

## Local: build one VSIX for your own platform

```bash
cd extension
npm ci
npm run rebuild              # @electron/rebuild → better_sqlite3.node for Electron 42.3.0
npx vsce package --target linux-x64 -o ../oce-linux-x64-local.vsix
node ./scripts/verify-vsix.mjs ../oce-linux-x64-local.vsix linux-x64
code --install-extension ../oce-linux-x64-local.vsix
```

This is the right loop for smoke-testing changes before pushing a tag.

## CI: build all four supported platforms

`.github/workflows/release-vsix.yml` defines a 4-leg matrix. Trigger paths:

- **Tag push** (`git tag v0.1.1 && git push origin v0.1.1`) → builds all 4
  platforms and publishes each to the Marketplace via `VSCE_PAT`.
- **`workflow_dispatch`** with `publish: false` → builds all 4 without
  publishing. Useful for verifying a release before tagging.
- **PR touching `extension/**`** → builds `linux-x64` only as a smoke test.

The publish job runs on a single Ubuntu runner and loops `vsce publish
--packagePath` explicitly. We do not glob (PowerShell doesn't and the workflow
needs to be portable if we ever move it).

## Drift detection

`.github/workflows/check-electron-drift.yml` runs daily, reads
`microsoft/vscode@main/.npmrc`, and opens a `release-blocker` issue when
upstream's Electron diverges from our pin. When that issue lands:

1. Verify the upstream Electron version actually reached a *stable* VS Code
   release (check the release notes' "shell version").
2. Bump in lockstep:
   - `extension/package.json` → `devDependencies.electron`
   - `extension/package.json` → `engines.vscode`
   - `extension/package.json` → `scripts.rebuild` (the `-v` flag)
   - `.github/workflows/release-vsix.yml` (the header comment)
3. Tag and let CI rebuild + republish all 4 platforms.

## What's coming in v0.2: multi-ABI bundling

To stop stranding users every Electron bump, v0.2 will ship multiple `.node`
binaries inside a single `.vsix` (one per supported Electron ABI), with a
runtime selector reading `process.versions.modules`. That removes the
`engines.vscode` floor as the gate and lets one VSIX cover a much wider VS
Code range. Out of scope for v0.1.1 because the runtime selector requires
patching `better-sqlite3`'s `bindings()` call site cleanly.

## Marketplace secrets

- `VSCE_PAT` — Azure DevOps personal access token with **Marketplace →
  Manage** scope, issued to the `open-context` publisher. Rotate yearly.
  Store in repo settings → Secrets and variables → Actions → New repository
  secret. The publish job is the only consumer.
