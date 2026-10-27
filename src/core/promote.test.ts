import { describe, expect, it } from "vitest";
import { promoteDeclarationMatches } from "./retriever";
import { SearchResult } from "./types";

function hit(id: string, score: number, symbolName?: string): SearchResult {
  return { chunk: { id, path: id + ".py", startLine: 1, endLine: 5, contents: "// " + id, symbolName }, score } as SearchResult;
}

describe("promoteDeclarationMatches", () => {
  it("lifts the declaring chunk above semantically-hot mentioners", () => {
    const results = [hit("helpers-make_response", 0.0687, "make_response"), hit("views-dispatch", 0.0568, "dispatch_request"), hit("wrappers-Response", 0.0300, "Response"), hit("docs", 0.0481)];
    const out = promoteDeclarationMatches(results, "Response subclass returned by views");
    expect(out[0].chunk.id).toBe("wrappers-Response");
    expect(out[0].score).toBeGreaterThan(0.0687);
  });

  it("does nothing for intent queries without identifier tokens", () => {
    const results = [hit("a", 0.05), hit("b", 0.04)];
    expect(promoteDeclarationMatches(results, "the main application")).toHaveLength(2);
  });

  it("caps promotions at 3", () => {
    const results = [hit("a", 0.05, "Alpha"), hit("b", 0.04, "Beta"), hit("c", 0.03, "Gamma"), hit("d", 0.02, "Delta")];
    const out = promoteDeclarationMatches(results, "Alpha Beta Gamma Delta definitions");
    const promoted = out.filter(r => r.score > 0.05).length;
    expect(promoted).toBe(3);
  });
});
