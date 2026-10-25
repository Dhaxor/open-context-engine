import { describe, it, expect } from "vitest";
import { coerceIndexingSetting, readIndexingSettings, INDEXING_SETTING_KEYS } from "./indexing-settings";

describe("readIndexingSettings", () => {
  it("maps configuration keys onto the payload block with the documented defaults", () => {
    const config = new Map<string, unknown>([
      ["autoIndex", false],
      ["chunkSize", 40],
      ["chunkOverlap", 5],
    ]);
    const settings = readIndexingSettings({
      get: <T>(section: string, defaultValue: T): T => (config.has(section) ? config.get(section) as T : defaultValue),
    });
    expect(settings).toEqual({
      autoIndex: false,
      indexOnStartup: true,   // not overridden → default
      embedCache: true,       // not overridden → default
      chunkSize: 40,
      chunkOverlap: 5,
    });
  });
});

describe("coerceIndexingSetting", () => {
  it("accepts the five editable keys with well-formed values", () => {
    expect(coerceIndexingSetting("autoIndex", true)).toEqual({ key: "autoIndex", value: true });
    expect(coerceIndexingSetting("embedding.cache.enabled", false)).toEqual({ key: "embedding.cache.enabled", value: false });
    expect(coerceIndexingSetting("chunkSize", 120)).toEqual({ key: "chunkSize", value: 120 });
    expect(coerceIndexingSetting("chunkOverlap", 0)).toEqual({ key: "chunkOverlap", value: 0 });
    expect(coerceIndexingSetting("chunkSize", "120" as unknown)).toEqual({ key: "chunkSize", value: 120 }); // numeric strings coerce
  });

  it("rejects unknown keys — a crafted or buggy message cannot write arbitrary config", () => {
    expect(() => coerceIndexingSetting("llm.provider", "evil")).toThrow(/Unknown indexing setting/);
    expect(() => coerceIndexingSetting("__proto__", 1)).toThrow(/Unknown indexing setting/);
    expect(() => coerceIndexingSetting("", true)).toThrow(/Unknown indexing setting/);
  });

  it("rejects values that would corrupt the index", () => {
    expect(() => coerceIndexingSetting("chunkSize", 9)).toThrow(/at least 10/);
    expect(() => coerceIndexingSetting("chunkSize", 0)).toThrow();
    expect(() => coerceIndexingSetting("chunkSize", -5)).toThrow();
    expect(() => coerceIndexingSetting("chunkOverlap", -1)).toThrow(/cannot be negative/);
    expect(() => coerceIndexingSetting("chunkSize", 12.5)).toThrow(/whole number/);
    expect(() => coerceIndexingSetting("chunkSize", 10_000)).toThrow(/unreasonably large/);
    expect(() => coerceIndexingSetting("autoIndex", "yes" as unknown)).toThrow(/must be a boolean/);
  });

  it("lists exactly the keys the form edits", () => {
    expect(INDEXING_SETTING_KEYS).toEqual(["autoIndex", "indexOnStartup", "embedding.cache.enabled", "chunkSize", "chunkOverlap"]);
  });
});
