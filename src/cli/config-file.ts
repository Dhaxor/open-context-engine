import * as fs from "fs";
import * as path from "path";
import { licenseConfigDir } from "../core/license";

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
