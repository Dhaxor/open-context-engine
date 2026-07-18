import { describe, it, expect } from "vitest";
import type { File } from "../types";
import { edgesOfKind, extract } from "./test-utils";

// ─── Python ──────────────────────────────────────────────────────────────────

describe("AST graph: Python", () => {
  it("handles `from .pkg import y as z` and `from __future__`", async () => {
    const file: File = {
      path: "pkg/mod.py",
      contents: [
        `from __future__ import annotations`,
        `from .util import helper as h`,
        `from ..other import thing`,
        `import json`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const imports = edgesOfKind(edges, "imports");
    expect(imports.some(e => e.sourceSymbol === "annotations")).toBe(true);     // future_import_statement was walked
    expect(imports.some(e => e.sourceSymbol === "h" && e.targetSymbol === "helper")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "thing")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "json")).toBe(true);
  });

  it("class bases produce extends edges; metaclass=… is silently dropped", async () => {
    const file: File = {
      path: "pkg/c.py",
      contents: [
        `class A(Base, metaclass=ABCMeta):`,
        `    pass`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const ext = edgesOfKind(edges, "extends");
    expect(ext.some(e => e.sourceSymbol === "A" && e.targetSymbol === "Base")).toBe(true);
    expect(ext.some(e => e.targetSymbol === "ABCMeta")).toBe(false);
  });

  it("module-level def/class are exports; nested defs are not", async () => {
    const file: File = {
      path: "pkg/m.py",
      contents: [
        `def top():`,
        `    def inner(): pass`,
        `class Outer:`,
        `    def method(self): pass`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const exports = edgesOfKind(edges, "exports");
    expect(exports.some(e => e.sourceSymbol === "top")).toBe(true);
    expect(exports.some(e => e.sourceSymbol === "Outer")).toBe(true);
    expect(exports.some(e => e.sourceSymbol === "inner")).toBe(false);
    expect(exports.some(e => e.sourceSymbol === "method")).toBe(false);
  });
});

