import { unifiedDiff } from "../core/diff";
import { AgentHooks, PreToolCallDecision, ToolCall } from "./types";

/**
 * Approval system for side-effectful tool calls — the safety model Codex CLI
 * and Claude Code converged on, expressed as three modes:
 *
 *   suggest    every mutating call (edits, shell) waits for approval
 *   auto-edit  file edits run automatically; shell commands still ask
 *   full-auto  nothing asks (containers, CI, or the brave)
 *
 * The manager composes into the harness through AgentHooks.preToolCall, so it
 * stacks with policy enforcement (a policy-stripped tool never even exists to
 * ask about) and with user-supplied hooks (which run after approval).
 */

export type ApprovalMode = "suggest" | "auto-edit" | "full-auto";
export type ApprovalDecision = "allow" | "always" | "deny";

export interface ApprovalRequest {
  call: ToolCall;
  /** One-line human summary, e.g. `str-replace src/auth.ts`. */
  title: string;
  /** Preview of the effect: a diff for edits, the command for shell. */
  preview: string;
}

export interface PermissionManagerOptions {
  mode?: ApprovalMode;
  /** UI callback. Absent = non-interactive: anything needing approval is denied. */
  ask?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Names of mutating tools that never need approval (pre-approved). */
  alwaysAllow?: string[];
  /** Which tools count as "edit" tools for auto-edit mode. */
  editToolNames?: string[];
}

const DEFAULT_EDIT_TOOLS = ["str-replace", "create-file", "remove-file"];

export class PermissionManager {
  private mode: ApprovalMode;
  private ask?: PermissionManagerOptions["ask"];
  private alwaysAllowed: Set<string>;
  private editTools: Set<string>;
  private mutatingTools = new Set<string>();

  constructor(opts: PermissionManagerOptions = {}) {
    this.mode = opts.mode ?? "suggest";
    this.ask = opts.ask;
    this.alwaysAllowed = new Set(opts.alwaysAllow ?? []);
    this.editTools = new Set(opts.editToolNames ?? DEFAULT_EDIT_TOOLS);
  }

  getMode(): ApprovalMode { return this.mode; }
  setMode(mode: ApprovalMode): void { this.mode = mode; }

  /** Attach/replace the approval UI after construction (REPLs build their
   *  readline after the agent exists). */
  setAsk(ask: PermissionManagerOptions["ask"]): void { this.ask = ask; }

  /** Tell the manager which tools mutate (from ToolDefinition.mutates). */
  registerMutatingTools(names: string[]): void {
    for (const n of names) this.mutatingTools.add(n);
  }

  needsApproval(toolName: string): boolean {
    if (!this.mutatingTools.has(toolName)) return false;
    if (this.alwaysAllowed.has(toolName)) return false;
    if (this.mode === "full-auto") return false;
    if (this.mode === "auto-edit" && this.editTools.has(toolName)) return false;
    return true;
  }

  async check(call: ToolCall): Promise<PreToolCallDecision> {
    if (!this.needsApproval(call.name)) return { behavior: "allow" };
    if (!this.ask) {
      return { behavior: "deny", reason: `'${call.name}' requires approval and no approver is attached (mode: ${this.mode}). Re-run with --full-auto, or use the interactive CLI.` };
    }
    const decision = await this.ask(describeToolCall(call));
    if (decision === "deny") return { behavior: "deny", reason: "the user declined this action" };
    if (decision === "always") this.alwaysAllowed.add(call.name);
    return { behavior: "allow" };
  }

  /** Compose approval checking with (optional) user hooks. Approval runs
   *  first; the user's preToolCall sees only approved calls. */
  asHooks(inner?: AgentHooks): AgentHooks {
    return {
      preToolCall: async (call) => {
        const decision = await this.check(call);
        if (decision.behavior === "deny") return decision;
        const innerDecision = await inner?.preToolCall?.(call);
        return innerDecision ?? decision;
      },
      postToolCall: inner?.postToolCall,
    };
  }
}

/** Human-readable rendering of what a mutating call is about to do. */
export function describeToolCall(call: ToolCall): ApprovalRequest {
  const a = call.arguments ?? {};
  switch (call.name) {
    case "str-replace": {
      const preview = unifiedDiff(String(a.old_str ?? ""), String(a.new_str ?? ""), {
        fromLabel: String(a.path ?? "?"), toLabel: String(a.path ?? "?"),
      });
      return { call, title: `edit ${a.path ?? "?"}`, preview };
    }
    case "create-file": {
      const contents = String(a.contents ?? "");
      const head = contents.split("\n").slice(0, 20).join("\n");
      const more = contents.split("\n").length > 20 ? `\n… (${contents.split("\n").length - 20} more lines)` : "";
      return { call, title: `create ${a.path ?? "?"}`, preview: head + more };
    }
    case "remove-file":
      return { call, title: `delete ${a.path ?? "?"}`, preview: `rm ${a.path ?? "?"}` };
    case "run-command":
      return { call, title: `run: ${String(a.command ?? "").slice(0, 80)}`, preview: `$ ${a.command ?? ""}${a.cwd ? `   (cwd: ${a.cwd})` : ""}` };
    default:
      return { call, title: call.name, preview: JSON.stringify(a, null, 2).slice(0, 800) };
  }
}
