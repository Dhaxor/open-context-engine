import { describe, it, expect } from "vitest";
import {
  PROVIDER_PRESETS, checkReady, findPreset, freePresets, keyFor, resolveProvider,
} from "./presets";

describe("the preset catalogue", () => {
  it("leads with options that cost nothing", () => {
    expect(freePresets().map(p => p.id)).toEqual(["ollama", "google", "groq", "cerebras", "openrouter"]);
    expect(freePresets().every(p => p.cost !== "paid")).toBe(true);
  });

  it("gives every preset a model and a way to get started", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.model, preset.id).toBeTruthy();
      expect(preset.setup, preset.id).toMatch(/https?:\/\/|Install/);
      expect(preset.note, preset.id).toBeTruthy();
    }
  });

  it("gives every hosted preset a key variable, and the local one none", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === "ollama") expect(preset.keyEnv).toEqual([]);
      else expect(preset.keyEnv.length, preset.id).toBeGreaterThan(0);
    }
  });

  it("routes OpenAI-compatible third parties through the custom caller", () => {
    for (const id of ["groq", "cerebras", "openrouter"]) {
      const preset = findPreset(id)!;
      expect(preset.provider).toBe("custom");
      // Without a base URL the custom caller would talk to OpenAI.
      expect(preset.baseUrl).toMatch(/^https:\/\//);
    }
  });

  it("is case-insensitive and returns nothing for an unknown name", () => {
    expect(findPreset("GROQ")?.id).toBe("groq");
    expect(findPreset("nope")).toBeUndefined();
  });
});

describe("keyFor", () => {
  it("checks the provider's own variables in order", () => {
    const google = findPreset("google")!;
    expect(keyFor(google, { GEMINI_API_KEY: "b" } as any)).toBe("b");
    expect(keyFor(google, { GOOGLE_API_KEY: "a", GEMINI_API_KEY: "b" } as any)).toBe("a");
  });

  it("falls back to the generic override", () => {
    expect(keyFor(findPreset("groq")!, { OCE_LLM_API_KEY: "generic" } as any)).toBe("generic");
  });

  it("returns nothing when no key is present", () => {
    expect(keyFor(findPreset("groq")!, {} as any)).toBeUndefined();
  });
});

describe("resolveProvider", () => {
  it("fills in endpoint, model and key from a preset", () => {
    const resolved = resolveProvider({ provider: "groq", env: { GROQ_API_KEY: "gsk" } as any });
    expect(resolved).toMatchObject({
      provider: "custom",
      model: "llama-3.3-70b-versatile",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "gsk",
    });
  });

  it("lets explicit flags win over the preset", () => {
    const resolved = resolveProvider({
      provider: "groq", model: "my-model", apiKey: "explicit",
      baseUrl: "https://proxy.internal/v1", env: { GROQ_API_KEY: "gsk" } as any,
    });
    expect(resolved).toMatchObject({ model: "my-model", apiKey: "explicit", baseUrl: "https://proxy.internal/v1" });
  });

  it("passes an unknown provider straight through, unchanged", () => {
    // The four original provider names must behave exactly as before.
    const resolved = resolveProvider({ provider: "anthropic", model: "claude-x", env: {} as any });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-x");
    expect(resolved.preset?.id).toBe("anthropic");

    const raw = resolveProvider({ provider: "some-future-thing", env: {} as any });
    expect(raw.provider).toBe("some-future-thing");
    expect(raw.preset).toBeUndefined();
  });

  it("defaults to openai when nothing is named", () => {
    expect(resolveProvider({ env: {} as any })).toMatchObject({ provider: "openai", model: "gpt-4o" });
  });

  it("gives ollama its local endpoint without a key", () => {
    const resolved = resolveProvider({ provider: "ollama", env: {} as any });
    expect(resolved.baseUrl).toBe("http://localhost:11434");
    expect(resolved.apiKey).toBeUndefined();
  });
});

describe("checkReady", () => {
  it("passes when a key is present", () => {
    expect(checkReady(resolveProvider({ provider: "groq", env: { GROQ_API_KEY: "k" } as any }))).toEqual({ ok: true });
  });

  it("passes for a local runtime, which needs no key", () => {
    expect(checkReady(resolveProvider({ provider: "ollama", env: {} as any }))).toEqual({ ok: true });
  });

  it("names the free paths rather than dead-ending on 'set OPENAI_API_KEY'", () => {
    const result = checkReady(resolveProvider({ provider: "openai", env: {} as any }));
    expect(result.ok).toBe(false);
    const message = (result as { message: string }).message;
    // Someone who does not want to pay needs a next step, not a restatement.
    expect(message).toContain("Free options:");
    expect(message).toContain("-p ollama");
    expect(message).toContain("-p google");
    expect(message).toContain("oce setup");
  });

  it("says where to get the key for the provider that was actually asked for", () => {
    const result = checkReady(resolveProvider({ provider: "groq", env: {} as any }));
    const message = (result as { message: string }).message;
    expect(message).toContain("Groq");
    expect(message).toContain("console.groq.com");
    expect(message).toContain("GROQ_API_KEY");
  });
});
