/**
 * Which language server to use, and how to find its binary.
 *
 * Discovery order per language: OCE_LSP_<LANG>_CMD env override, then PATH.
 * Nothing is auto-installed and nothing is required — the AST-graph lookup
 * remains the baseline whenever no server is present.
 */
import * as fs from "fs";
import * as path from "path";

export interface LspServerSpec { command: string; args: string[] }

export const LSP_SERVERS: Record<string, LspServerSpec[]> = {
  ".ts": [{ command: "typescript-language-server", args: ["--stdio"] }],
  ".tsx": [{ command: "typescript-language-server", args: ["--stdio"] }],
  ".js": [{ command: "typescript-language-server", args: ["--stdio"] }],
  ".jsx": [{ command: "typescript-language-server", args: ["--stdio"] }],
  ".mjs": [{ command: "typescript-language-server", args: ["--stdio"] }],
  ".py": [{ command: "pyright-langserver", args: ["--stdio"] }, { command: "pylsp", args: [] }],
  ".go": [{ command: "gopls", args: ["serve"] }],
  ".rs": [{ command: "rust-analyzer", args: [] }],
};

const ENV_OVERRIDE: Record<string, string> = {
  ".ts": "OCE_LSP_TS_CMD", ".tsx": "OCE_LSP_TS_CMD", ".js": "OCE_LSP_TS_CMD", ".mjs": "OCE_LSP_TS_CMD", ".jsx": "OCE_LSP_TS_CMD",
  ".py": "OCE_LSP_PY_CMD", ".go": "OCE_LSP_GO_CMD", ".rs": "OCE_LSP_RS_CMD",
};

/** Parse an OCE_LSP_*_CMD override: "npx --yes tsserver --stdio" → {command, args}.
 *  Quote-aware, because install paths routinely contain spaces on Windows. */
export function parseCommand(raw: string): LspServerSpec {
  const parts = raw.trim().match(/(?:[^\s"]+|"[^"]*")+/g)?.map(p => p.replace(/^"|"$/g, "")) ?? [];
  if (!parts.length) throw new Error("empty command");
  return { command: parts[0], args: parts.slice(1) };
}

/** True when `command` resolves on PATH (or is an existing absolute/relative
 *  path). Windows: PATHEXT-resolved (.cmd/.exe/.bat) count. X_OK is a POSIX
 *  concept — on Windows existence is the check. */
export function commandOnPath(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) {
    try { fs.accessSync(command); return true; } catch { return false; }
  }
  const pathVar = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const modes = process.platform === "win32" ? [fs.constants.F_OK] : [fs.constants.X_OK];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      for (const mode of modes) {
        try { fs.accessSync(path.join(dir, command + ext), mode); return true; } catch { /* next */ }
      }
    }
  }
  return false;
}

/** First available server for a file extension, or null. Env override wins
 *  even if PATH check fails (the user may point at a non-PATH binary). */
export function resolveServerCommand(ext: string): LspServerSpec | null {
  const override = ENV_OVERRIDE[ext] ? process.env[ENV_OVERRIDE[ext]] : undefined;
  if (override) return parseCommand(override);
  for (const spec of LSP_SERVERS[ext] ?? []) {
    if (commandOnPath(spec.command)) return spec;
  }
  return null;
}
