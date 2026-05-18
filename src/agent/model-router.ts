import { LLMProvider, AgentMessage } from "./types";
import { LLMCaller, OpenAICaller, AnthropicCaller } from "./providers";

export interface ModelTier {
  name: string;
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens: number;
}

export interface RoutingConfig {
  fast: ModelTier;
  standard: ModelTier;
  reasoning: ModelTier;
}

const COMPLEX_PATTERNS = [
  /\b(refactor|redesign|architect|rewrite|migrate|implement a new|design a|build a|create a complete|optimize the entire)\b/i,
  /\b(across all|multiple files|entire codebase|end.to.end|full.stack)\b/i,
  /\b(explain why|trade.?offs?|compare|analyze|evaluate|recommend)\b/i,
];

const SIMPLE_PATTERNS = [
  /\b(what is|where is|show me|find|which file|list all|how many|what does)\b/i,
  /\b(syntax for|example of|quick|simple|just)\b/i,
];

export class ModelRouter {
  private callers = new Map<string, LLMCaller>();
  private config: RoutingConfig;

  constructor(config: RoutingConfig) {
    this.config = config;
  }

  classify(query: string, history: AgentMessage[] = []): ModelTier {
    const conversationDepth = history.filter(m => m.role === "user").length;
    if (conversationDepth > 5) return this.config.reasoning;

    for (const pattern of COMPLEX_PATTERNS) {
      if (pattern.test(query)) return this.config.reasoning;
    }

    for (const pattern of SIMPLE_PATTERNS) {
      if (pattern.test(query)) return this.config.fast;
    }

    if (query.length > 300) return this.config.reasoning;
    if (query.split("?").length > 2) return this.config.reasoning;
    if (query.length < 60) return this.config.fast;

    return this.config.standard;
  }

  getCaller(tier: ModelTier): LLMCaller {
    const key = `${tier.provider}:${tier.model}`;
    let caller = this.callers.get(key);
    if (!caller) {
      const apiKey = tier.apiKey ?? envKey(tier.provider);
      if (!apiKey) throw new Error(`Missing API key for ${tier.provider}`);
      if (tier.provider === "openai") {
        caller = new OpenAICaller(tier.model, apiKey, tier.baseUrl, tier.maxTokens);
      } else if (tier.provider === "anthropic") {
        caller = new AnthropicCaller(tier.model, apiKey, tier.baseUrl, tier.maxTokens);
      } else {
        throw new Error(`Unsupported provider for routing: ${tier.provider}`);
      }
      this.callers.set(key, caller);
    }
    return caller;
  }

  getCallerForQuery(query: string, history: AgentMessage[] = []): { caller: LLMCaller; tier: ModelTier } {
    const tier = this.classify(query, history);
    return { caller: this.getCaller(tier), tier };
  }
}

function envKey(provider: LLMProvider): string {
  if (provider === "openai") return process.env.OPENAI_API_KEY ?? "";
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY ?? "";
  if (provider === "google") return process.env.GOOGLE_API_KEY ?? "";
  return "";
}
