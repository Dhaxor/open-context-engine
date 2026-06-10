import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ParserPool } from "./ast-graph-shared";
import { extractEdgesFromTree, ExtractionResult } from "./ast-graph-extractor";
import { extractEdges } from "./graph-extractor";
import { GraphEdge } from "./code-graph";
import { File } from "./types";

// One ParserPool for the whole suite so we don't re-init web-tree-sitter per
// test. The pool is disposed in afterAll.
let pool: ParserPool;
beforeAll(() => { pool = new ParserPool(); });
afterAll(() => { pool.disposeAll(); });

async function extract(file: File): Promise<ExtractionResult> {
  const parsed = await pool.parseFile(file.path, file.contents);
  if (!parsed) throw new Error(`pool.parseFile returned null for ${file.path}`);
  try {
    return extractEdgesFromTree(file, parsed.language, parsed.tree);
  } finally {
    parsed.dispose();
  }
}

function hasEdge(edges: GraphEdge[], pred: (e: GraphEdge) => boolean): boolean {
  return edges.some(pred);
}
function edgesOfKind(edges: GraphEdge[], kind: GraphEdge["kind"]): GraphEdge[] {
  return edges.filter(e => e.kind === kind);
}

// ─── TypeScript ──────────────────────────────────────────────────────────────

describe("AST graph: TypeScript", () => {
  it("recognises named, default, namespace, side-effect, and dynamic imports", async () => {
    const file: File = {
      path: "src/foo.ts",
      contents: [
        `import Default, { a, b as c } from './m';`,
        `import * as ns from './n';`,
        `import './side';`,
        `const x = await import('./dyn');`,
        `const y = require('./req');`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const imports = edgesOfKind(edges, "imports");
    expect(imports.some(e => e.sourceSymbol === "Default" && e.targetPath === "src/m" && e.targetSymbol === "default")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "a" && e.targetPath === "src/m")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "c" && e.targetSymbol === "b" && e.targetPath === "src/m")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "ns" && e.targetPath === "src/n")).toBe(true);
    // side-effect: no sourceSymbol but still an import edge
    expect(imports.some(e => !e.sourceSymbol && e.targetPath === "src/side")).toBe(true);
    // dynamic import + require
    expect(imports.some(e => e.targetPath === "src/dyn")).toBe(true);
    expect(imports.some(e => e.targetPath === "src/req")).toBe(true);
  });

  it("emits BOTH imports and exports edges for re-exports (the barrel-file fix)", async () => {
    const file: File = {
      path: "src/barrel.ts",
      contents: [
        `export { a, b as c } from './x';`,
        `export * from './y';`,
        `export * as ns from './z';`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const imports = edgesOfKind(edges, "imports");
    const exports = edgesOfKind(edges, "exports");
    expect(imports.some(e => e.sourceSymbol === "a" && e.targetPath === "src/x")).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "c" && e.targetSymbol === "b" && e.targetPath === "src/x")).toBe(true);
    expect(imports.some(e => e.targetPath === "src/y" && !e.sourceSymbol)).toBe(true);
    expect(imports.some(e => e.sourceSymbol === "ns" && e.targetPath === "src/z")).toBe(true);
    expect(exports.some(e => e.sourceSymbol === "a")).toBe(true);
    expect(exports.some(e => e.sourceSymbol === "c")).toBe(true);
    expect(exports.some(e => e.sourceSymbol === "ns")).toBe(true);
  });

  it("does NOT emit a phantom calls edge for a type-only import", async () => {
    const file: File = {
      path: "src/a.ts",
      contents: [
        `import type { Foo } from './types';`,
        `import { realFn } from './m';`,
        `function go() { realFn(); (null as Foo); }`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const calls = edgesOfKind(edges, "calls");
    // realFn() resolves to a real import — calls edge present
    expect(calls.some(e => e.targetPath === "src/m" && e.targetSymbol === "realFn")).toBe(true);
    // Foo is type-only; no calls edge for it (we never emit Foo() — TS would error — but the type table must not pull it in)
    expect(calls.some(e => e.targetSymbol === "Foo")).toBe(false);
  });

  it("emits an extends edge for class heritage", async () => {
    const file: File = {
      path: "src/c.ts",
      contents: [
        `import { Base } from './b';`,
        `import { I1, I2 } from './i';`,
        `export class Foo extends Base implements I1, I2 {}`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const ext = edgesOfKind(edges, "extends");
    const impl = edgesOfKind(edges, "implements");
    expect(ext.some(e => e.sourceSymbol === "Foo" && e.targetSymbol === "Base")).toBe(true);
    expect(impl.some(e => e.sourceSymbol === "Foo" && e.targetSymbol === "I1")).toBe(true);
    expect(impl.some(e => e.sourceSymbol === "Foo" && e.targetSymbol === "I2")).toBe(true);
  });

  it("does not produce a fake import for `import` inside a string or comment", async () => {
    const file: File = {
      path: "src/c.ts",
      contents: [
        `// import { fake } from './fake';`,
        `const s = "import './alsoFake'";`,
        `import { real } from './real';`,
      ].join("\n"),
    };
    const { edges } = await extract(file);
    const imports = edgesOfKind(edges, "imports");
    expect(imports.length).toBe(1);
    expect(imports[0].targetPath).toBe("src/real");
  });

  it("calls visitor short-circuits when the import table is empty", async () => {
    // No imports at all → calls() in the body should not produce edges.
    const file: File = {
      path: "src/no-imports.ts",
      contents: `function go() { console.log('x'); helper(); }`,
    };
    const { edges } = await extract(file);
    expect(edgesOfKind(edges, "calls").length).toBe(0);
  });
});

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
