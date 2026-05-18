import { describe, it, expect } from "vitest";
import { getRelevantGuidelines, Guidelines } from "./guidelines";

describe("getRelevantGuidelines", () => {
  const mockGuidelines: Guidelines = {
    raw: "",
    filePath: ".context-guidelines",
    lastModified: Date.now(),
    sections: [
      { title: "General", content: "Always use descriptive variable names." },
      { title: "TypeScript", content: "Prefer interfaces over types.", scope: "*.ts,*.tsx" },
      { title: "Python", content: "Use type hints everywhere.", scope: "*.py" },
      { title: "Error Handling", content: "Always use custom error classes." },
    ],
  };

  it("returns all unscoped sections when no context", () => {
    const result = getRelevantGuidelines(mockGuidelines);
    expect(result).toContain("General");
    expect(result).toContain("descriptive variable names");
    expect(result).toContain("Error Handling");
    expect(result).not.toContain("type hints");
  });

  it("includes scoped sections matching file paths", () => {
    const result = getRelevantGuidelines(mockGuidelines, { paths: ["src/main.ts"] });
    expect(result).toContain("TypeScript");
    expect(result).toContain("interfaces over types");
    expect(result).not.toContain("type hints");
  });

  it("includes Python section for .py files", () => {
    const result = getRelevantGuidelines(mockGuidelines, { paths: ["scripts/build.py"] });
    expect(result).toContain("Python");
    expect(result).toContain("type hints");
    expect(result).not.toContain("interfaces");
  });

  it("returns empty string for null guidelines", () => {
    const result = getRelevantGuidelines(null);
    expect(result).toBe("");
  });

  it("returns empty string for guidelines with no sections", () => {
    const empty: Guidelines = { raw: "", sections: [], filePath: "", lastModified: 0 };
    const result = getRelevantGuidelines(empty);
    expect(result).toBe("");
  });
});
