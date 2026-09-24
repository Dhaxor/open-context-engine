/**
 * The package version, read from package.json at runtime.
 *
 * It was hardcoded as "0.1.0" in two places — `oce --version` and the MCP
 * server's handshake — so both reported the wrong version for every release
 * after the first. package.json always ships in the npm tarball, and from
 * dist/ it sits two directories up, so reading it is reliable; tsc cannot
 * import it directly because it is outside rootDir.
 */

let cached: string | null = null;

export function packageVersion(): string {
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = String(require("../package.json").version ?? "0.0.0");
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
