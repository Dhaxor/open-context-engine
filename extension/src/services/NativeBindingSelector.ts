import * as fs from "fs";
import * as path from "path";

/**
 * Multi-ABI native-binding selector.
 *
 * The packaged VSIX ships one better_sqlite3.node per supported Electron ABI
 * under dist-native/abi-<N>/ (built by the release workflow's
 * ELECTRON_TARGETS loop). better-sqlite3 itself always loads from
 * node_modules/better-sqlite3/build/Release/better_sqlite3.node, so at
 * activation we copy the binding matching THIS VS Code's ABI
 * (process.versions.modules) into that location — once, marker-guarded.
 *
 * This is what lets one VSIX span VS Code 1.103 → current instead of pinning
 * engines.vscode to a single Electron line and stranding everyone else.
 */

export interface BindingSelection {
  ok: boolean;
  /** What happened: "single-abi-build" (dev/F5, no dist-native), "already-current",
   *  "selected" (copied), or an error reason when ok=false. */
  detail: string;
  abi: string;
}

export function ensureNativeBinding(extensionRoot: string): BindingSelection {
  const abi = process.versions.modules;
  const nativeDir = path.join(extensionRoot, "dist-native");
  // Dev builds (F5) and tests run straight from node_modules with whatever
  // ABI the local rebuild produced — nothing to select.
  if (!fs.existsSync(nativeDir)) return { ok: true, detail: "single-abi-build", abi };

  const candidate = path.join(nativeDir, `abi-${abi}`, "better_sqlite3.node");
  if (!fs.existsSync(candidate)) {
    let shipped: string[] = [];
    try { shipped = fs.readdirSync(nativeDir).filter(n => n.startsWith("abi-")).map(n => n.slice(4)); } catch {}
    return {
      ok: false,
      abi,
      detail:
        `This VS Code's Electron uses Node ABI ${abi}, but this build ships bindings for ABI ${shipped.join(", ") || "(none)"} only. ` +
        `Update VS Code (or the extension) to a matching version — see PUBLISHING.md for the supported range.`,
    };
  }

  const targetDir = path.join(extensionRoot, "node_modules", "better-sqlite3", "build", "Release");
  const target = path.join(targetDir, "better_sqlite3.node");
  const marker = path.join(targetDir, ".abi");

  try {
    if (fs.existsSync(target) && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === abi) {
      return { ok: true, detail: "already-current", abi };
    }
    fs.mkdirSync(targetDir, { recursive: true });
    // Copy to a temp name then rename: another VS Code window activating
    // concurrently must never observe a half-written .node.
    const tmp = target + `.tmp-${process.pid}`;
    fs.copyFileSync(candidate, tmp);
    fs.renameSync(tmp, target);
    fs.writeFileSync(marker, abi);
    return { ok: true, detail: "selected", abi };
  } catch (err: any) {
    return {
      ok: false,
      abi,
      detail: `Failed to install the ABI-${abi} binding: ${err?.message ?? String(err)}. ` +
        `The extension directory may be read-only; try reinstalling the extension.`,
    };
  }
}
