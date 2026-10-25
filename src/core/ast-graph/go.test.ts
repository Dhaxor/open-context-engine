import { describe, it, expect } from "vitest";
import type { File } from "../types";
import { edgesOfKind, extract } from "./test-utils";

// ─── Go ──────────────────────────────────────────────────────────────────────

describe("AST graph: Go", () => {
  it("handles block imports with aliases and blank imports", async () => {
    const file: File = {
      path: "pkg/main.go",
      contents: [
        `package main`,
        ``,
        `import (`,
        `    "fmt"`,
        `    log "github.com/sirupsen/logrus"`,
        `    _ "blank/import"`,
        `)`,
        ``,
        `func Exported() {}`,
        `func unexported() {}`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const imports = edgesOfKind(edges, "imports");
    expect(imports.some(e => e.targetPath === "fmt")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "log" && e.targetPath === "github.com/sirupsen/logrus")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "_" && e.targetPath === "blank/import")).toBe(true);
    const exports = edgesOfKind(edges, "exports");
    expect(exports.some(e => e.sourceSymbol === "Exported")).toBe(true);
    expect(exports.some(e => e.sourceSymbol === "unexported")).toBe(false);
  });
});

