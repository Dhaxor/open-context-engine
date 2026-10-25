/**
 * The Indexing settings section: which openContext.* settings it edits, how
 * values from the webview are validated, and the payload the host sends back.
 * Pure by design — no vscode import — so the contract is unit-testable.
 */

export const INDEXING_SETTING_KEYS = ["autoIndex", "indexOnStartup", "embedding.cache.enabled", "chunkSize", "chunkOverlap"] as const;
export type IndexingSettingKey = (typeof INDEXING_SETTING_KEYS)[number];

export const BOOLEAN_INDEXING_SETTINGS: ReadonlySet<IndexingSettingKey> = new Set(["autoIndex", "indexOnStartup", "embedding.cache.enabled"]);

export interface IndexingSettingsPayload {
  type: "indexingSettings";
  settings: {
    autoIndex: boolean;
    indexOnStartup: boolean;
    embedCache: boolean;
    chunkSize: number;
    chunkOverlap: number;
  };
  status: {
    workspaceRoot: string;
    indexedFiles: number;
    totalChunks: number;
    searchMode: string;
    degradedReason?: string;
    embeddingProvider: string;
    embeddingModel: string;
  };
}

/** Map a workspace configuration view onto the payload's settings block. */
export function readIndexingSettings(config: {
  get<T>(section: string, defaultValue: T): T;
}): IndexingSettingsPayload["settings"] {
  return {
    autoIndex: config.get("autoIndex", true),
    indexOnStartup: config.get("indexOnStartup", true),
    embedCache: config.get("embedding.cache.enabled", true),
    chunkSize: config.get("chunkSize", 80),
    chunkOverlap: config.get("chunkOverlap", 15),
  };
}

/**
 * Validate and coerce a webview-sent setting. Throws on an unknown key or a
 * value that would corrupt the index (non-positive chunk sizes, fractional or
 * negative overlap) — the host reports the error instead of writing it.
 */
export function coerceIndexingSetting(key: string, value: unknown): { key: IndexingSettingKey; value: boolean | number } {
  if (!(INDEXING_SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown indexing setting: ${key}`);
  }
  const typedKey = key as IndexingSettingKey;
  if (BOOLEAN_INDEXING_SETTINGS.has(typedKey)) {
    if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    return { key: typedKey, value };
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num)) throw new Error(`${key} must be a whole number`);
  if (typedKey === "chunkSize" && num < 10) throw new Error("chunkSize must be at least 10 lines");
  if (typedKey === "chunkOverlap" && num < 0) throw new Error("chunkOverlap cannot be negative");
  if (num > 400) throw new Error(`${key} is unreasonably large (max 400)`);
  return { key: typedKey, value: num };
}
