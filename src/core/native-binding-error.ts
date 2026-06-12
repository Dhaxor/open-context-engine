/**
 * Classify native-binding failures we know how to talk about.
 *
 * better-sqlite3 + sqlite-vec are the two native dependencies the engine needs
 * to load at startup. They can fail to load for several distinct reasons, each
 * with a specific user remedy. Until v0.1.1 we surfaced all of these as a
 * one-line "rebuild better-sqlite3" hint in the health panel and *swallowed*
 * them at the VS Code startup-index catch site — neither was right.
 *
 * This function takes the raw error and returns a structured diagnosis the
 * caller can render. It treats `process.versions.electron` as the cue for
 * whether we're inside VS Code's Electron host or in plain Node (CLI / MCP),
 * so the remedy text matches the user's actual surface.
 */

export type NativeBindingErrorKind =
  | "node_module_version"     // .node built for a different Node ABI than the runtime
  | "glibc_too_old"           // .node references a newer glibc than the host provides
  | "musl_libc"               // .node is glibc-linked but the host is musl (Alpine)
  | "wrong_arch"              // ELF class / Mach-O magic mismatch (e.g. arm64 binary on x64 host)
  | "sqlite_vec_platform"     // sqlite-vec's per-OS optional dep is missing for this host
  | "missing_module"          // require/import couldn't resolve the package at all
  | "unknown";                // didn't match any known pattern — show raw message

export interface NativeBindingDiagnosis {
  kind: NativeBindingErrorKind;
  /** One-line headline suitable for showErrorMessage / status. */
  title: string;
  /** Multi-line user-facing explanation including the remedy. */
  message: string;
  /** True when we recognized a known failure mode and the message is precise. */
  recognized: boolean;
  /** The raw original error text — preserved for the Output channel / health report. */
  raw: string;
}

const NMV_RE = /NODE_MODULE_VERSION/i;
const NMV_NUMBERS_RE = /NODE_MODULE_VERSION\s+(\d+)[^0-9]+(\d+)/i;
const GLIBC_RE = /GLIBC_[\d.]+|version `GLIBC/i;
const MUSL_RE = /ld-musl|musl-libc|ld-linux\.so\.2(?:[^a-zA-Z0-9]|$)/i;
const ARCH_RE = /wrong ELF class|wrong architecture|incompatible architecture|invalid ELF header|Bad CPU type/i;
const SQLITE_VEC_PLATFORM_RE = /Could not locate sqlite-vec native extension|sqlite-vec-[a-z]+-[a-z0-9]+/i;
const MISSING_MODULE_RE = /Cannot find module|MODULE_NOT_FOUND/i;

function isElectron(): boolean {
  return typeof process !== "undefined" && Boolean(process.versions && (process.versions as any).electron);
}

function runtimeLabel(): string {
  if (isElectron()) return `VS Code (Electron ${(process.versions as any).electron}, Node ABI ${process.versions.modules})`;
  return `Node ${process.versions.node} (ABI ${process.versions.modules})`;
}

export function classifyNativeBindingError(err: unknown): NativeBindingDiagnosis {
  const raw = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);

  // NODE_MODULE_VERSION — the headline reason the .vsix breaks today.
  if (NMV_RE.test(raw)) {
    const m = raw.match(NMV_NUMBERS_RE);
    const ours = m?.[1], theirs = m?.[2];
    const detail = ours && theirs ? ` (binary is built for ABI ${ours}, this runtime needs ABI ${theirs})` : "";
    if (isElectron()) {
      return {
        kind: "node_module_version",
        title: "Open Context Engine: native binding ABI mismatch",
        message:
          `The bundled native SQLite binding doesn't match this VS Code's Electron runtime${detail}. ` +
          `This usually means your VS Code version is outside the range this extension was built for. ` +
          `Update VS Code to the latest stable and reload the window, or install a matching extension build from the GitHub Releases page.`,
        recognized: true,
        raw,
      };
    }
    return {
      kind: "node_module_version",
      title: "Open Context Engine: native binding ABI mismatch",
      message:
        `The native SQLite binding was compiled for a different Node version than the one running this process${detail}. ` +
        `Run \`npm rebuild better-sqlite3\` against ${runtimeLabel()}, or reinstall under the matching Node.`,
      recognized: true,
      raw,
    };
  }

  // glibc symbol versioning — Linux, common on RHEL / Rocky / older Ubuntu.
  if (GLIBC_RE.test(raw)) {
    return {
      kind: "glibc_too_old",
      title: "Open Context Engine: system glibc too old",
      message:
        `The native SQLite binding requires a newer glibc than this Linux distribution provides. ` +
        `This extension's Linux builds target glibc 2.35+ (Ubuntu 22.04 / RHEL 9 / Debian 12 or newer). ` +
        `Please upgrade your distribution or run the CLI/MCP variant of Open Context Engine on a newer host.`,
      recognized: true,
      raw,
    };
  }

  // musl libc — typically Alpine.
  if (MUSL_RE.test(raw)) {
    return {
      kind: "musl_libc",
      title: "Open Context Engine: musl / Alpine Linux not yet supported",
      message:
        `The native SQLite binding is built against glibc and won't load on a musl-libc host (e.g. Alpine, ` +
        `Alpine-based devcontainers). Use a glibc-based image (debian/ubuntu/fedora) or file an issue if Alpine support matters to you.`,
      recognized: true,
      raw,
    };
  }

  // Mach-O / ELF arch mismatch.
  if (ARCH_RE.test(raw)) {
    return {
      kind: "wrong_arch",
      title: "Open Context Engine: native binding architecture mismatch",
      message:
        `The native SQLite binding is for a different CPU architecture than this machine ` +
        `(host arch: ${process.arch}, ${process.platform}). ` +
        `This usually means the wrong platform-specific extension build was installed. ` +
        `Reinstall the extension and let the Marketplace pick the matching architecture, ` +
        `or download the correct .vsix from GitHub Releases.`,
      recognized: true,
      raw,
    };
  }

  // sqlite-vec's per-platform .so/.dll/.dylib couldn't be located.
  if (SQLITE_VEC_PLATFORM_RE.test(raw)) {
    return {
      kind: "sqlite_vec_platform",
      title: `Open Context Engine: no sqlite-vec build for ${process.platform}-${process.arch}`,
      message:
        `sqlite-vec ships per-platform native extensions and none was found for this machine ` +
        `(${process.platform}-${process.arch}). This typically means you're on a platform we don't ` +
        `yet ship binaries for (e.g. win32-arm64, linux-armhf, Alpine). ` +
        `The engine continues in keyword-only (BM25) search mode — indexing and search still work, ` +
        `but without semantic ranking. See PUBLISHING.md for the supported (os, arch) matrix.`,
      recognized: true,
      raw,
    };
  }

  // Couldn't resolve the package itself — usually a packaging bug, not the user's problem.
  if (MISSING_MODULE_RE.test(raw)) {
    return {
      kind: "missing_module",
      title: "Open Context Engine: native dependency missing from the install",
      message:
        `A required native dependency is missing from this extension install. ` +
        `Reinstall the extension; if that doesn't help, file an issue with the contents of the Output channel.`,
      recognized: true,
      raw,
    };
  }

  return {
    kind: "unknown",
    title: "Open Context Engine: failed to load native SQLite binding",
    message:
      `An unexpected error occurred initializing the native SQLite binding. Open the Output channel ` +
      `("Open Context Engine") for the full error, and please file an issue with it attached.`,
    recognized: false,
    raw,
  };
}

/** Convenience for one-line health-report style notes. */
export function diagnosisOneLiner(d: NativeBindingDiagnosis): string {
  return d.recognized ? d.title : d.title + " — see Output channel for details";
}
