import { describe, it, expect } from "vitest";
import { ParserPool } from "./ast-graph-shared";
import { extractEdgesFromTree, ExtractionResult } from "./ast-graph-extractor";
import { extractEdges } from "./graph-extractor";
import { GraphEdge } from "./code-graph";
import { File } from "./types";
import { edgesOfKind, extract } from "./ast-graph/test-utils";

function hasEdge(edges: GraphEdge[], pred: (e: GraphEdge) => boolean): boolean {
  return edges.some(pred);
}

// ─── Rust ────────────────────────────────────────────────────────────────────

describe("AST graph: Rust", () => {
  it("expands nested use lists and aliases", async () => {
    const file: File = {
      path: "src/lib.rs",
      contents: [
        `use crate::a::{b, c::d as renamed};`,
        `use foo::*;`,
        `pub fn exported() {}`,
        `fn private() {}`,
        `impl Display for MyType {}`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const imports = edgesOfKind(edges, "imports");
    expect(imports.some(e => e.sourceSymbol === "b")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "renamed")).toBe(true);
    expect(imports.some(e => e.targetSymbol === "*")).toBe(true);
    const exports = edgesOfKind(edges, "exports");
    expect(exports.some(e => e.sourceSymbol === "exported")).toBe(true);
    expect(exports.some(e => e.sourceSymbol === "private")).toBe(false);
    const impl = edgesOfKind(edges, "implements");
    expect(impl.some(e => e.sourceSymbol === "MyType" && e.targetSymbol === "Display")).toBe(true);
  });
});

// ─── Java ────────────────────────────────────────────────────────────────────

describe("AST graph: Java", () => {
  it("handles static / wildcard imports and class heritage with generics", async () => {
    const file: File = {
      path: "src/com/example/Foo.java",
      contents: [
        `package com.example;`,
        `import static java.lang.Math.PI;`,
        `import java.util.*;`,
        ``,
        `public class Dog extends ArrayList<Bone> implements Comparable<Dog> {}`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const imports = edgesOfKind(edges, "imports");
    expect(imports.some(e => e.targetPath === "java/lang/Math/PI")).toBe(true);
    expect(imports.some(e => e.targetPath.startsWith("java/util"))).toBe(true);
    const ext = edgesOfKind(edges, "extends");
    expect(ext.some(e => e.sourceSymbol === "Dog" && e.targetSymbol === "ArrayList")).toBe(true);
    const impl = edgesOfKind(edges, "implements");
    expect(impl.some(e => e.sourceSymbol === "Dog" && e.targetSymbol === "Comparable")).toBe(true);
  });
});

// ─── C# ──────────────────────────────────────────────────────────────────────

describe("AST graph: C#", () => {
  it("handles using directives + class base list classification", async () => {
    const file: File = {
      path: "src/Foo.cs",
      contents: [
        `using System;`,
        `using System.Collections.Generic;`,
        ``,
        `public class Foo : Bar, IComparable<Foo>, IDisposable {}`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const imports = edgesOfKind(edges, "imports");
    expect(imports.some(e => e.targetPath === "System")).toBe(true);
    expect(imports.some(e => e.targetPath.startsWith("System/Collections"))).toBe(true);
    const ext = edgesOfKind(edges, "extends");
    const impl = edgesOfKind(edges, "implements");
    expect(ext.some(e => e.sourceSymbol === "Foo" && e.targetSymbol === "Bar")).toBe(true);
    expect(impl.some(e => e.sourceSymbol === "Foo" && e.targetSymbol === "IComparable")).toBe(true);
    expect(impl.some(e => e.sourceSymbol === "Foo" && e.targetSymbol === "IDisposable")).toBe(true);
  });
});

// ─── Dispatcher fallback ─────────────────────────────────────────────────────

describe("graph-extractor dispatcher", () => {
  it("falls back to the regex extractor when no tree is provided", () => {
    const file: File = {
      path: "src/a.ts",
      contents: `import { foo } from './b';`,
    };
    const { edges } = extractEdges(file, "typescript", null);
    // Regex path emits the same shape — at least one imports edge present.
    expect(hasEdge(edges, e => e.kind === "imports" && e.targetPath === "src/b")).toBe(true);
  });

  it("returns empty result for an unknown language with no tree", () => {
    const file: File = { path: "src/a.lua", contents: `local x = 1` };
    expect(extractEdges(file, null, null)).toEqual({ edges: [], exports: [] });
  });
});

// ─── Parse reuse counter ─────────────────────────────────────────────────────

describe("parse reuse", () => {
  it("a single ParserPool serves one parseFile per file with disposal", async () => {
    const localPool = new ParserPool();
    try {
      const files: File[] = [
        { path: "a.ts", contents: `import { x } from './m';` },
        { path: "b.py", contents: `from m import x` },
        { path: "c.go", contents: `package main\nimport "fmt"` },
      ];
      const results: ExtractionResult[] = [];
      for (const f of files) {
        const parsed = await localPool.parseFile(f.path, f.contents);
        expect(parsed).not.toBeNull();
        try {
          results.push(extractEdgesFromTree(f, parsed!.language, parsed!.tree));
        } finally {
          parsed!.dispose();
        }
      }
      expect(results.every(r => r.edges.length > 0)).toBe(true);
    } finally {
      localPool.disposeAll();
    }
  });
});
