import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentTask, EvalAgent, parseAgentTasks, runAgentTasks } from "./agent-runner";

/** A scripted agent that applies a fixed patch — the LLM stands in for fs. */
function patchAgent(patch: Record<string, string> = {}, opts: { failWith?: Error } = {}): (ws: string) => EvalAgent {
  return (ws) => ({
    run: async () => {
      if (opts.failWith) throw opts.failWith;
      for (const [rel, contents] of Object.entries(patch)) {
        fs.writeFileSync(path.join(ws, rel), contents);
      }
      return "done";
    },
    getLastRunStats: () => ({ steps: 3, toolCalls: 2 }),
    close: () => {},
  });
}

const kept: string[] = [];
afterEach(() => {
  for (const d of kept.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  id: "t",
  instruction: "do the thing",
  files: { "a.js": "module.exports = 1;\n", "_verify.js": "const a = require('./a.js');\nif (a !== 2) { console.error('a is ' + a); process.exit(1); }\n" },
  verify: { command: "node _verify.js" },
  ...over,
});

describe("parseAgentTasks", () => {
  it("accepts an array or { tasks } and validates shape", () => {
    const tasks = parseAgentTasks([task({ id: "one" }), { tasks: [task({ id: "two" })] } as never][1]);
    expect(tasks.map(t => t.id)).toEqual(["two"]);
    expect(() => parseAgentTasks([])).toThrow(/array of tasks/);
    expect(() => parseAgentTasks([task({ instruction: "" })])).toThrow(/instruction/);
    expect(() => parseAgentTasks([task({ files: {} })])).toThrow(/files/);
    expect(() => parseAgentTasks([task({ verify: { command: "" } })])).toThrow(/verify/);
  });

  it("refuses paths that escape the workspace", () => {
    expect(() => parseAgentTasks([task({ files: { "../out.js": "x" } })])).toThrow(/relative path inside the workspace/);
    expect(() => parseAgentTasks([task({ files: { "C:\\abs.js": "x" } })])).toThrow(/relative path inside the workspace/);
  });
});

describe("runAgentTasks", () => {
  it("passes when the agent's edit satisfies the grader", async () => {
    const report = await runAgentTasks([task({ id: "good" })], {
      createAgent: async (ws) => patchAgent({ "a.js": "module.exports = 2;\n" })(ws),
    });
    expect(report.passRate).toBe(1);
    expect(report.results[0].ok).toBe(true);
    expect(report.results[0].steps).toBe(3);
  });

  it("fails with the grader output when the agent does nothing", async () => {
    const report = await runAgentTasks([task({ id: "noop" })], { createAgent: async (ws) => patchAgent()(ws) });
    expect(report.passRate).toBe(0);
    expect(report.results[0].ok).toBe(false);
    expect(report.results[0].verifyOutput).toContain("a is 1");
  });

  it("fails the task, not the run, when the agent throws", async () => {
    const report = await runAgentTasks([task({ id: "boom" }), task({ id: "fine" })], {
      createAgent: async (ws, t) => (t.id === "boom"
        ? patchAgent({}, { failWith: new Error("provider exploded") })(ws)
        : patchAgent({ "a.js": "module.exports = 2;\n" })(ws)),
    });
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results[0].error).toContain("provider exploded");
  });

  it("seeds nested directories and cleans workspaces up", async () => {
    let seen: string | null = null;
    const report = await runAgentTasks([task({ id: "nested", files: { "src/deep/mod.js": "module.exports = 1;\n", "_verify.js": "require('./src/deep/mod.js');\n" }, verify: { command: "node _verify.js" } })], {
      createAgent: async (ws) => { seen = ws; return patchAgent()(ws); },
    });
    expect(report.passRate).toBe(1);
    expect(seen).toBeTruthy();
    expect(fs.existsSync(seen!)).toBe(false); // cleaned
  });
});
