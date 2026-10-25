import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isKeyishPath, resolveWorkspacePath } from "../core/utils";
import { FsEditApplier } from "./edit-tools";
import { shellTool, scrubbedEnv } from "./extra-tools";
import { OpenContext } from "../core/context";
import { EmbeddingProvider } from "../core/embedder";

/** Sandboxing regression tests: every agent-reachable filesystem/exec surface
 *  must be contained to the workspace and leak no credentials. */

let ws: string;

beforeEach(async () => {
  ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-sec-"));
  await fs.promises.writeFile(path.join(ws, "inside.txt"), "inside contents\n");
});

afterEach(async () => {
  await fs.promises.rm(ws, { recursive: true, force: true });
});

describe("resolveWorkspacePath", () => {
  it("allows relative paths that stay inside", () => {
    expect(resolveWorkspacePath(ws, "a/b.txt")).toBe(path.resolve(ws, "a/b.txt"));
    expect(resolveWorkspacePath(ws, "nested/valid/y.txt")).toBe(path.resolve(ws, "nested/valid/y.txt"));
    expect(resolveWorkspacePath(ws, "")).toBe(path.resolve(ws));
  });

  it("throws on .. traversal and absolute paths", () => {
    expect(() => resolveWorkspacePath(ws, "../outside.txt")).toThrow(/outside workspace/);
    expect(() => resolveWorkspacePath(ws, "a/../../outside.txt")).toThrow(/outside workspace/);
    expect(() => resolveWorkspacePath(ws, "./x/../y.txt")).toThrow(/outside workspace/);
    expect(() => resolveWorkspacePath(ws, os.tmpdir())).toThrow(/outside workspace/);
    expect(() => resolveWorkspacePath(ws, "/etc/passwd")).toThrow(/outside workspace/);
  });

  it("rejects absolute paths even when they point inside the root", () => {
    expect(() => resolveWorkspacePath(ws, path.join(ws, "inside.txt"))).toThrow(/outside workspace/);
  });

  it("rejects symlink escapes when the target exists", async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-outside-"));
    try {
      await fs.promises.writeFile(path.join(outside, "secret.txt"), "secret");
      await fs.promises.symlink(outside, path.join(ws, "link-out"), "dir");
      expect(() => resolveWorkspacePath(ws, "link-out/secret.txt")).toThrow(/outside workspace/);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("isKeyishPath (secret blocklist)", () => {
  it("blocks credential dotfiles and secret stores", () => {
    for (const p of [".env", ".env.production", ".npmrc", ".netrc", ".pgpass", ".htpasswd", ".git-credentials", "config/secrets.yml", "deploy/secret.json", "infra/terraform.tfstate"]) {
      expect(isKeyishPath(p), p).toBe(true);
    }
  });

  it("blocks whole credential directories (.aws/.ssh/.kube)", () => {
    expect(isKeyishPath(".aws/credentials")).toBe(true);
    expect(isKeyishPath("home/user/.ssh/known_hosts")).toBe(true);
    expect(isKeyishPath(".kube/config")).toBe(true);
  });

  it("still allows ordinary source files", () => {
    for (const p of ["src/env.ts", "envelope.py", "docs/environment.md", "src/keyboard.ts", "credits.txt"]) {
      expect(isKeyishPath(p), p).toBe(false);
    }
  });
});

describe("OpenContext.readFile containment", () => {
  const embedder: EmbeddingProvider = {
    embed: async (t) => t.map(() => [0.1, 0.2, 0.3, 0.4]),
    getDimension: () => 4,
    getModel: () => "mock",
  };

  it("refuses traversal, absolute escapes, and credential files", async () => {
    // A real secret OUTSIDE the workspace must be unreachable.
    const secretPath = path.join(os.tmpdir(), `oce-secret-${Date.now()}.txt`);
    await fs.promises.writeFile(secretPath, "TOP SECRET");
    await fs.promises.writeFile(path.join(ws, ".env"), "API_KEY=abc123");
    const ctx = await OpenContext.create({
      workspaceRoot: ws,
      storePath: path.join(ws, ".store"),
      embedding: { provider: "ollama", model: "mock", dimension: 4, batchSize: 8 },
      embedder,
      policy: false,
    });
    try {
      expect(await ctx.readFile("inside.txt")).toContain("inside contents");
      expect(await ctx.readFile("../" + path.basename(secretPath))).toMatch(/outside the workspace/);
      expect(await ctx.readFile(secretPath)).toMatch(/outside the workspace/);
      expect(await ctx.readFile(".env")).toMatch(/credential-like/);
    } finally {
      ctx.close();
      await fs.promises.rm(secretPath, { force: true });
    }
  });
});

describe("FsEditApplier containment", () => {
  it("cannot read or write outside the workspace", async () => {
    const applier = new FsEditApplier(ws);
    await expect(applier.readFile("../somewhere.txt")).rejects.toThrow(/outside workspace/);
    await expect(applier.writeFile("../evil.txt", "x")).rejects.toThrow(/outside workspace/);
    await expect(applier.writeFile("/tmp/evil-abs.txt", "x")).rejects.toThrow(/outside workspace/);
    // Inside still works.
    await applier.writeFile("ok.txt", "fine");
    expect(await applier.readFile("ok.txt")).toBe("fine");
  });
});

describe("shell tool hardening", () => {
  it("rejects a cwd outside the workspace", async () => {
    const tool = shellTool({ workspaceRoot: ws });
    const out = await tool.handler({ command: "pwd", cwd: "../.." });
    expect(out).toMatch(/outside the workspace/);
  });

  it("scrubbedEnv drops credential-shaped variables but keeps PATH", () => {
    const env = scrubbedEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      OPENAI_API_KEY: "sk-xxx",
      VOYAGE_API_KEY: "vk",
      MY_PASSWORD: "hunter2",
      GITHUB_TOKEN: "ghp",
      AWS_SECRET_ACCESS_KEY: "aws",
      DB_CREDENTIALS: "x",
      SSH_AUTH_SOCK: "/tmp/agent.sock", // explicitly allowed
      NODE_ENV: "test",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.NODE_ENV).toBe("test");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    for (const k of ["OPENAI_API_KEY", "VOYAGE_API_KEY", "MY_PASSWORD", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_CREDENTIALS"]) {
      expect(env[k], k).toBeUndefined();
    }
  });

  it("child processes cannot see the parent's secrets end-to-end", async () => {
    process.env.OCE_TEST_FAKE_SECRET_TOKEN = "leak-me";
    try {
      const tool = shellTool({ workspaceRoot: ws });
      const out = await tool.handler({ command: `node -e "console.log('SEEN=' + (process.env.OCE_TEST_FAKE_SECRET_TOKEN ?? 'nothing'))"` });
      expect(out).toContain("SEEN=nothing");
    } finally {
      delete process.env.OCE_TEST_FAKE_SECRET_TOKEN;
    }
  });
});
