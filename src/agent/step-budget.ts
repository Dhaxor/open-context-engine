export interface StepBudgetConfig {
  baseSimple?: number;
  baseComplex?: number;
  maxBudget?: number;
  extensionSize?: number;
}

const COMPLEX_TRIGGERS = /\b(refactor|redesign|architect|implement|migrate|convert|rewrite|optimize|build|create a|add a new|design)\b/i;
const SIMPLE_TRIGGERS = /\b(what is|where is|show me|find|which file|how many|list|explain)\b/i;

export class StepBudget {
  private initial: number;
  private remaining: number;
  private maxBudget: number;
  private extensionSize: number;
  private extensions = 0;
  private maxExtensions = 3;
  private previousCalls: string[] = [];

  constructor(query: string, config: StepBudgetConfig = {}) {
    const complexity = classifyComplexity(query);
    const baseSimple = config.baseSimple ?? 8;
    const baseComplex = config.baseComplex ?? 15;
    this.maxBudget = config.maxBudget ?? 25;
    this.extensionSize = config.extensionSize ?? 5;

    this.initial = complexity === "complex" ? baseComplex : baseSimple;
    this.remaining = this.initial;
  }

  shouldContinue(toolName?: string, toolArgs?: Record<string, any>): boolean {
    if (this.remaining <= 0) return false;

    if (toolName && toolArgs) {
      const callSig = `${toolName}:${JSON.stringify(toolArgs)}`;
      const duplicateCount = this.previousCalls.filter(c => c === callSig).length;
      if (duplicateCount >= 2) return false;
      this.previousCalls.push(callSig);
    }

    this.remaining--;
    return true;
  }

  requestExtension(lastResultLength: number): boolean {
    if (this.extensions >= this.maxExtensions) return false;
    if (this.getTotalUsed() + this.extensionSize > this.maxBudget) return false;
    if (lastResultLength < 100) return false;

    this.remaining += this.extensionSize;
    this.extensions++;
    return true;
  }

  getTotalUsed(): number {
    return this.initial + (this.extensions * this.extensionSize) - this.remaining;
  }

  getRemaining(): number {
    return this.remaining;
  }

  isLooping(toolName: string, toolArgs: Record<string, any>): boolean {
    const callSig = `${toolName}:${JSON.stringify(toolArgs)}`;
    return this.previousCalls.filter(c => c === callSig).length >= 2;
  }
}

function classifyComplexity(query: string): "simple" | "complex" {
  if (COMPLEX_TRIGGERS.test(query)) return "complex";
  if (SIMPLE_TRIGGERS.test(query)) return "simple";
  if (query.length > 200) return "complex";
  if (query.split("?").length > 2) return "complex";
  return "simple";
}
