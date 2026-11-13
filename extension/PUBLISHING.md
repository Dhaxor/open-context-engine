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
| `win32-arm64` | No `sqlite-vec-windows-arm64` package exists — the VSIX would ship without vector search | Run the x64 build of VS Code, which Windows 11 on ARM runs under emulation (with a perf hit), and install the extension there — native arm64 VS Code can't load the x64 binary. Or use VS Code's WSL backend with `linux-arm64`/`linux-x64`. |
| Alpine / musl | `sqlite-vec` publishes glibc builds only | Use a glibc-based devcontainer image (debian, ubuntu, fedora). |
| glibc < 2.34 | Below the `better-sqlite3` prebuild's floor | Upgrade the distribution, or use the CLI/MCP server (`npm install -g @dhaxor/open-context` — the unscoped `open-context-engine` on npm is an unrelated package), which supports older glibc. |

## Local: build one VSIX for your own platform

```bash
cd extension
npm ci --ignore-scripts
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

**Why `--ignore-scripts`.** Lockfiles don't record better-sqlite3's
`"gypfile": false`, so a plain `npm ci` runs `node-gyp rebuild` for it.
`binding.gyp` makes that a no-op when a prebuild exists, but node-gyp still
has to find a compiler first. On Windows that means Visual Studio's C++
workload, and node-gyp 11 (Node 22's npm) doesn't recognise Visual Studio 18,
which is what `windows-latest` now ships. Skipping install scripts loses
nothing: the prebuild ships in the package, and esbuild's binary comes from
its platform package. CI installs the extension the same way.

## CI: build all five supported platforms

`.github/workflows/release-vsix.yml` defines a 5-leg matrix. Trigger paths:

- **Tag push** (`git tag v0.1.1 && git push origin v0.1.1`) → builds all 5
  platforms and publishes each to the Marketplace (via `VSCE_PAT`, or Entra
  ID — see "Marketplace secrets") and to Open VSX.
- **`workflow_dispatch`** with `publish: false` → builds all 5 without
  publishing. Useful for verifying a release before tagging.
- **PR touching `extension/**`** → builds and verifies all 5 as a smoke test.

Every leg packages its VSIX with `scripts/package-vsix.mjs`, verifies it, and
runs the native smoke under Node and under Electron 37.2.3 (VS Code 1.103)
and 43.6.0 (VS Code 1.139); linux-arm64 skips the Electron run. The same
`v*.*.*` tag also publishes the npm package (`npm-publish.yml`).

The publish job runs on a single Ubuntu runner and loops `vsce publish
--packagePath` explicitly. We do not glob (PowerShell doesn't and the workflow
needs to be portable if we ever move it).

## Marketplace secrets

Two ways to publish, switched by the repository **variable**
`MARKETPLACE_AUTH` (Settings → Secrets and variables → Actions → Variables):

| `MARKETPLACE_AUTH` | Job | Needs |
|---|---|---|
| unset | `publish` | `VSCE_PAT` secret |
| `entra` | `publish-entra` | `AZURE_CLIENT_ID` + `AZURE_TENANT_ID` secrets, the `marketplace` environment |

**`VSCE_PAT` has an end date.** vsce only accepts an Azure DevOps personal
access token scoped to *All accessible organizations* with **Marketplace →
Manage** — a *global* PAT — and Azure DevOps global PATs
[stop working on 1 December 2026](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/).
Set up Entra ID before then; until you flip the variable, releases keep using
the PAT.

### Entra ID (secure automated publishing)

The `publish-entra` job has no Marketplace token to leak or rotate. It signs
in to Microsoft Entra ID with GitHub's OIDC token (`azure/login`, workload
identity federation) as a user-assigned managed identity, and `vsce publish
--azure-credential` publishes as that identity — the
[secure automated publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing)
setup, on GitHub Actions.

1. **Managed identity and federated credential.** Create a user-assigned
   managed identity in any subscription and resource group, with no role
   assignments, and give it a federated credential for the `marketplace`
   environment. In Azure Cloud Shell:

   ```bash
   az identity create -g <resource-group> -n oce-marketplace-publisher
   az identity federated-credential create -g <resource-group> \
     --identity-name oce-marketplace-publisher --name github-marketplace \
     --issuer https://token.actions.githubusercontent.com \
     --subject repo:Dhaxor/open-context-engine:environment:marketplace \
     --audiences api://AzureADTokenExchange
   az identity show -g <resource-group> -n oce-marketplace-publisher \
     --query "{AZURE_CLIENT_ID: clientId, AZURE_TENANT_ID: tenantId}"
   ```

   Entra compares the subject exactly, with no wildcards — that's why it
   names the environment and not a tag. Use a managed identity, not an app
   registration: app registrations have been reported to pass `vsce
   verify-pat` and then fail the publish
   ([microsoft/vscode-vsce#1023](https://github.com/microsoft/vscode-vsce/issues/1023)).
2. **Repository secrets.** Add `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`.
3. **GitHub environment.** Create `marketplace` (Settings → Environments) and
   restrict it to the tag rule `v*.*.*`, so only release tags can get a token
   the credential trusts.
4. **Switch.** Set the repository variable `MARKETPLACE_AUTH` to `entra`.
5. **Publisher membership.** The Marketplace knows the identity by its Azure
   DevOps profile ID, which only a sign-in as the identity can read — so the
   first release does it: its *Check the identity is a publisher member*
   step prints `Marketplace member ID of this identity: <id>` and stops
   before uploading. Add that ID under *Members* at
   <https://marketplace.visualstudio.com/manage/publishers/open-context>
   with the **Contributor** role, then *Re-run failed jobs*.

If the sign-in fails with **`AADSTS70021`**, the token's subject differs from
the credential's — `azure/login` logs the subject it presented under
*Federated token details*. **`AADSTS700024`** means too long passed between
the sign-in and vsce; keep `azure/login` directly before the vsce steps.

## Open VSX

`publish-openvsx` publishes with the `OPEN_VSX_TOKEN` secret (an Open VSX
access token from <https://open-vsx.org/user-settings/tokens>), then asks the
public API until the release is listed and fails if it isn't after ten
minutes. An accepted upload can still be held — 0.7.0 was — so a failure
there means: sign in to Open VSX and check the extension's status under
Settings → Extensions.
