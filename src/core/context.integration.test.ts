import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenContext } from "./context";

const DIM = 16;

// Deterministic, normalized fake embedding so cosine distance is meaningful.
function fakeEmbedding(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) v[i % DIM] += text.charCodeAt(i) % 13;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

let server: http.Server;
let baseUrl: string;
let embedCalls = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input: string[] = JSON.parse(body || "{}").input ?? [];
      embedCalls++;
      const data = input.map((t, index) => ({ index, embedding: fakeEmbedding(t) }));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as import("net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const tmpDirs: string[] = [];
function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-ctx-"));
  tmpDirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}
async function makeContext(root: string, batchSize = 4): Promise<OpenContext> {
  return OpenContext.create({
    workspaceRoot: root,
    embedding: { provider: "voyage", model: "voyage-code-3", apiKey: "test", baseUrl, dimension: DIM, batchSize },
  });
}

beforeEach(() => { embedCalls = 0; });
afterEach(() => { for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

describe("OpenContext end-to-end (fake embeddings)", () => {
  it("indexes, then returns relevant context for a query", async () => {
    const root = workspace({
      "src/auth.ts": "export function authenticateUser(token: string) {\n  return verifyToken(token);\n}\n",
      "src/render.ts": "export function renderButton(label: string) {\n  return `<button>${label}</button>`;\n}\n",
    });
    const ctx = await makeContext(root);
    try {
      const result = await ctx.indexWorkspace();
      expect(result.newlyIndexed.length).toBe(2);
      expect(ctx.getChunkCount()).toBeGreaterThan(0);
      const out = await ctx.search("authenticate user token");
      expect(out).toContain("src/auth.ts");
    } finally {
      ctx.close();
    }
  });

  it("streams indexing across the file-batch boundary without losing chunks", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`src/f${i}.ts`] = `export function fn${i}() { return ${i}; }\n`;
    const root = workspace(files);
    const ctx = await makeContext(root, 8);
    try {
      const result = await ctx.indexWorkspace();
      expect(result.newlyIndexed.length).toBe(60);
      expect(ctx.getChunkCount()).toBe(60);
      expect((await ctx.listFiles()).length).toBe(60);
    } finally {
      ctx.close();
    }
  });

  it("incremental index only re-embeds changed files", async () => {
    const root = workspace({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" });
    const ctx = await makeContext(root);
    try {
      await ctx.indexWorkspace();
      embedCalls = 0;
      const noop = await ctx.incrementalIndex();
      expect(noop.newlyIndexed.length).toBe(0);
      expect(noop.alreadyIndexed.length).toBe(2);
      expect(embedCalls).toBe(0);

      fs.writeFileSync(path.join(root, "a.ts"), "export const a = 42;\nexport const c = 3;\n");
      const changed = await ctx.incrementalIndex();
      expect(changed.newlyIndexed).toEqual(["a.ts"]);
      expect(embedCalls).toBeGreaterThan(0);
    } finally {
      ctx.close();
    }
  });
});
