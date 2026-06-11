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
| `linux-arm64` | Linux glibc ≥ 2.35 | arm64 | `ubuntu-22.04-arm` | ✅ Supported |
| `alpine-*` | musl libc | — | — | ❌ See "Unsupported platforms" |

VS Code Marketplace serves the matching `.vsix` to each client automatically
based on `--target`. Clients on unsupported platforms see "No compatible
version" — *that is the intended fail mode* until we ship binaries for them.

## Why these constraints

- **`engines.vscode` is `^1.103.0`, served by multi-ABI bundling (v0.2).**
  Each platform VSIX ships one `better_sqlite3.node` per supported Electron
  ABI under `dist-native/abi-<N>/`, built by the workflow's
  `ELECTRON_TARGETS` loop (currently Electron 37.x / 39.x / 42.x — covering
  stable VS Code 1.103 → current). At activation,
  `NativeBindingSelector` copies the binding matching the running VS Code's
  `process.versions.modules` into better-sqlite3's load path; the copy is
  marker-guarded (`.abi` file) and atomic (temp + rename) so concurrent
  windows can't observe a half-written binary. Empirical Electron map (from
  `microsoft/vscode` release branches' `.npmrc` target): 1.103–1.106 → 37.x,
  1.107–1.121 → 39.x, 1.122+ → 42.x.
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
| `win32-arm64` | No `sqlite-vec-windows-arm64` package exists — the VSIX would ship without vector search | Install the `win32-x64` VSIX manually — Windows-on-ARM runs it under emulation with a perf hit. Or use VS Code's WSL backend with `linux-arm64`/`linux-x64`. |
| Alpine / musl | `better-sqlite3` is glibc-linked | Use a glibc-based devcontainer image (debian, ubuntu, fedora). |
| VS Code < 1.103 | Electron ABI not in the shipped set | Update VS Code to 1.103+, or build locally with `npm run rebuild -v <your electron>`. The activation error names the running ABI and the shipped ABIs. |

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

## CI: build all five supported platforms

`.github/workflows/release-vsix.yml` defines a 5-leg matrix. Trigger paths:

- **Tag push** (`git tag v0.1.1 && git push origin v0.1.1`) → builds all 5
  platforms and publishes each to the Marketplace via `VSCE_PAT`.
- **`workflow_dispatch`** with `publish: false` → builds all 5 without
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
2. **Append** the new Electron version to `ELECTRON_TARGETS` in
   `.github/workflows/release-vsix.yml` (don't replace — old ABIs keep
   covering old VS Code), and bump `devDependencies.electron` +
   `scripts.rebuild`'s `-v` flag for local dev builds.
3. Tag and let CI rebuild + republish all 5 platforms. No `engines.vscode`
   change needed — the floor only moves when you *drop* an old ABI.

## Multi-ABI bundling (how it works)

- CI loops `ELECTRON_TARGETS`, running `@electron/rebuild` once per version
  and stashing each binding at `dist-native/abi-<N>/better_sqlite3.node`
  (ABI numbers from `node-abi`, never hardcoded).
- `verify-vsix.mjs` fails the build if a packaged VSIX lacks `dist-native`
  or any binding's architecture mismatches the target.
- At activation, `extension/src/services/NativeBindingSelector.ts` copies
  the matching binding over `node_modules/better-sqlite3/build/Release/`.
  Dev builds (F5 — no `dist-native/`) skip selection entirely and use
  whatever the local `npm run rebuild` produced.
- If the running ABI isn't shipped (VS Code too old/new), activation stops
  with a named-ABI error and an "Open Output" action instead of a broken
  half-activated extension.

VSIX size cost: ~3-5 MB per extra ABI per platform — well under limits.

## Marketplace secrets

- `VSCE_PAT` — Azure DevOps personal access token with **Marketplace →
  Manage** scope, issued to the `open-context` publisher. Rotate yearly.
  Store in repo settings → Secrets and variables → Actions → New repository
  secret. The publish job is the only consumer.
