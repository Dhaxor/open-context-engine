import { classifyNativeBindingError } from "../../../src/core/native-binding-error";

/**
 * Native SQLite binding check at activation.
 *
 * better-sqlite3 13 is a Node-API addon, so there is no binding to select for
 * the running Electron ABI any more: one prebuilt binary per platform loads in
 * every Electron VS Code ships (37 in 1.103 through 43 in 1.139) and in plain
 * Node on remote hosts (SSH, WSL, Codespaces). Until 0.4 the VSIX carried one
 * binary per ABI and copied the matching one into place here — and every new
 * Electron in VS Code broke the extension until a rebuild shipped.
 *
 * What remains worth doing at activation is proving the binding loads, so a
 * host it can't run on (musl, a glibc older than the prebuild's, a wrong-arch
 * install) gets a clear error before anything touches the store.
 */

export interface BindingSelection {
  ok: boolean;
  /** "loaded" on success; otherwise the user-facing reason. */
  detail: string;
  abi: string;
}

export function ensureNativeBinding(): BindingSelection {
  const abi = process.versions.modules;
  try {
    // External to the bundle, so this resolves from the extension's own
    // node_modules — the same module the store loads.
    const Database = require("better-sqlite3");
    new Database(":memory:").close();
    return { ok: true, detail: "loaded", abi };
  } catch (err) {
    const diagnosis = classifyNativeBindingError(err);
    return { ok: false, abi, detail: diagnosis.message };
  }
}
