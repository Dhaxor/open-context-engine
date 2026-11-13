import { describe, expect, it } from "vitest";
import * as os from "os";
import type { EditApplier } from "../agent/edit-tools";
import type { EditProposal } from "../agent/types";
import { SessionStore } from "../agent/session-store";
import type { OpenContext } from "../core/context";
import type { TraceEvent } from "./protocol";
import { assembleAgentStack } from "./stack";

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
});
