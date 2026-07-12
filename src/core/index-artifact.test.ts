import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenContext } from "./context";
import { EmbeddingProvider } from "./embedder";
import { installArtifact, readArtifactManifest, pullArtifact, pushArtifact } from "./index-artifact";

/** Team index sync: export on one "machine", install on another, reconcile. */

const DIM = 4;

function countingEmbedder(): { embedder: EmbeddingProvider; calls: () => number } {
  let calls = 0;
  return {
    embedder: {
      embed: async (texts: string[]) => { calls += texts.length; return texts.map(t => [t.length % 5, 0.2, 0.3, 0.4]); },
      getDimension: () => DIM,
      getModel: () => "mock-model",
    },
    calls: () => calls,
  };
}

let dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const d = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

beforeEach(() => { dirs = []; });
afterEach(async () => {
  for (const d of dirs) await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const ws = await tmpDir("oce-team-ws-");
  for (const [rel, contents] of Object.entries(files)) {
    await fs.promises.mkdir(path.join(ws, path.dirname(rel)), { recursive: true });
    await fs.promises.writeFile(path.join(ws, rel), contents);
  }
  return ws;
}

async function makeContext(ws: string, embedder: EmbeddingProvider): Promise<OpenContext> {
  return OpenContext.create({
    workspaceRoot: ws,
    storePath: path.join(ws, ".store"),
    embedding: { provider: "ollama", model: "mock-model", dimension: DIM, batchSize: 32 },
    embedder,
    policy: false,
  });
}

const FILES = {
  "src/auth.ts": "export function authenticate(user: string) {\n  return user.length > 0;\n}\n",
  "src/billing.ts": "export function charge(amount: number) {\n  return amount * 100;\n}\n",
};

describe("index artifact export/install", () => {
  it("round-trips: exported index searches identically after install elsewhere", async () => {
    const producer = countingEmbedder();
    const ws1 = await makeWorkspace(FILES);
    const ctx1 = await makeContext(ws1, producer.embedder);
    await ctx1.indexWorkspace();
    const artifact = path.join(await tmpDir("oce-team-art-"), "index.db.gz");
    const manifest = await ctx1.exportIndex(artifact);
    ctx1.close();

    expect(manifest.chunkCount).toBeGreaterThan(0);
    expect(manifest.embeddingModel).toBe("mock-model");
    expect(manifest.dimension).toBe(DIM);

    // "Teammate": same files, fresh machine, empty store.
    const ws2 = await makeWorkspace(FILES);
    const installed = await installArtifact(artifact, path.join(ws2, ".store"), { model: "mock-model", dimension: DIM });
    expect(installed.chunkCount).toBe(manifest.chunkCount);

    const consumer = countingEmbedder();
    const ctx2 = await makeContext(ws2, consumer.embedder);
    try {
      // Reconcile: identical files → hashes match → nothing re-embeds.
      const r = await ctx2.incrementalIndex();
      expect(r.newlyIndexed).toEqual([]);
      expect(r.alreadyIndexed.length).toBe(2);
      expect(consumer.calls()).toBe(0);
      const hits = await ctx2.search("authenticate user");
      expect(hits).toContain("src/auth.ts");
    } finally {
      ctx2.close();
    }
  });

  it("reconciles only locally changed files after install", async () => {
    const producer = countingEmbedder();
    const ws1 = await makeWorkspace(FILES);
    const ctx1 = await makeContext(ws1, producer.embedder);
    await ctx1.indexWorkspace();
    const artifact = path.join(await tmpDir("oce-team-art-"), "index.db.gz");
    await ctx1.exportIndex(artifact);
    ctx1.close();

    const ws2 = await makeWorkspace({
      ...FILES,
      "src/billing.ts": "export function charge(amount: number) {\n  return amount * 200; // local change\n}\n",
      "src/new.ts": "export const fresh = 1;\n",
    });
    await installArtifact(artifact, path.join(ws2, ".store"), { model: "mock-model", dimension: DIM });
    const consumer = countingEmbedder();
    const ctx2 = await makeContext(ws2, consumer.embedder);
    try {
      const r = await ctx2.incrementalIndex();
      expect(r.newlyIndexed.sort()).toEqual(["src/billing.ts", "src/new.ts"]);
      expect(r.alreadyIndexed).toEqual(["src/auth.ts"]);
      expect(consumer.calls()).toBeGreaterThan(0);
    } finally {
      ctx2.close();
    }
  });

  it("rejects an artifact from a different embedding space", async () => {
    const producer = countingEmbedder();
    const ws1 = await makeWorkspace(FILES);
    const ctx1 = await makeContext(ws1, producer.embedder);
    await ctx1.indexWorkspace();
    const artifact = path.join(await tmpDir("oce-team-art-"), "index.db.gz");
    await ctx1.exportIndex(artifact);
    ctx1.close();

    const store = path.join(await tmpDir("oce-team-store-"), ".store");
    await expect(installArtifact(artifact, store, { model: "voyage-code-3", dimension: 1024 }))
      .rejects.toThrow(/built with mock-model \(4d\)/);
  });

  it("backs up an existing database before install", async () => {
    const producer = countingEmbedder();
    const ws1 = await makeWorkspace(FILES);
    const ctx1 = await makeContext(ws1, producer.embedder);
    await ctx1.indexWorkspace();
    const artifact = path.join(await tmpDir("oce-team-art-"), "index.db.gz");
    await ctx1.exportIndex(artifact);
    ctx1.close();

    const ws2 = await makeWorkspace(FILES);
    const own = countingEmbedder();
    const ctx2 = await makeContext(ws2, own.embedder);
    await ctx2.indexWorkspace();
    ctx2.close();

    await installArtifact(artifact, path.join(ws2, ".store"), { model: "mock-model", dimension: DIM });
    expect(fs.existsSync(path.join(ws2, ".store", "context.db.pre-pull"))).toBe(true);
  });

  it("readArtifactManifest rejects a non-artifact database", async () => {
    const ws = await makeWorkspace(FILES);
    const producer = countingEmbedder();
    const ctx = await makeContext(ws, producer.embedder);
    await ctx.indexWorkspace();
    ctx.close();
    await expect(readArtifactManifest(path.join(ws, ".store", "context.db"))).rejects.toThrow(/no manifest/);
  });
});

describe("artifact transport", () => {
  it("push/pull to and from local paths", async () => {
    const dir = await tmpDir("oce-transport-");
    const src = path.join(dir, "a.gz");
    await fs.promises.writeFile(src, "payload");
    await pushArtifact(src, path.join(dir, "nested", "b.gz"));
    await pullArtifact(path.join(dir, "nested", "b.gz"), path.join(dir, "c.gz"));
    expect(await fs.promises.readFile(path.join(dir, "c.gz"), "utf8")).toBe("payload");
  });

  it("pull over HTTP honors the bearer token", async () => {
    const http = await import("http");
    const dir = await tmpDir("oce-transport-http-");
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== "Bearer tok") { res.writeHead(401).end(); return; }
      res.writeHead(200).end("artifact-bytes");
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("net").AddressInfo).port;
    try {
      const dest = path.join(dir, "pulled.gz");
      await expect(pullArtifact(`http://127.0.0.1:${port}/x.gz`, dest)).rejects.toThrow(/401/);
      await pullArtifact(`http://127.0.0.1:${port}/x.gz`, dest, { token: "tok" });
      expect(await fs.promises.readFile(dest, "utf8")).toBe("artifact-bytes");
    } finally {
      server.close();
    }
  });
});
