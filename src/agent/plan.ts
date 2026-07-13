import { ToolDefinition } from "./types";

/**
 * Agent plan (todo list) — the pattern every leading harness converged on:
 * the model maintains an explicit step checklist via a tool, the UI renders
 * it live, and the visible plan keeps long multi-step work on track.
 *
 * The plan is owned by whoever builds the agent (CLI/extension), passed into
 * `planTool`, and read back for display. Each tool call REPLACES the whole
 * list (idempotent, no diff protocol to get wrong).
 */

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export class AgentPlan {
  private steps: PlanStep[] = [];
  private listeners: ((steps: PlanStep[]) => void)[] = [];

  getSteps(): PlanStep[] { return this.steps.map(s => ({ ...s })); }
  isEmpty(): boolean { return this.steps.length === 0; }

  set(steps: PlanStep[]): void {
    this.steps = steps.map(s => ({ step: String(s.step), status: normalizeStatus(s.status) }));
    for (const l of this.listeners) { try { l(this.getSteps()); } catch {} }
  }

  clear(): void { this.set([]); }

  onUpdate(listener: (steps: PlanStep[]) => void): void {
    this.listeners.push(listener);
  }

  /** Plain-text checklist (also what the model sees back from the tool). */
  render(): string {
    if (!this.steps.length) return "(no plan)";
    return this.steps
      .map(s => `${s.status === "completed" ? "[x]" : s.status === "in_progress" ? "[~]" : "[ ]"} ${s.step}`)
      .join("\n");
  }
}

function normalizeStatus(s: unknown): PlanStepStatus {
  return s === "completed" || s === "in_progress" ? s : "pending";
}

export function planTool(plan: AgentPlan): ToolDefinition {
  return {
    name: "update-plan",
    description:
      "Maintain your step-by-step plan for the current task. Call this FIRST on any multi-step task with the full list of steps, then again whenever a step's status changes (mark exactly one step in_progress at a time; mark steps completed as you finish them). The whole list replaces the previous plan. Skip it for trivial single-step requests.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "The complete, ordered plan.",
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "Short imperative description of the step." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["steps"],
    },
    handler: async (args) => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      plan.set(steps);
      return `Plan updated:\n${plan.render()}`;
    },
  };
}
