import { describe, it, expect } from "vitest";
import { AgentTask } from "./agent-runner";

/**
 * The workspace-escape validation must be strict on EVERY platform: CI runs
 * Linux, where path.isAbsolute("C:\\abs.js") is false and a naive check lets
 * Windows paths through (caught by CI, not by a Windows dev machine).
 */
describe("agent task path validation (platform-independent cases)", () => {
  it("the escape patterns used in parseAgentTasks are caught regardless of platform", async () => {
    const { parseAgentTasks } = await import("./agent-runner");
    const escapes = ["../out.js", "C:\\abs.js", "C:/abs.js", "C:abs.js", "/abs.js", "\\abs.js", "a/../../b.js"];
    for (const bad of escapes) {
      const task = { id: "x", instruction: "i", files: { [bad]: "x" }, verify: { command: "node _v.js" } } as unknown as AgentTask;
      expect(() => parseAgentTasks([task]), `should reject ${bad}`).toThrow(/relative path inside the workspace/);
    }
    const ok = { id: "x", instruction: "i", files: { "src/deep/a.js": "x", "_v.js": "y" }, verify: { command: "node _v.js" } };
    expect(() => parseAgentTasks([ok as unknown as AgentTask])).not.toThrow();
  });
});
