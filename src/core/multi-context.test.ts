import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MultiContext } from "./multi-context";
import { OpenContextConfig } from "./types";
import { EmbeddingProvider } from "./embedder";

/**
 * MultiContext is exported on the public API but had no callers and no tests.
 * These pin its contract: per-workspace isolation, fused cross-repo search
 * with [id] prefixes, scoped search, aggregation, and lifecycle.
 */

const DIM = 4;

function mockEmbedder(): EmbeddingProvider {
  return {
    embed: async (texts: string[]) => texts.map((_, i) => {
      const v = [0, 0, 0, 0];
      v[i % DIM] = 1;
      return v;
    }),
    getDimension: () => DIM,
    getModel: () => "mock",
  };
}

const tmpDirs: string[] = [];
function makeWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-multi-"));
  tmpDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

function config(root: string): OpenContextConfig {
  return {
    workspaceRoot: root,
    storePath: path.join(root, ".store"),
    embedding: { provider: "ollama", model: "mock", dimension: DIM, batchSize: 32 },
    embedder: mockEmbedder(),
  };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

describe("MultiContext", () => {
  it("indexes and searches across workspaces with fused, prefixed results", async () => {
    const left = makeWorkspace({ "alpha.ts": "export function alphaWidget() { return 1; }\n" });
    const right = makeWorkspace({ "beta.ts": "export function betaWidget() { return 2; }\n" });
    const mc = new MultiContext();
    await await mc.addWorkspace("left", config(left));
    await await mc.addWorkspace("right", config(right));
    try {
      const resultsByRepo = await mc.indexAll();
      expect(resultsByRepo.get("left")!.newlyIndexed).toContain("alpha.ts");
      expect(resultsByRepo.get("right")!.newlyIndexed).toContain("beta.ts");

      const results = await mc.search("widget", { topK: 10 });
      expect(results.length).toBeGreaterThan(1);
      const paths = results.map(r => r.chunk.path);
      expect(paths.some(p => p.startsWith("[left] ") && p.includes("alpha.ts"))).toBe(true);
      expect(paths.some(p => p.startsWith("[right] ") && p.includes("beta.ts"))).toBe(true);
    } finally {
      mc.close();
    }
  });

  it("scopes search to the requested workspaces", async () => {
    const left = makeWorkspace({ "alpha.ts": "export function scopedLeft() { return 1; }\n" });
    const right = makeWorkspace({ "beta.ts": "export function scopedRight() { return 2; }\n" });
    const mc = new MultiContext();
    await mc.addWorkspace("left", config(left));
    await mc.addWorkspace("right", config(right));
    try {
      await mc.indexAll();
      const results = await mc.search("scoped", { workspaceIds: ["left"], topK: 10 });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        // Single-target search takes the direct path: no prefix is added.
        expect(r.chunk.path).not.toContain("[right]");
        expect(r.chunk.path).not.toContain("[left]");
      }
      const none = await mc.search("scoped", { workspaceIds: ["missing"], topK: 10 });
      expect(none).toEqual([]);
    } finally {
      mc.close();
    }
  });

  it("removes a workspace, closing its store and dropping it from search", async () => {
    const left = makeWorkspace({ "alpha.ts": "export function goneSoon() { return 1; }\n" });
    const mc = new MultiContext();
    await mc.addWorkspace("left", config(left));
    try {
      await mc.indexAll();
      expect(mc.getWorkspaceIds()).toEqual(["left"]);
      expect(mc.getWorkspace("left")).not.toBeNull();
      mc.removeWorkspace("left");
      expect(mc.getWorkspaceIds()).toEqual([]);
      expect(mc.getWorkspace("left")).toBeNull();
      expect(await mc.search("goneSoon", { topK: 5 })).toEqual([]);
    } finally {
      mc.close();
    }
  });

  it("aggregates files across workspaces with their ids", async () => {
    const left = makeWorkspace({ "one.ts": "export const one = 1;\n" });
    const right = makeWorkspace({ "two.ts": "export const two = 2;\n" });
    const mc = new MultiContext();
    await mc.addWorkspace("left", config(left));
    await mc.addWorkspace("right", config(right));
    try {
      await mc.indexAll();
      const all = await mc.listAllFiles();
      expect(all).toContainEqual({ workspaceId: "left", path: "one.ts" });
      expect(all).toContainEqual({ workspaceId: "right", path: "two.ts" });
      const only = await mc.listAllFiles("right");
      expect(only.every(f => f.workspaceId === "right")).toBe(true);
      expect(only.some(f => f.path === "two.ts")).toBe(true);
    } finally {
      mc.close();
    }
  });
});
