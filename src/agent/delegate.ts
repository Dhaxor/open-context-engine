import { ToolDefinition } from "./types";

/**
 * Sub-agent delegation — hand a self-contained exploration to a scoped child
 * agent so the huge intermediate tool output stays OUT of the main thread's
 * context. The parent only sees the child's final answer; big harnesses call
 * this subagents/tasks and it is the single biggest context saver on large
 * codebases.
 *
 * The child is built by a factory the embedder supplies (same provider, same
 * retrieval tools, typically read-only and a smaller step budget). A fresh
 * child per call keeps delegations independent.
 */

export interface DelegateRunner {
  run(task: string, options?: { signal?: AbortSignal }): Promise<string>;
}

export interface DelegateToolOptions {
  /** Build a fresh child agent per delegation. */
  makeAgent: () => DelegateRunner;
  /** Cap on the child's answer size folded back into the parent. Default 8000. */
  maxResultChars?: number;
}

export function delegateTool(opts: DelegateToolOptions): ToolDefinition {
  const cap = opts.maxResultChars ?? 8_000;
  return {
    name: "delegate",
    description:
      "Delegate a self-contained research/exploration task to a sub-agent with the same codebase tools. The sub-agent works in its OWN context and only its final report comes back — use this for broad searches ('map the auth flow end to end', 'find every caller of X and how they use it') whose intermediate output would flood your context. Give it a complete, standalone brief: it cannot see this conversation. Not for edits — it is read-only.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complete, self-contained brief for the sub-agent, including what to return." },
      },
      required: ["task"],
    },
    handler: async (args, signal) => {
      const task = String(args.task ?? "").trim();
      if (!task) return "No task given.";
      const child = opts.makeAgent();
      try {
        const answer = await child.run(task, { signal });
        return answer.length > cap ? answer.slice(0, cap) + `\n… [sub-agent answer truncated at ${cap} chars]` : answer;
      } catch (e: any) {
        return `Sub-agent failed: ${e?.message ?? String(e)}`;
      }
    },
  };
}
