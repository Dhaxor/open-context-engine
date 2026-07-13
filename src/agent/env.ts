import * as os from "os";
import { execSync } from "child_process";

/**
 * Environment context block for the system prompt — the harness equivalent of
 * a pilot's instrument panel. Grounding the model in platform/git/index facts
 * up front eliminates a whole class of wasted tool calls ("what OS is this?",
 * "what branch am I on?") and wrong-shell command suggestions.
 */

export interface EnvironmentInfo {
  platform: string;
  nodeVersion: string;
  cwd: string;
  date: string;
  git?: { branch: string; dirtyFiles: number };
  index?: { chunks: number; files?: number; searchMode: string };
}

export function collectEnvironment(workspaceRoot: string, index?: { chunks: number; files?: number; searchMode: string }): EnvironmentInfo {
  const info: EnvironmentInfo = {
    platform: `${process.platform} ${os.release()} (${os.arch()})`,
    nodeVersion: process.version,
    cwd: workspaceRoot,
    date: new Date().toISOString().slice(0, 10),
    ...(index ? { index } : {}),
  };
  try {
    const run = (cmd: string) => execSync(cmd, { cwd: workspaceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim();
    const branch = run("git rev-parse --abbrev-ref HEAD");
    const dirty = run("git status --porcelain").split("\n").filter(Boolean).length;
    info.git = { branch, dirtyFiles: dirty };
  } catch {
    // not a git repo / git missing — omit
  }
  return info;
}

export function renderEnvironment(info: EnvironmentInfo): string {
  const lines = [
    "## Environment",
    `- Platform: ${info.platform} · node ${info.nodeVersion}`,
    `- Working directory: ${info.cwd}`,
    `- Date: ${info.date}`,
  ];
  if (info.git) lines.push(`- Git: branch ${info.git.branch}${info.git.dirtyFiles ? ` (${info.git.dirtyFiles} uncommitted change${info.git.dirtyFiles === 1 ? "" : "s"})` : " (clean)"}`);
  if (info.index) lines.push(`- Index: ${info.index.chunks} chunks${info.index.files ? ` across ${info.index.files} files` : ""} · ${info.index.searchMode} search`);
  return lines.join("\n");
}

/** Convenience provider for AgentConfig.environmentProvider. */
export function environmentProvider(workspaceRoot: string, getIndex?: () => { chunks: number; files?: number; searchMode: string } | undefined): () => string {
  return () => renderEnvironment(collectEnvironment(workspaceRoot, getIndex?.()));
}
