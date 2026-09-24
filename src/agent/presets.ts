/**
 * Provider presets — the shortest path to a working agent, free first.
 *
 * The engine already speaks OpenAI-compatible, Anthropic, Google, and Ollama.
 * What was missing is that using a free provider meant knowing its base URL,
 * its model ids, and which environment variable holds its key. That is three
 * pieces of trivia between a new user and a working agent, and most people
 * stop at the first one.
 *
 * Every preset here is a first-party free tier or a local runtime. None of
 * them proxies somebody else's paid service: an endpoint you are not entitled
 * to can be revoked without notice and should never be the thing a tool
 * depends on.
 */

import { LLMProvider } from "./types";

export type PresetCost = "free" | "free-tier" | "paid";

export interface ProviderPreset {
  /** The name passed to `-p`. */
  id: string;
  label: string;
  /** Which caller implementation to build. */
  provider: LLMProvider;
  cost: PresetCost;
  /** Sensible default model for coding work. */
  model: string;
  /** OpenAI-compatible endpoint, when the provider is not first-party. */
  baseUrl?: string;
  /** Environment variables checked, in order, for the key. */
  keyEnv: string[];
  /** Where to get a key, or how to install the runtime. */
  setup: string;
  /** One line the CLI prints when recommending it. */
  note: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "ollama",
    label: "Ollama (local)",
    provider: "ollama",
    cost: "free",
    model: "qwen2.5-coder:7b",
    baseUrl: "http://localhost:11434",
    keyEnv: [],
    setup: "Install from https://ollama.com, then: ollama pull qwen2.5-coder:7b",
    note: "Runs entirely on your machine. No key, no quota, works offline.",
  },
  {
    id: "google",
    label: "Google Gemini",
    provider: "google",
    cost: "free-tier",
    model: "gemini-2.0-flash",
    keyEnv: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    setup: "Free key at https://aistudio.google.com/apikey",
    note: "The most generous free tier of any hosted model, and a 1M-token window.",
  },
  {
    id: "groq",
    label: "Groq",
    provider: "custom",
    cost: "free-tier",
    model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: ["GROQ_API_KEY"],
    setup: "Free key at https://console.groq.com/keys",
    note: "Very fast, free tier with daily limits.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    provider: "custom",
    cost: "free-tier",
    model: "llama-3.3-70b",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: ["CEREBRAS_API_KEY"],
    setup: "Free key at https://cloud.cerebras.ai",
    note: "Free tier, unusually high throughput.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    provider: "custom",
    cost: "free-tier",
    model: "deepseek/deepseek-chat-v3-0324:free",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: ["OPENROUTER_API_KEY"],
    setup: "Free key at https://openrouter.ai/keys",
    note: "Models suffixed ':free' cost nothing; everything else is pay-as-you-go.",
  },
  {
    id: "openai",
    label: "OpenAI",
    provider: "openai",
    cost: "paid",
    model: "gpt-4o",
    keyEnv: ["OPENAI_API_KEY"],
    setup: "Key at https://platform.openai.com/api-keys",
    note: "Paid per token.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    provider: "anthropic",
    cost: "paid",
    model: "claude-sonnet-4-6",
    keyEnv: ["ANTHROPIC_API_KEY"],
    setup: "Key at https://console.anthropic.com/settings/keys",
    note: "Paid per token.",
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === id.toLowerCase());
}

/** Presets that cost nothing to start with, best-first. */
export function freePresets(): ProviderPreset[] {
  return PROVIDER_PRESETS.filter(p => p.cost !== "paid");
}

/** The key for a preset, from its own env vars then the generic override. */
export function keyFor(preset: ProviderPreset, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of preset.keyEnv) {
    if (env[name]) return env[name];
  }
  return env.OCE_LLM_API_KEY;
}

export interface ResolvedProvider {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  preset?: ProviderPreset;
}

/**
 * Turn `-p <name>` into everything a caller needs.
 *
 * Explicit flags always win: a preset supplies defaults, never an override. An
 * unknown name is passed straight through as a raw provider, so the four
 * built-in provider names keep working exactly as before.
 */
export function resolveProvider(input: {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedProvider {
  const env = input.env ?? process.env;
  const preset = input.provider ? findPreset(input.provider) : undefined;
  if (!preset) {
    return {
      provider: (input.provider ?? "openai") as LLMProvider,
      model: input.model ?? "gpt-4o",
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    };
  }
  const apiKey = input.apiKey ?? keyFor(preset, env);
  const baseUrl = input.baseUrl ?? preset.baseUrl;
  return {
    provider: preset.provider,
    model: input.model ?? preset.model,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    preset,
  };
}

/**
 * Whether a resolved provider can actually make a call, and what to do if not.
 *
 * "Set OPENAI_API_KEY" is a dead end for someone who does not want to pay.
 * The message names the free paths instead, because that is the actual next
 * step for most people who hit this.
 */
export function checkReady(resolved: ResolvedProvider): { ok: true } | { ok: false; message: string } {
  const preset = resolved.preset;
  // Local runtimes need no key — reachability is checked when the call is made.
  if (resolved.provider === "ollama") return { ok: true };
  if (resolved.apiKey) return { ok: true };

  const lines: string[] = [];
  lines.push(preset
    ? `No API key for ${preset.label}. ${preset.setup}`
    : `No API key for provider '${resolved.provider}'.`);
  if (preset?.keyEnv.length) {
    lines.push(`Then set ${preset.keyEnv[0]}, or pass --api-key.`);
  }
  lines.push("");
  lines.push("Free options:");
  for (const free of freePresets()) {
    lines.push(`  oce trace -p ${free.id.padEnd(11)} ${free.note}`);
  }
  lines.push("");
  lines.push("Run 'oce setup' to be walked through it.");
  return { ok: false, message: lines.join("\n") };
}

/** Is a local Ollama actually running? Used by `oce setup` to lead with it. */
export async function probeOllama(baseUrl = "http://localhost:11434", timeoutMs = 1500): Promise<{ up: boolean; models: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { up: false, models: [] };
    const body = await res.json() as { models?: { name?: string }[] };
    return { up: true, models: (body.models ?? []).map(m => m.name ?? "").filter(Boolean) };
  } catch {
    return { up: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
