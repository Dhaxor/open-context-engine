import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec } from "child_process";

/**
 * Agent-level eval: end-to-end tasks ("fix this failing test", "rename this
 * symbol everywhere") in a throwaway workspace, graded by a verification
 * script. Retrieval evals measure what the engine finds; these measure what
 * the agent *does* — the number that actually moves when a prompt, tool, or
 * provider regresses.
 *
 * The runner is deliberately model-agnostic: `createAgent` is injected, so
 * the CLI wires a real ContextAgent while tests wire a scripted one that
 * applies a known patch. No LLM key is needed to test the harness itself.
 */

export interface AgentTask {
  id: string;
  /** Shown to the agent as its instruction for this task. */
  instruction: string;
  /** Workspace seed: relative path → file contents. */
  files: Record<string, string>;
  /**
   * Grading command, run with cwd = the task workspace. Exit 0 passes.
   * Keep commands shell-portable — the canonical form is `node _verify.js`
   * with the grader shipped as one of `files`.
   */
  verify: { command: string };
  /** Give the agent the run-command (shell) tool. Off by default: most tasks
   *  should be solvable with read + edit + search, and shell makes grading
   *  outcomes noisy. */
  allowShell?: boolean;
  /** Per-task wall clock for the agent turn. */
  timeoutMs?: number;
}

/** What the runner needs from an agent. Both ContextAgent and test stubs fit. */
export interface EvalAgent {
  run(instruction: string, opts?: { onStream?: (ev: unknown) => void }): Promise<string>;
  getLastRunStats(): { steps?: number; toolCalls?: number } | undefined;
  close?(): void | Promise<void>;
}

export interface AgentTaskResult {
  id: string;
  ok: boolean;
  error?: string;
  steps?: number;
  toolCalls?: number;
  verifyOutput?: string;
  durationMs: number;
}

export interface RunAgentTasksOptions {
  createAgent: (workspace: string, task: AgentTask) => Promise<EvalAgent>;
  onTask?: (result: AgentTaskResult) => void;
  /** Test hook: keep the workspace for inspection instead of deleting it. */
  keepWorkspaces?: boolean;
}

export interface AgentTaskReport {
  results: AgentTaskResult[];
  passed: number;
  failed: number;
  passRate: number;
  totalDurationMs: number;
}

export function parseAgentTasks(input: unknown): AgentTask[] {
  const raw = Array.isArray(input) ? input : (input as { tasks?: unknown[] })?.tasks;
  if (!Array.isArray(raw) || !raw.length) throw new Error("agent task file must be a JSON array of tasks (or { tasks: [...] })");
  return raw.map((t, i) => {
    const task = t as Partial<AgentTask>;
    if (typeof task.id !== "string" || !task.id) throw new Error(`task[${i}]: id is required`);
    if (typeof task.instruction !== "string" || !task.instruction) throw new Error(`task[${i}].instruction is required`);
    if (!task.files || typeof task.files !== "object" || Object.keys(task.files).length === 0) throw new Error(`task[${i}].files must seed the workspace`);
    if (!task.verify || typeof task.verify.command !== "string" || !task.verify.command.trim()) throw new Error(`task[${i}].verify.command is required`);
    for (const rel of Object.keys(task.files)) {
      // Strict on every platform: a task file must be a plain relative path.
      // path.isAbsolute alone is platform-dependent ("C:\x" is relative on
      // POSIX), so Windows drives and leading separators are refused outright.
      if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /^[\\/]/.test(rel) || rel.split(/[\\/]+/).includes("..")) {
        throw new Error(`task[${i}].files: "${rel}" must be a relative path inside the workspace`);
      }
    }
    return {
      id: task.id,
      instruction: task.instruction,
      files: task.files,
      verify: task.verify,
      ...(task.allowShell !== undefined ? { allowShell: task.allowShell } : {}),
      ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    };
  });
}

export async function runAgentTasks(tasks: AgentTask[], opts: RunAgentTasksOptions): Promise<AgentTaskReport> {
  const results: AgentTaskResult[] = [];
  for (const task of tasks) {
    const result = await runAgentTask(task, opts);
    results.push(result);
    opts.onTask?.(result);
  }
  const passed = results.filter(r => r.ok).length;
  return {
    results,
    passed,
    failed: results.length - passed,
    passRate: results.length ? passed / results.length : 0,
    totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
  };
}

async function runAgentTask(task: AgentTask, opts: RunAgentTasksOptions): Promise<AgentTaskResult> {
  const started = Date.now();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `oce-agent-eval-${task.id}-`));
  let agent: EvalAgent | null = null;
  try {
    for (const [rel, contents] of Object.entries(task.files)) {
      const target = path.join(workspace, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    agent = await opts.createAgent(workspace, task);
    const answer = await withTimeout(agent.run(task.instruction), task.timeoutMs ?? 300_000, `agent run timed out after ${task.timeoutMs ?? 300_000}ms`);
    const stats = agent.getLastRunStats?.();
    const verify = await runVerify(task.verify.command, workspace);
    return {
      id: task.id,
      ok: verify.ok,
      error: verify.ok ? undefined : (answer ? undefined : "agent returned no answer"),
      steps: stats?.steps,
      toolCalls: stats?.toolCalls,
      verifyOutput: verify.ok ? undefined : verify.output,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      id: task.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  } finally {
    try { await agent?.close?.(); } catch {}
    if (!opts.keepWorkspaces) { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {} }
  }
}

function runVerify(command: string, workspace: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { cwd: workspace, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve({ ok: !err, output: output.slice(-800) });
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
