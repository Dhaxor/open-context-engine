import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveDesktopConfig } from "./config";

let tmp: string | null = null;
afterEach(() => {
  if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function workspace(fileConfig?: unknown): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trace-cfg-"));
  if (fileConfig !== undefined) {
    fs.mkdirSync(path.join(tmp, ".open-context"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".open-context", "config.json"), JSON.stringify(fileConfig));
  }
  return tmp;
}

describe("resolveDesktopConfig", () => {
  it("defaults to voyage when nothing is configured", () => {
    const config = resolveDesktopConfig({ workspace: workspace(), env: {} });
    expect(config.embedding.provider).toBe("voyage");
    expect(config.embedding.model).toBe("voyage-code-3");
    expect(config.embedding.dimension).toBe(1024);
  });

  it("reads the workspace config file", () => {
    const ws = workspace({ embedding: { provider: "openai", model: "text-embedding-3-small" } });
    const config = resolveDesktopConfig({ workspace: ws, env: {} });
    expect(config.embedding.provider).toBe("openai");
    expect(config.embedding.model).toBe("text-embedding-3-small");
    expect(config.embedding.dimension).toBe(1536);
  });

  it("lets the environment win over the file", () => {
    const ws = workspace({ embedding: { provider: "voyage" } });
    const config = resolveDesktopConfig({ workspace: ws, env: { OCE_EMBEDDING_PROVIDER: "openai" } });
    expect(config.embedding.provider).toBe("openai");
  });

  it("lets an explicit override win over both", () => {
    const ws = workspace({ embedding: { provider: "voyage" } });
    const config = resolveDesktopConfig({
      workspace: ws, provider: "local",
      env: { OCE_EMBEDDING_PROVIDER: "openai" },
    });
    expect(config.embedding.provider).toBe("local");
  });

  it("picks up the right API key for the chosen provider", () => {
    const ws = workspace();
    expect(resolveDesktopConfig({ workspace: ws, provider: "openai", env: { OPENAI_API_KEY: "sk-o" } }).embedding.apiKey).toBe("sk-o");
    expect(resolveDesktopConfig({ workspace: ws, provider: "voyage", env: { VOYAGE_API_KEY: "vo" } }).embedding.apiKey).toBe("vo");
    // A voyage key must not leak into an openai config.
    expect(resolveDesktopConfig({ workspace: ws, provider: "openai", env: { VOYAGE_API_KEY: "vo" } }).embedding.apiKey).toBeUndefined();
  });

  it("falls back to the generic key variable", () => {
    const config = resolveDesktopConfig({ workspace: workspace(), provider: "voyage", env: { OCE_EMBEDDING_API_KEY: "generic" } });
    expect(config.embedding.apiKey).toBe("generic");
  });

  it("gives ollama a default base url", () => {
    const config = resolveDesktopConfig({ workspace: workspace(), provider: "ollama", env: {} });
    expect(config.embedding.baseUrl).toBe("http://localhost:11434");
  });

  it("maps a short model key to its fully-qualified id", () => {
    const ws = workspace({ embedding: { provider: "local", model: "all-MiniLM-L6-v2" } });
    expect(resolveDesktopConfig({ workspace: ws, env: {} }).embedding.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("passes an unknown model name through untouched", () => {
    const ws = workspace({ embedding: { provider: "ollama", model: "some-custom-model" } });
    const config = resolveDesktopConfig({ workspace: ws, env: {} });
    expect(config.embedding.model).toBe("some-custom-model");
    expect(config.embedding.dimension).toBe(1024);
  });

  it("carries search overrides through, and omits the key when there are none", () => {
    const withSearch = resolveDesktopConfig({ workspace: workspace({ search: { topK: 25 } }), env: {} });
    expect(withSearch.search).toEqual({ topK: 25 });
    expect(resolveDesktopConfig({ workspace: workspace(), env: {} }).search).toBeUndefined();
  });

  it("keeps the embedding cache on by default", () => {
    expect(resolveDesktopConfig({ workspace: workspace(), env: {} }).embedCache).toBe(true);
    expect(resolveDesktopConfig({ workspace: workspace({ embedCache: false }), env: {} }).embedCache).toBe(false);
  });

  it("survives a corrupt config file", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trace-cfg-"));
    fs.mkdirSync(path.join(tmp, ".open-context"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".open-context", "config.json"), "{ not json");
    expect(() => resolveDesktopConfig({ workspace: tmp!, env: {} })).not.toThrow();
  });
});
