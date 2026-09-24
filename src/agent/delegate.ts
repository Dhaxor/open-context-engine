import { StreamEvent, ToolDefinition } from "./types";

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
  run(task: string, options?: { signal?: AbortSignal; onStream?: (event: StreamEvent) => void }): Promise<string>;
}

/**
 * Watches a delegation from the outside.
 *
 * The parent agent deliberately never sees the child's intermediate output —
 * that is the entire point of delegating. But the USER should: "the sub-agent
 * is doing something, for a while, and you cannot see what" is the most common
 * complaint about harnesses that have subagents at all. This seam lets a UI
 * follow the child's work without any of it reaching the parent's context.
 */
export interface DelegateObserver {
  start(id: string, task: string): void;
  /** Every event from the child's own stream. */
  event(id: string, event: StreamEvent): void;
  end(id: string, result: { ok: boolean; chars: number; ms: number }): void;
}

export interface DelegateToolOptions {
  /** Build a fresh child agent per delegation. */
  makeAgent: () => DelegateRunner;
  /** Cap on the child's answer size folded back into the parent. Default 8000. */
  maxResultChars?: number;
  /** Follow delegations. Unset elsewhere, so the plain agent path is unchanged. */
  observer?: DelegateObserver;
}

let delegationCounter = 0;

export function delegateTool(opts: DelegateToolOptions): ToolDefinition {
  const cap = opts.maxResultChars ?? 8_000;
  const observer = opts.observer;
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
      const id = `sub-${++delegationCounter}`;
      const started = Date.now();
      // An observer that throws is a broken UI; it must never fail a delegation.
      const notify = <T extends keyof DelegateObserver>(method: T, ...args: Parameters<DelegateObserver[T]>): void => {
        try { (observer?.[method] as any)?.(...args); } catch {}
      };

      notify("start", id, task);
      try {
        const answer = await child.run(task, {
          signal,
          ...(observer ? { onStream: (event: StreamEvent) => notify("event", id, event) } : {}),
        });
        notify("end", id, { ok: true, chars: answer.length, ms: Date.now() - started });
        return answer.length > cap ? answer.slice(0, cap) + `\n… [sub-agent answer truncated at ${cap} chars]` : answer;
      } catch (e: any) {
        notify("end", id, { ok: false, chars: 0, ms: Date.now() - started });
        return `Sub-agent failed: ${e?.message ?? String(e)}`;
      }
    },
  };
}
