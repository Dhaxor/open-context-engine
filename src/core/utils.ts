import { createHash } from "crypto";
import * as fs from "fs";
import * as nodePath from "path";

export function sha256(data: string | Buffer): string { return createHash("sha256").update(data).digest("hex"); }

export function computeBlobName(path: string, contents: string | Buffer): string {
  const h = createHash("sha256");
  h.update(path);
  h.update(typeof contents === "string" ? Buffer.from(contents, "utf8") : contents);
  return h.digest("hex");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return true;
  }
  return false;
}

export function isBinaryContent(contents: string | Buffer): boolean {
  return isBinaryBuffer(typeof contents === "string" ? Buffer.from(contents, "utf8") : contents);
}

const KEYISH = [
  /\.pem$/i, /\.key$/i, /\.pfx$/i, /\.p12$/i, /\.jks$/i, /\.keystore$/i, /\.pkcs12$/i, /\.crt$/i, /\.cer$/i,
  /^id_rsa$/, /^id_ed25519$/, /^id_ecdsa$/, /^id_dsa$/,
  // Credential dotfiles and secret stores — never index these.
  /^\.env(\..+)?$/i, /^\.npmrc$/, /^\.netrc$/i, /^\.pgpass$/, /^\.htpasswd$/, /^\.git-credentials$/,
  /^credentials$/i, /\.tfstate(\.backup)?$/, /^secrets?\.(json|ya?ml|toml|properties)$/i,
];
/** Directories whose entire contents are credential material. */
const KEYISH_DIRS = new Set([".aws", ".ssh", ".gnupg", ".kube", ".docker"]);
export function isKeyishPath(p: string): boolean {
  const segments = p.split("/");
  const b = segments.pop() || "";
  if (segments.some(s => KEYISH_DIRS.has(s.toLowerCase()))) return true;
  return KEYISH.some(r => r.test(b));
}

export class PathOutsideWorkspaceError extends Error {
  constructor(inputPath: string) {
    super(`Path outside workspace: ${inputPath}`);
    this.name = "PathOutsideWorkspaceError";
  }
}

function isInsidePath(root: string, candidate: string): boolean {
  const rel = nodePath.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

function deepestExistingPath(abs: string): string | null {
  let cur = abs;
  while (true) {
    if (fs.existsSync(cur)) return cur;
    const parent = nodePath.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Resolve a model/user supplied workspace-relative path and require that both
 * its normalized lexical path and its real path (for existing files or existing
 * parent directories) remain inside the workspace. Absolute paths and `..`
 * traversal are rejected even when they would resolve back into the workspace.
 */
export function resolveWorkspacePath(workspaceRoot: string, relPath: string): string {
  if (nodePath.isAbsolute(relPath)) throw new PathOutsideWorkspaceError(relPath);
  if (relPath.split(/[\\/]+/).includes("..")) throw new PathOutsideWorkspaceError(relPath);

  const normalized = nodePath.normalize(relPath);
  const absRoot = nodePath.resolve(workspaceRoot);
  const abs = nodePath.resolve(absRoot, normalized);
  if (!isInsidePath(absRoot, abs)) throw new PathOutsideWorkspaceError(relPath);

  const existing = deepestExistingPath(abs);
  if (existing) {
    const realRoot = fs.realpathSync.native(absRoot);
    const realExisting = fs.realpathSync.native(existing);
    if (!isInsidePath(realRoot, realExisting)) throw new PathOutsideWorkspaceError(relPath);
  }
  return abs;
}

/** @deprecated Use resolveWorkspacePath for agent/tool user paths. */
export function resolveInside(root: string, p: string): string {
  return resolveWorkspacePath(root, p);
}
export function formatResults(results: import("./types").SearchResult[]): string {
  if (!results.length) return "No results found.";
  return results.map(r => {
    const lines = r.chunk.contents.split("\n");
    const code = lines.map((l, i) => `${String(r.chunk.startLine + i).padStart(5)} │ ${l}`).join("\n");
    return `${r.chunk.path}:${r.chunk.startLine}-${r.chunk.endLine}\n${code}`;
  }).join("\n\n---\n\n");
}
