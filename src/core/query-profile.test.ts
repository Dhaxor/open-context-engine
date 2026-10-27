import { describe, expect, it } from "vitest";
import { classifyQueryShape, fusionProfile } from "./query-profile";
import { reciprocalRankFusion } from "./retriever";
import { SearchResult } from "./types";

describe("classifyQueryShape", () => {
  const definition = [
    "the main Flask application class",           // capitalised + code noun (the Flask gold shape)
    "what does the SessionInterface class do?",   // PascalCase symbol outweighs the interrogative
    "getUserData helper",                         // camelCase
    "parse_agent_config",                         // snake_case
    "where is MAX_RETRIES defined",               // SCREAMING_CASE
    "the code in src/core/retriever.ts",          // file path
    'the "create_table" function',                // quoted symbol
    "handle2fa verification",                     // embedded digit identifier
  ];
  it.each(definition)("classifies as definition: %s", q => {
    expect(classifyQueryShape(q)).toBe("definition");
  });

  const intent = [
    "how does the auth middleware work?",         // the canonical intent shape
    "where is the search config validated and applied?",
    "why is indexing slow on large repos?",
    "How to add a new language chunker",
    "overview of the streaming pipeline",
  ];
  it.each(intent)("classifies as intent: %s", q => {
    expect(classifyQueryShape(q)).toBe("intent");
  });
});

describe("fusionProfile weights", () => {
  it("leans BM25 for definition-shaped queries", () => {
    const p = fusionProfile("the main Flask application class");
    expect(p.shape).toBe("definition");
    expect(p.bm25).toBeGreaterThan(1);
    expect(p.vector).toBeLessThan(1);
  });

  it("leans semantic for intent-shaped queries", () => {
    const p = fusionProfile("how does the auth middleware work?");
    expect(p.shape).toBe("intent");
    expect(p.vector).toBeGreaterThan(1);
  });

  it("reports the evidence it saw", () => {
    const p = fusionProfile("what does the SessionInterface class do?");
    expect(p.signals.join(" ")).toMatch(/camelCase|code noun/);
  });
});

function hit(id: string, bm25?: number, vector?: number): SearchResult {
  return {
    chunk: { id, path: `${id}.ts`, startLine: 1, endLine: 10, contents: `// ${id}` },
    score: 0,
    ...(bm25 !== undefined ? { bm25Score: bm25 } : {}),
    ...(vector !== undefined ? { vectorScore: vector } : {}),
  } as SearchResult;
}

// The measured Flask inversion, as ranked lists: the gold file is BM25's
// confident rank-1 (exact vocabulary, big score gap) while the semantic ranker
// prefers a test/doc distractor. Equal-weight RRF demotes the gold; the
// definition-shaped profile must flip the order.
describe("adaptive fusion vs the Flask inversion", () => {
  const gold = hit("app", 7.42, 0.42);       // BM25 #1 (strong outlier), vector #15
  const distractor = hit("test_app", 3.10, 0.11); // vector #1, BM25 #10
  const others = [
    hit("factory", 5.01, 0.30),              // BM25 #2, vector #4
    hit("docs", 1.20, 0.08),                 // vector #2
  ];

  it("equal weights demote the gold (documents the regression)", () => {
    const fused = reciprocalRankFusion(
      [
        { results: [distractor, others[1], others[0], gold], weight: 1 }, // vector order
        { results: [gold, others[0], distractor, others[1]], weight: 1 }, // bm25 order
      ],
      10,
    );
    expect(fused[0].chunk.id).toBe(distractor.chunk.id);
    expect(fused.findIndex(r => r.chunk.id === gold.chunk.id)).toBeGreaterThan(0);
  });

  it("definition-shaped weights restore the gold to rank 1", () => {
    const profile = fusionProfile("the main Flask application class");
    const fused = reciprocalRankFusion(
      [
        { results: [distractor, others[1], others[0], gold], weight: profile.vector },
        { results: [gold, others[0], distractor, others[1]], weight: profile.bm25 },
      ],
      10,
    );
    expect(fused[0].chunk.id).toBe(gold.chunk.id);
  });

  it("intent-shaped weights stay semantic-leaning (no regression the other way)", () => {
    const profile = fusionProfile("how does the auth middleware work?");
    const fused = reciprocalRankFusion(
      [
        { results: [distractor, others[1], others[0], gold], weight: profile.vector },
        { results: [gold, others[0], distractor, others[1]], weight: profile.bm25 },
      ],
      10,
    );
    expect(fused[0].chunk.id).toBe(distractor.chunk.id);
  });
});
