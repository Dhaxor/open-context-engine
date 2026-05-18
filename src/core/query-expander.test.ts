import { describe, it, expect } from "vitest";
import { expandQuery } from "./query-expander";

describe("expandQuery", () => {
  it("adds synonyms for common code actions", () => {
    const result = expandQuery("delete user account");
    expect(result.original).toBe("delete user account");
    expect(result.terms.length).toBeGreaterThan(0);
    expect(result.terms).toContain("remove");
    expect(result.expanded).toContain("remove");
  });

  it("expands camelCase identifiers", () => {
    const result = expandQuery("getUserName function");
    expect(result.terms).toContain("user");
    expect(result.terms).toContain("name");
  });

  it("expands snake_case identifiers", () => {
    const result = expandQuery("get_user_name");
    expect(result.terms).toContain("user");
    expect(result.terms).toContain("name");
  });

  it("does not duplicate existing tokens as expansions", () => {
    const result = expandQuery("remove file");
    expect(result.terms.filter(t => t === "remove")).toHaveLength(0);
  });

  it("handles queries with no expandable terms", () => {
    const result = expandQuery("xyz abc");
    expect(result.expanded).toBe("xyz abc");
    expect(result.terms).toHaveLength(0);
  });

  it("limits synonym expansion", () => {
    const result = expandQuery("create");
    expect(result.terms.length).toBeLessThanOrEqual(3);
  });

  it("expands multiple action words", () => {
    const result = expandQuery("fetch and update the config");
    expect(result.terms.some(t => ["retrieve", "load", "find", "get"].includes(t))).toBe(true);
    expect(result.terms.some(t => ["modify", "patch", "change"].includes(t))).toBe(true);
  });
});
