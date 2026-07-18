import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadFileConfig, mergeFileConfigs } from "./config-file";

let ws: string;
let userDir: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "oce-cfg-ws-"));
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-cfg-user-"));
  fs.mkdirSync(path.join(ws, ".open-context"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
});

describe("mergeFileConfigs", () => {
  it("merges per-section with next winning field-by-field", () => {
    const merged = mergeFileConfigs(
      { embedding: { provider: "voyage", model: "voyage-code-3" }, chunkSize: 100 },
      { embedding: { provider: "local" }, llm: { provider: "ollama" } },
    );
    expect(merged.embedding).toEqual({ provider: "local", model: "voyage-code-3" });
    expect(merged.llm?.provider).toBe("ollama");
    expect(merged.chunkSize).toBe(100);
  });
});

describe("loadFileConfig", () => {
  it("workspace config overrides user config", () => {
    fs.writeFileSync(path.join(userDir, "config.json"), JSON.stringify({ embedding: { provider: "openai" }, chunkSize: 60 }));
    fs.writeFileSync(path.join(ws, ".open-context", "config.json"), JSON.stringify({ embedding: { provider: "local" } }));
    const { config, sources } = loadFileConfig(ws, { userDir });
    expect(config.embedding?.provider).toBe("local"); // workspace wins
    expect(config.chunkSize).toBe(60);                 // user survives where unset
    expect(sources).toHaveLength(2);
  });

  it("collects warnings for malformed JSON and embedded api keys", () => {
    fs.writeFileSync(path.join(userDir, "config.json"), "{nope");
    fs.writeFileSync(path.join(ws, ".open-context", "config.json"), JSON.stringify({ embedding: { apiKey: "sk-leak" } }));
    const { warnings } = loadFileConfig(ws, { userDir });
    expect(warnings.some(w => w.includes("invalid JSON"))).toBe(true);
    expect(warnings.some(w => w.includes("apiKey"))).toBe(true);
  });

  it("returns an empty config when no files exist", () => {
    const { config, sources } = loadFileConfig(ws, { userDir });
    expect(sources).toEqual([]);
    expect(config.embedding ?? {}).toEqual({});
  });
});
