import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveConfig, validateConfig, staticEmbedder, withStoreOptions } from "./config";
import { createCliIo } from "./io";

/**
 * resolveConfig is the front door every store command walks through: file
 * config, environment, flags, and the keyword-only fallback that decides
 * whether a brand-new user's first command works at all.
 */

const ENV_KEYS = ["OPENAI_API_KEY", "VOYAGE_API_KEY", "OLLAMA_BASE_URL", "OCE_EMBEDDING_PROVIDER", "OCE_EMBEDDING_BASE_URL", "OCE_EMBEDDING_API_KEY"] as const;
let saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-cli-cfg-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function ioWith(warnings: string[]) {
  return createCliIo({ out: () => {}, err: (s) => { warnings.push(s); } });
}

describe("resolveConfig", () => {
  it("falls back to keyword-only (with one notice) when nothing is configured", () => {
    const warnings: string[] = [];
    const io = ioWith(warnings);
    const first = resolveConfig({ workspace: dir }, io);
    expect(first.keywordOnly).toBe("fallback");
    expect(first.embedding.provider).toBe("voyage");
    expect(warnings.filter(w => w.includes("keyword search"))).toHaveLength(1);
    resolveConfig({ workspace: dir }, io);
    expect(warnings.filter(w => w.includes("keyword search"))).toHaveLength(1); // once per process
  });

  it("provider none is an explicit keyword-only choice with no notice", () => {
    const warnings: string[] = [];
    const config = resolveConfig({ workspace: dir, provider: "none" }, ioWith(warnings));
    expect(config.keywordOnly).toBe("explicit");
    expect(warnings).toHaveLength(0);
  });

  it("flags win over the environment, and the environment over files", () => {
    process.env.OPENAI_API_KEY = "env-key";
    fs.mkdirSync(path.join(dir, ".open-context"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".open-context", "config.json"), JSON.stringify({
      embedding: { provider: "ollama", model: "file-model", baseUrl: "http://file:11434" },
    }));
    const config = resolveConfig({ workspace: dir, provider: "openai", model: "text-embedding-3-small", apiKey: "flag-key" }, ioWith([]));
    expect(config.embedding.provider).toBe("openai");
    expect(config.embedding.apiKey).toBe("flag-key");
    const fromEnv = resolveConfig({ workspace: dir, provider: "openai" }, ioWith([]));
    expect(fromEnv.embedding.apiKey).toBe("env-key");
  });

  it("reads provider, model, and baseUrl from the workspace config file", () => {
    fs.mkdirSync(path.join(dir, ".open-context"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".open-context", "config.json"), JSON.stringify({
      embedding: { provider: "ollama", model: "nomic-embed-text", baseUrl: "http://file-host:11434" },
    }));
    const config = resolveConfig({ workspace: dir }, ioWith([]));
    expect(config.embedding.provider).toBe("ollama");
    expect(config.embedding.model).toBe("nomic-embed-text");
    expect(config.embedding.baseUrl).toBe("http://file-host:11434");
    expect(config.keywordOnly).toBeUndefined();
  });

  it("missing OPENAI_API_KEY fails loudly when embeddings are actually required", () => {
    expect(() => resolveConfig({ workspace: dir, provider: "openai" }, ioWith([]))).toThrow(/OPENAI_API_KEY is required/);
    expect(() => validateConfig({ workspaceRoot: dir, embedding: { provider: "ollama", model: "m", baseUrl: undefined as any } })).toThrow(/OLLAMA_BASE_URL is required/);
  });

  it("numeric store options parse from flags and default from files", () => {
    const config = resolveConfig({ workspace: dir, provider: "none", chunkSize: "40", maxFileSize: "5000" }, ioWith([]));
    expect(config.chunkSize).toBe(40);
    expect(config.maxFileSize).toBe(5000);
    expect(config.chunkOverlap).toBeUndefined();
  });

  it("the static embedder reports the configured identity and refuses to embed", async () => {
    const standIn = staticEmbedder({ provider: "voyage", model: "voyage-code-3", dimension: 1024, batchSize: 32 });
    expect(standIn.getDimension()).toBe(1024);
    expect(standIn.getModel()).toBe("voyage-code-3");
    await expect(standIn.embed(["x"])).rejects.toThrow(/does not embed/);
  });

  it("withStoreOptions decorates a command with the shared store flags", () => {
    const { Command } = require("commander");
    const cmd = withStoreOptions(new Command("x"));
    const names = cmd.options.map(o => o.long);
    expect(names).toEqual(["--store-path", "--chunk-size", "--chunk-overlap", "--max-file-size"]);
  });
});
