import * as fs from "fs";
import * as path from "path";
import { licenseConfigDir } from "../core/license";
import type { McpServerConfig } from "../agent/mcp-client";

/**
 * File-based configuration for the CLI, so teams stop threading flags/env
 * vars through every invocation:
 *
 *   ~/.open-context/config.json          (user defaults; $OCE_CONFIG_DIR aware)
 *   <workspace>/.open-context/config.json (project settings — commit it)
 *
 * Precedence, lowest → highest: user file → workspace file → env vars → flags.
 * Secrets do NOT belong here: apiKey is intentionally absent from the schema —
 * keys come from env vars or --api-key, never a committable file.
 */

export interface OceFileConfig {
  embedding?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
  llm?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
  };
  search?: {
    topK?: number;
    minScore?: number;
  };
  chunkSize?: number;
  chunkOverlap?: number;
  maxFileSize?: number;
  storePath?: string;
  embedCache?: boolean | string;
  /** MCP servers the agent can use, in the shape every client uses. Read from
   *  the USER file only — see loadUserMcpServers. */
  mcpServers?: Record<string, McpServerConfig>;
}

export interface LoadedFileConfig {
  config: OceFileConfig;
  /** Files that contributed, in merge order. */
  sources: string[];
  warnings: string[];
}

function readOne(file: string, warnings: string[]): OceFileConfig | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`${file}: not a JSON object — ignored`);
      return null;
    }
    if ((parsed as any).embedding?.apiKey || (parsed as any).llm?.apiKey) {
      warnings.push(`${file}: apiKey in a config file is ignored — use env vars or --api-key (files get committed; keys must not)`);
    }
    return parsed as OceFileConfig;
  } catch (e: any) {
    warnings.push(`${file}: invalid JSON (${e?.message ?? e}) — ignored`);
    return null;
  }
}

/** Shallow-merge per section; `next` wins field-by-field. Exported for tests. */
export function mergeFileConfigs(base: OceFileConfig, next: OceFileConfig): OceFileConfig {
  return {
    embedding: { ...base.embedding, ...next.embedding },
    llm: { ...base.llm, ...next.llm },
    search: { ...base.search, ...next.search },
    chunkSize: next.chunkSize ?? base.chunkSize,
    chunkOverlap: next.chunkOverlap ?? base.chunkOverlap,
    maxFileSize: next.maxFileSize ?? base.maxFileSize,
    storePath: next.storePath ?? base.storePath,
    embedCache: next.embedCache ?? base.embedCache,
  };
}

/**
 * The MCP servers the agent may start. User file only: a server is a program
 * the agent launches, and a repository you cloned must not be able to launch
 * programs by committing a config. A workspace file's `mcpServers` is
 * reported and ignored.
 */
export function loadUserMcpServers(workspaceRoot: string, opts: { userDir?: string } = {}): { servers: Record<string, McpServerConfig>; warnings: string[] } {
  const warnings: string[] = [];
  const userFile = path.join(opts.userDir ?? licenseConfigDir(), "config.json");
  const wsFile = path.join(workspaceRoot, ".open-context", "config.json");
  const user = readOne(userFile, warnings);
  const ws = readOne(wsFile, []);
  if (ws?.mcpServers && Object.keys(ws.mcpServers).length) {
    warnings.push(`${wsFile}: mcpServers is ignored here — the agent only starts MCP servers listed in ${userFile}, so a cloned repository can't start programs.`);
  }
  const raw = user?.mcpServers;
  if (!raw) return { servers: {}, warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`${userFile}: mcpServers must be an object of { name: { command, args } | { url } } — ignored`);
    return { servers: {}, warnings };
  }
  return { servers: raw, warnings };
}

export function loadFileConfig(workspaceRoot: string, opts: { userDir?: string } = {}): LoadedFileConfig {
  const warnings: string[] = [];
  const sources: string[] = [];
  let config: OceFileConfig = {};
  const userFile = path.join(opts.userDir ?? licenseConfigDir(), "config.json");
  const wsFile = path.join(workspaceRoot, ".open-context", "config.json");
  for (const file of [userFile, wsFile]) {
    const parsed = readOne(file, warnings);
    if (parsed) {
      config = mergeFileConfigs(config, parsed);
      sources.push(file);
    }
  }
  return { config, sources, warnings };
}
