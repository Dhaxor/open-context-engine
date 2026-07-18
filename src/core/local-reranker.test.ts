import { describe, it, expect, afterEach } from "vitest";
import { LocalReranker, createReranker } from "./reranker";
import { __setTransformersLoaderForTests } from "./embedder";
import { Chunk } from "./types";

afterEach(() => {
  __setTransformersLoaderForTests(null);
});

function chunk(id: string, contents: string): Chunk {
  return { id, path: `src/${id}.ts`, startLine: 1, endLine: 5, contents };
}

/** Fake transformers: cross-encoder scores a pair higher when the doc contains
 *  the word "auth" — deterministic ranking we can assert on. */
function fakeTransformers(callLog: { batches: number }) {
  return {
    env: {},
    AutoTokenizer: {
      from_pretrained: async () => (queries: string[], opts: { text_pair: string[] }) => ({
        _pairs: queries.map((q, i) => ({ q, d: opts.text_pair[i] })),
      }),
    },
    AutoModelForSequenceClassification: {
      from_pretrained: async () => async (inputs: { _pairs: { q: string; d: string }[] }) => {
        callLog.batches++;
        // Positive logit for relevant docs, negative otherwise.
        const data = Float32Array.from(inputs._pairs.map(p => (p.d.includes("auth") ? 3 : -3)));
        return { logits: { data, dims: [inputs._pairs.length, 1] } };
      },
    },
  };
}

describe("LocalReranker", () => {
  it("reranks by cross-encoder score and honors topK", async () => {
    const log = { batches: 0 };
    __setTransformersLoaderForTests(async () => fakeTransformers(log));
    const rr = new LocalReranker({ provider: "local" });
    const chunks = [
      chunk("noise1", "misc utility helpers"),
      chunk("hit", "function authenticate() {} // auth middleware"),
      chunk("noise2", "rendering code"),
    ];
    const out = await rr.rerank("how does auth work", chunks, 2);
    expect(out).toHaveLength(2);
    expect(out[0].chunk.id).toBe("hit");
    expect(out[0].rerankScore).toBeGreaterThan(0.9);   // sigmoid(3)
    expect(out[1].rerankScore).toBeLessThan(0.1);       // sigmoid(-3)
  });

  it("batches large candidate sets", async () => {
    const log = { batches: 0 };
    __setTransformersLoaderForTests(async () => fakeTransformers(log));
    const rr = new LocalReranker({ provider: "local" });
    const chunks = Array.from({ length: 20 }, (_, i) => chunk(`c${i}`, `doc ${i}`));
    await rr.rerank("q", chunks, 20);
    expect(log.batches).toBe(3); // 20 docs / batch of 8
  });

  it("gives an actionable install error when the optional dep is missing", async () => {
    __setTransformersLoaderForTests(async () => { throw new Error("Cannot find module"); });
    const rr = new LocalReranker({ provider: "local" });
    await expect(rr.rerank("q", [chunk("a", "x")], 5)).rejects.toThrow(/@huggingface\/transformers/);
  });

  it("is constructed by createReranker for provider 'local' with the standard model", () => {
    const rr = createReranker({ provider: "local" })!;
    expect(rr).toBeInstanceOf(LocalReranker);
    expect(rr.getModel()).toBe("Xenova/ms-marco-MiniLM-L-6-v2");
  });
});
