import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { File, FreshnessReport, GitState, IndexMetadata } from "./types";
import { computeBlobName } from "./utils";

export function compareFreshness(
  files: File[],
  knownHashes: Map<string, string>,
  metadata: IndexMetadata | null,
  currentGit: GitState,
  maxPaths = 50,
): FreshnessReport {
  const seen = new Set<string>();
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const file of files) {
    seen.add(file.path);
    const hash = computeBlobName(file.path, file.contents);
    const prev = knownHashes.get(file.path);
    if (!prev) added.push(file.path);
    else if (prev !== hash) changed.push(file.path);
  }
  for (const p of knownHashes.keys()) {
    if (!seen.has(p)) removed.push(p);
  }

  const indexedGit = metadata?.git;
  const gitChanged = didGitChange(indexedGit, currentGit);
  const reasons: string[] = [];
  if (!metadata?.lastIndexedAt) reasons.push("Index has no successful sync metadata yet");
  if (added.length) reasons.push(`${added.length} new file${added.length === 1 ? "" : "s"}`);
  if (changed.length) reasons.push(`${changed.length} changed file${changed.length === 1 ? "" : "s"}`);
  if (removed.length) reasons.push(`${removed.length} removed file${removed.length === 1 ? "" : "s"}`);
  if (gitChanged) reasons.push("Git branch/commit changed since last index");

  const stale = reasons.length > 0;
  return {
    state: stale ? "stale" : "fresh",
    stale,
    checkedAt: Date.now(),
    lastIndexedAt: metadata?.lastIndexedAt,
    added: added.slice(0, maxPaths),
    changed: changed.slice(0, maxPaths),
    removed: removed.slice(0, maxPaths),
    hiddenPathCount: Math.max(0, added.length + changed.length + removed.length - maxPaths * 3),
    reasons,
    git: { indexed: indexedGit, current: currentGit, changed: gitChanged },
  };
}

export async function getGitState(workspaceRoot: string): Promise<GitState> {
  const gitDir = await resolveGitDir(workspaceRoot);
  if (!gitDir) return { available: false };
  const [branch, commit] = await Promise.all([
    git(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(workspaceRoot, ["rev-parse", "HEAD"]),
  ]);
  return {
    available: Boolean(branch || commit),
    branch: branch || undefined,
    commit: commit || undefined,
    gitDir,
  };
}

export async function resolveGitDir(workspaceRoot: string): Promise<string | null> {
  const dotGit = path.join(workspaceRoot, ".git");
  try {
    const st = await fs.promises.stat(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      const text = await fs.promises.readFile(dotGit, "utf8");
      const m = text.match(/^gitdir:\s*(.+)$/m);
      if (m) return path.resolve(workspaceRoot, m[1].trim());
    }
  } catch {}
  return null;
}

function didGitChange(indexed: GitState | undefined, current: GitState): boolean {
  if (!indexed?.available || !current.available) return false;
  if (indexed.branch && current.branch && indexed.branch !== current.branch) return true;
  if (indexed.commit && current.commit && indexed.commit !== current.commit) return true;
  return false;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", cwd, ...args], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const out = stdout.trim();
      resolve(out || undefined);
    });
    child.on("error", () => resolve(undefined));
  });
}
