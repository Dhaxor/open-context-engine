import { describe, expect, it } from "vitest";
import { chunkTextsByBatchBudget } from "./embedder";

describe("chunkTextsByBatchBudget", () => {
  it("respects max item count", () => {
    const batches = chunkTextsByBatchBudget(["a", "b", "c", "d", "e"], 2, 100);
    expect(batches).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("splits before exceeding the character budget", () => {
    const batches = chunkTextsByBatchBudget(["aaaa", "bbbb", "cc", "dddd"], 10, 8);
    expect(batches).toEqual([["aaaa", "bbbb"], ["cc", "dddd"]]);
  });

  it("allows a single oversized text so callers can still embed one item", () => {
    const batches = chunkTextsByBatchBudget(["abcdefghij", "k"], 10, 5);
    expect(batches).toEqual([["abcdefghij"], ["k"]]);
  });
});
