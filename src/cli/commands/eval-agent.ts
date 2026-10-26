import * as fs from "fs";
import { parseAgentTasks, runAgentTasks, AgentTask, EvalAgent } from "../../eval/agent-runner";
import { buildSession } from "../session";
import { resolveConfig } from "../config";
import { CliIo } from "../io";

export function registerEvalAgentCommand(program: import("commander").Command, io: CliIo): void {
  program.command("eval-agent").description("Score the coding agent end to end against labeled tasks (needs an LLM provider)")
    .requiredOption("--tasks <file>", "JSON file of agent tasks: [{ id, instruction, files, verify }]")
    .option("-p, --provider <provider>", "LLM provider: openai | anthropic | google | ollama | custom")
    .option("--llm-model <model>", "LLM model (default: provider-appropriate)")
    .option("--llm-base-url <url>", "LLM endpoint override (custom/ollama)")
    .option("--api-key <key>", "LLM API key")
    .option("--embedding-provider <provider>", "Embedding provider for the task workspaces")
    .option("--embedding-model <model>", "Embedding model")
    .option("--only <ids>", "Comma-separated task ids to run (default: all)")
    .option("--keep", "Keep task workspaces for inspection (paths are printed)")
    .option("--json", "Print the report as JSON")
    .action(async (opts: any) => {
      const diag = io.diagnosticsFor(opts);
      const tasks = parseAgentTasks(JSON.parse(await fs.promises.readFile(opts.tasks, "utf8")));
      const selected: AgentTask[] = opts.only
        ? (() => {
            const wanted = new Set(String(opts.only).split(",").map(s => s.trim()).filter(Boolean));
            const missing = [...wanted].filter(id => !tasks.some(t => t.id === id));
            if (missing.length) io.fatal(`Unknown task ids in --only: ${missing.join(", ")}`);
            return tasks.filter(t => wanted.has(t.id));
          })()
        : tasks;

      // Each task is its own throwaway workspace with its own session, so the
      // agent's retrieval and edit history can never leak across tasks.
      const createAgent = async (workspace: string, task: AgentTask): Promise<EvalAgent> => {
        const built = await buildSession({
          opts: { ...opts, workspace, fullAuto: true, index: true, watch: false, memory: false, audit: false, delegate: false, plan: false },
          diag, interactive: false, traced: false,
          resolveConfig: (o) => resolveConfig(o, io),
          fatal: (message) => { throw new Error(message); },
        });
        return {
          run: (instruction) => built.agent.run(instruction),
          getLastRunStats: () => built.agent.getLastRunStats() ?? undefined,
          close: () => built.close(),
        };
      };

      diag.info(`Running ${selected.length} agent task(s)…`);
      const report = await runAgentTasks(selected, {
        createAgent,
        keepWorkspaces: !!opts.keep,
        onTask: (r) => {
          if (opts.json) return;
          const mark = r.ok ? "✓" : "✗";
          io.text(`  ${mark} ${r.id} (${r.durationMs}ms${r.steps !== undefined ? `, ${r.steps} steps` : ""})${r.error ? ` — ${r.error}` : ""}`);
          if (!r.ok && r.verifyOutput) io.text(`      ${r.verifyOutput.split("\n").slice(-3).join("\n      ")}`);
        },
      });
      if (opts.json) { io.json(report); return; }
      io.text(`\npass ${report.passed}/${report.results.length} (${(report.passRate * 100).toFixed(0)}%) in ${(report.totalDurationMs / 1000).toFixed(1)}s`);
      if (report.failed) process.exitCode = 1;
    });
}
