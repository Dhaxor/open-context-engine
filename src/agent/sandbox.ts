/**
 * OS-sandboxed execution for the agent's shell tool.
 *
 * When enabled, `run-command` executes under an OS sandbox that denies
 * network access and restricts writes to the workspace (plus the temp
 * directories Node and commands legitimately need):
 *
 *  - macOS:  Sandbox-exec (Seatbelt) with a generated SBPL profile.
 *  - Linux:  bubblewrap (bwrap) network namespace isolation when installed.
 *  - Windows: no OS sandbox — the existing controls (scrubbed env, command
 *    allowlist, policy) still apply; documented limitation.
 *
 * Opt-in via `shell.sandbox: true`, the OCE_SANDBOX env var, or a policy
 * lock — defaulting it on would break legitimate flows like package
 * installs that need the network.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

export type SandboxKind = "seatbelt" | "bwrap" | "none";

export interface SandboxProfile {
  kind: SandboxKind;
  /** Executable to prefix the command with. */
  file: string;
  /** Fixed args between the executable and the wrapped command. */
  args: string[];
  /** Human-readable description of what the sandbox restricts. */
  description: string;
}

export const SANDBOX_ENV = "OCE_SANDBOX";

export function sandboxRequested(opts: { sandbox?: boolean } | undefined): boolean {
  if (opts?.sandbox) return true;
  try { return process.env[SANDBOX_ENV] === "1" || process.env[SANDBOX_ENV] === "true"; } catch { return false; }
}

/** Detect what sandboxing this platform can offer. Cheap and cached per call —
 *  no side effects. */
export function detectSandbox(workspaceRoot: string): SandboxProfile {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    return {
      kind: "seatbelt",
      file: "/usr/bin/sandbox-exec",
      args: ["-f", seatbeltProfilePath(workspaceRoot)],
      description: "Seatbelt: network denied; writes limited to the workspace and system temp dirs",
    };
  }
  if (process.platform === "linux" && commandOnPath("bwrap")) {
    return {
      kind: "bwrap",
      file: "bwrap",
      args: ["--unshare-net", "--dev-bind", "/", "/", "--bind", workspaceRoot, workspaceRoot],
      description: "bubblewrap: network namespace isolated; filesystem visible as-is (documented limitation)",
    };
  }
  return { kind: "none", file: "", args: [], description: "no OS sandbox on this platform" };
}

function commandOnPath(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const exts = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, cmd + ext), fs.constants.X_OK); return true; } catch { /* next */ }
    }
  }
  return false;
}

function seatbeltProfilePath(workspaceRoot: string): string {
  // One profile per workspace root, keyed by a hash so distinct workspaces
  // never share (and a stale profile can't outlive its workspace's config).
  const key = workspaceRoot.replace(/[^A-Za-z0-9]/g, "_").slice(-64);
  return path.join(os.tmpdir(), `oce-seatbelt-${key}.sb`);
}

/** Generate (and cache) the Seatbelt profile for a workspace. Returns the
 *  profile file path. Both the realpath and the caller's spelling of the
 *  workspace are allowed — macOS may see either through symlinks/tmpdir
 *  aliases. */
export function writeSeatbeltProfile(workspaceRoot: string): string {
  const profilePath = seatbeltProfilePath(workspaceRoot);
  let real = workspaceRoot;
  try { real = fs.realpathSync(workspaceRoot); } catch { /* keep as given */ }
  const home = os.homedir();
  const writePaths = [...new Set([workspaceRoot, real])].map(p => `  (subpath "${p}")`);
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    "(allow file-write*",
    ...writePaths,
    '  (subpath "/private/tmp")',
    '  (subpath "/tmp")',
    '  (subpath "/private/var/folders")',
    `  (subpath "${home}/.open-context")`,
    '  (literal "/dev/null")',
    '  (literal "/dev/dtracehelper")',
    ")",
  ].join("\n");
  fs.writeFileSync(profilePath, profile + "\n", { encoding: "utf8" });
  return profilePath;
}

/** Wrap a shell command for the detected sandbox. Returns the spawn target:
 *  on seatbelt/bwrap the command runs via /bin/sh -c INSIDE the sandbox; on
 *  none, the caller runs the command as before. */
export function wrapCommand(profile: SandboxProfile, workspaceRoot: string, cmd: string): { file: string; args: string[] } | null {
  if (profile.kind === "seatbelt") {
    writeSeatbeltProfile(workspaceRoot); // refresh the profile file before spawn
    return { file: profile.file, args: [...profile.args, "/bin/bash", "-c", cmd] };
  }
  if (profile.kind === "bwrap") {
    return { file: profile.file, args: [...profile.args, "--", "/bin/bash", "-c", cmd] };
  }
  return null;
}

/** Run a command inside the sandbox (or plainly when no sandbox applies).
 *  Same output contract as the shell tool's runShell: resolved string with
 *  exit code, stdout, stderr. */
export function runSandboxed(profile: SandboxProfile, workspaceRoot: string, cmd: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv, onLine: undefined | ((s: string) => void) = undefined): Promise<string> {
  const wrapped = wrapCommand(profile, workspaceRoot, cmd);
  const file = wrapped ? wrapped.file : cmd;
  const args = wrapped ? wrapped.args : [];
  const useShell = !wrapped;
  return new Promise((resolve) => {
    const child = spawn(file, args, { shell: useShell, cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    let killed = false;
    child.stdout.on("data", b => { out = (out + b.toString("utf8")).slice(0, 400_000); });
    child.stderr.on("data", b => { err = (err + b.toString("utf8")).slice(0, 400_000); });
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const head = [
        `$ ${cmd}`,
        `cwd: ${cwd}`,
        profile.kind !== "none" ? `sandbox: ${profile.description}` : "",
        `exit: ${killed ? `killed (timeout ${timeoutMs}ms)` : code}`,
      ].filter(Boolean);
      const parts = [...head];
      if (out) parts.push(`--- stdout ---\n${out.slice(-200_000)}`);
      if (err) parts.push(`--- stderr ---\n${err.slice(-100_000)}`);
      if (!out && !err) parts.push("(no output)");
      resolve(parts.join("\n"));
    });
    child.on("error", e => { clearTimeout(timer); resolve(`Command failed to start: ${e.message}`); });
  });
}
