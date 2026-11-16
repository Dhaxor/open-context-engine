import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { EditApplier } from "../agent/edit-tools";
import type { AgentMessage, EditProposal, ToolDefinition } from "../agent/types";
import type { LLMCaller, LLMResponse } from "../agent/providers";
import { ModelRouter, defaultRoutingConfig } from "../agent/model-router";
import { SessionMemory } from "../agent/session-memory";
import { SessionStore } from "../agent/session-store";
import type { OpenContext } from "../core/context";
import type { ContextSnapshot, TraceEvent } from "./protocol";
import { assembleAgentStack } from "./stack";

/** A router whose every tier answers at once, recording each system prompt. */
function scriptedRouter(systems: string[]): ModelRouter {
  const caller: LLMCaller = {
    call: async (_m: AgentMessage[], _t: ToolDefinition[], system: string): Promise<LLMResponse> => {
      systems.push(system);
      return { text: "Done.", toolCalls: [], stopReason: "stop" };
    },
  };
  const router = new ModelRouter(defaultRoutingConfig("anthropic", { apiKey: "k" }));
  for (const m of ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"]) router.registerCaller("anthropic", m, caller);
  return router;
}

class MemoryApplier implements EditApplier {
  files = new Map<string, string>();
  async readFile(p: string) { return this.files.has(p) ? this.files.get(p)! : null; }
  async writeFile(p: string, c: string) { this.files.set(p, c); }
  async removeFile(p: string) { return this.files.delete(p); }
  async fileExists(p: string) { return this.files.has(p); }
}

/** Just enough index for the tools to be built and an edit to re-index. */
const ctx = {
  getWorkspaceRoot: () => os.tmpdir(),
  getPolicy: () => undefined,
  getChunkCount: () => 0,
  getStatus: () => ({ searchMode: "keyword-only" }),
  addFiles: async () => ({}),
  removeFromIndex: async () => {},
} as unknown as OpenContext;

describe("assembleAgentStack", () => {
  it("routes the edit tools' edits into the trace — transcript and checkpoint", async () => {
    // The agent's stream never carries an edit_proposed event: the edit tools
    // report through onEdit. Unwired, the transcript showed no edits and
    // rewind had no files to restore.
    const seen: EditProposal[] = [];
    const stack = assembleAgentStack({
      ctx, workspaceRoot: os.tmpdir(), provider: "openai", model: "gpt-4o", apiKey: "test",
      memorySource: "test", applier: new MemoryApplier(), mode: "full-auto",
      includeEdits: true, shell: false, plan: false, delegate: false, env: false, traced: true,
      onEdit: e => seen.push(e),
      sessionStore: new SessionStore(os.tmpdir()), sessionId: "s1",
    });
    const events: TraceEvent[] = [];
    stack.trace!.subscribe(env => events.push(env.event));

    const create = stack.tools.find(t => t.name === "create-file")!;
    await create.handler({ path: "a.txt", contents: "hello\n" });

    expect(seen).toHaveLength(1); // the embedder's own onEdit still fires
    expect(events.find(e => e.type === "edit")).toMatchObject({ edit: { kind: "create", path: "a.txt" } });
  });

  it("offers external (MCP) tools beside the built-ins, asking for the ones that change things in every mode", () => {
    const tool = (name: string, mutates: boolean) => ({ name, description: name, parameters: { type: "object", properties: {} }, mutates, handler: async () => "ok" });
    const stack = assembleAgentStack({
      ctx, workspaceRoot: os.tmpdir(), provider: "openai", model: "gpt-4o", apiKey: "test",
      memorySource: "test", applier: new MemoryApplier(), mode: "full-auto",
      includeEdits: true, shell: false, plan: false, delegate: false, env: false, traced: true,
      extraTools: {
        tools: [tool("mcp__gh__search", false), tool("mcp__gh__create_issue", true), tool("create-file", true)],
        alwaysAsk: ["mcp__gh__create_issue"],
      },
      sessionStore: new SessionStore(os.tmpdir()), sessionId: "s-mcp",
    });
    const names = stack.tools.map(t => t.name);
    expect(names).toContain("mcp__gh__search");
    expect(names.filter(n => n === "create-file")).toHaveLength(1); // a built-in is never shadowed
    expect(stack.permissions.needsApproval("mcp__gh__search")).toBe(false);
    expect(stack.permissions.needsApproval("mcp__gh__create_issue")).toBe(true); // even in full-auto
    expect(stack.permissions.needsApproval("create-file")).toBe(false);
  });

  it("shows recalled memories in the evidence rail, and an evicted one stops being injected", async () => {
    // onMemoryInjected used to ride only on the per-run options, which the
    // TraceSession never passes: memories reached the prompt, never the rail.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-stack-mem-"));
    try {
      const memory = new SessionMemory({ storePath: dir });
      const remembered = memory.add({ kind: "preference", content: "The team runs the test suite with pnpm vitest", source: "test", tags: ["pnpm", "vitest"] });
      const systems: string[] = [];
      const stack = assembleAgentStack({
        ctx, workspaceRoot: dir, provider: "anthropic", model: "claude-sonnet-4-6", router: scriptedRouter(systems),
        memory, memorySource: "test", applier: new MemoryApplier(), mode: "full-auto",
        includeEdits: false, shell: false, plan: false, delegate: false, env: false, traced: true,
        sessionStore: new SessionStore(dir), sessionId: "s1",
      });
      const contexts: ContextSnapshot[] = [];
      stack.trace!.subscribe(env => { if (env.event.type === "context") contexts.push(env.event.snapshot); });

      await stack.trace!.prompt("how do I run the vitest suite?");
      expect(systems[0]).toContain("pnpm vitest");
      const row = contexts.at(-1)!.entries.find(e => e.bucket === "memory");
      expect(row).toMatchObject({ id: `m:${remembered.id}` });
      expect(contexts.at(-1)!.buckets.memory).toBeGreaterThan(0);

      stack.trace!.evict(row!.id);
      await stack.trace!.prompt("and the vitest suite in watch mode?");
      expect(systems.at(-1)).not.toContain("pnpm vitest");
      expect(memory.live().map(m => m.id)).toContain(remembered.id); // evicted from the window, not forgotten
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
