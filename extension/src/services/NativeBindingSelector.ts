import * as fs from "fs";
import * as path from "path";
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
  /** On failure, the loader's own error and stack, for the Output channel. */
  raw?: string;
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
    const raw = diagnosis.raw || String(err);
    const mismatch = hostMismatch();
    if (mismatch) return { ok: false, abi, detail: mismatch, raw };
    const firstLine = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    // An unrecognized failure's canned message points at the Output channel;
    // lead with the real error so the toast alone says something useful.
    const detail = diagnosis.recognized ? diagnosis.message : `${firstLine} — ${diagnosis.message}`;
    return { ok: false, abi, detail, raw };
  }
}

/**
 * better-sqlite3 13 only ever loads prebuilds/<platform>-<arch>.node (linuxmusl-*
 * on musl) and otherwise falls back to a source build, which a VSIX never has —
 * so a host the package has no binary for fails with "Cannot find module".
 * That reads as a broken install; say what is actually wrong.
 */
function hostMismatch(): string | undefined {
  try {
    const dir = path.join(path.dirname(require.resolve("better-sqlite3/package.json")), "prebuilds");
    const shipped = fs.readdirSync(dir).filter(f => f.endsWith(".node")).map(f => f.slice(0, -".node".length));
    const report = (process as any).report?.getReport?.();
    const musl = process.platform === "linux" && report && !report.header?.glibcVersionRuntime;
    const host = `${musl ? "linuxmusl" : process.platform}-${process.arch}`;
    if (!shipped.length || shipped.includes(host)) return undefined;
    if (musl) {
      return "Alpine / musl Linux isn't supported yet. Use a glibc-based image (Debian, Ubuntu, Fedora) for this workspace.";
    }
    return `This copy of the extension is built for ${shipped.join(", ")}, but this machine is ${host}. ` +
      "Install the build for this platform from the Marketplace (reinstall the extension and let VS Code pick it).";
  } catch {
    return undefined;
  }
}
