import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AstChunker } from "./ast-chunker";
import { CodeChunker } from "./chunker";
import { File } from "./types";
import { extractEdges } from "./graph-extractor";

/** Coverage for the second-wave languages: C, C++, Ruby, PHP, Kotlin, Swift.
 *  Each language gets (a) semantic chunking with real symbol names and
 *  (b) graph extraction of imports/exports/heritage where the grammar allows. */

function file(contents: string, p: string): File { return { path: p, contents }; }

let chunker: AstChunker;

beforeAll(() => {
  chunker = new AstChunker({ maxChunkChars: 20000, fallback: new CodeChunker(80, 15, 20000) });
});

afterAll(() => { chunker.dispose(); });

async function chunkAndEdges(f: File) {
  const parsed = await chunker.parseFile(f);
  expect(parsed, `expected ${f.path} to parse`).toBeTruthy();
  try {
    const chunks = await chunker.chunkFile(f, { parsed });
    const graph = extractEdges(f, parsed!.language, parsed!.tree);
    return { chunks, graph };
  } finally {
    parsed!.dispose();
  }
}

describe("extension mapping (new languages)", () => {
  it("maps the new extensions to grammars", () => {
    expect(AstChunker.languageFor("a.c")).toBe("c");
    expect(AstChunker.languageFor("a.h")).toBe("cpp");
    expect(AstChunker.languageFor("a.cpp")).toBe("cpp");
    expect(AstChunker.languageFor("a.hpp")).toBe("cpp");
    expect(AstChunker.languageFor("a.rb")).toBe("ruby");
    expect(AstChunker.languageFor("a.php")).toBe("php");
    expect(AstChunker.languageFor("a.kt")).toBe("kotlin");
    expect(AstChunker.languageFor("a.swift")).toBe("swift");
  });
});

describe("C", () => {
  const src = [
    '#include "util.h"',
    "#include <stdio.h>",
    "typedef struct Point { int x; int y; } Point;",
    "enum Color { RED, GREEN };",
    "static int helper(int a) { return a * 2; }",
    "int main(int argc, char **argv) {",
    "  return helper(argc);",
    "}",
  ].join("\n");

  it("chunks functions and types with names", async () => {
    const { chunks } = await chunkAndEdges(file(src, "src/main.c"));
    const byName = new Map(chunks.map(c => [c.symbolName, c]));
    expect(byName.get("helper")?.symbolKind).toBe("function");
    expect(byName.get("main")?.symbolKind).toBe("function");
    expect(byName.get("Point")?.symbolKind).toBe("type");
    expect(byName.get("Color")?.symbolKind).toBe("enum");
    for (const c of chunks) expect(c.language).toBe("c");
  });

  it("extracts quoted includes as imports (system headers dropped) and non-static exports", async () => {
    const { graph } = await chunkAndEdges(file(src, "src/main.c"));
    const imports = graph.edges.filter(e => e.kind === "imports");
    expect(imports.map(e => e.targetPath)).toEqual(["src/util.h"]);
    expect(graph.exports).toContain("main");
    expect(graph.exports).not.toContain("helper"); // static → internal linkage
  });
});

describe("C++", () => {
  const src = [
    '#include "base.hpp"',
    "namespace app {",
    "class Engine : public Base {",
    "public:",
    "  int run(int x) { return x; }",
    "  void stop() {}",
    "};",
    "using Alias = int;",
    "}",
  ].join("\n");

  it("chunks class methods individually with the class as parent", async () => {
    const { chunks } = await chunkAndEdges(file(src, "src/engine.cpp"));
    const methods = chunks.filter(c => c.symbolKind === "function" && c.parentSymbol === "Engine");
    expect(methods.map(m => m.symbolName).sort()).toEqual(["run", "stop"]);
    expect(chunks.some(c => c.symbolName === "Alias" && c.symbolKind === "type")).toBe(true);
  });

  it("extracts includes and class heritage", async () => {
    const { graph } = await chunkAndEdges(file(src, "src/engine.cpp"));
    expect(graph.edges.some(e => e.kind === "imports" && e.targetPath === "src/base.hpp")).toBe(true);
    expect(graph.edges.some(e => e.kind === "extends" && e.sourceSymbol === "Engine" && e.targetSymbol === "Base")).toBe(true);
    expect(graph.exports).toContain("Engine");
  });
});

describe("Ruby", () => {
  const src = [
    'require "json"',
    'require_relative "./helper"',
    "module Billing",
    "  class Invoice < Document",
    "    def total",
    "      42",
    "    end",
    "    def self.build(x)",
    "      new",
    "    end",
    "  end",
    "end",
    "def top_util(y)",
    "  y",
    "end",
  ].join("\n");

  it("chunks methods with their class as parent", async () => {
    const { chunks } = await chunkAndEdges(file(src, "lib/invoice.rb"));
    const byName = new Map(chunks.map(c => [c.symbolName, c]));
    expect(byName.get("total")?.symbolKind).toBe("method");
    expect(byName.get("total")?.parentSymbol).toBe("Invoice");
    expect(byName.get("build")?.parentSymbol).toBe("Invoice");
    expect(byName.get("top_util")?.symbolKind).toBe("method");
  });

  it("extracts require_relative as an import, class/module/top-level defs as exports, superclass as extends", async () => {
    const { graph } = await chunkAndEdges(file(src, "lib/invoice.rb"));
    expect(graph.edges.some(e => e.kind === "imports" && e.targetPath === "lib/helper")).toBe(true);
    // bare `require "json"` targets a gem — must NOT create a project edge
    expect(graph.edges.filter(e => e.kind === "imports")).toHaveLength(1);
    expect(graph.exports).toEqual(expect.arrayContaining(["Billing", "Invoice", "top_util"]));
    expect(graph.edges.some(e => e.kind === "extends" && e.sourceSymbol === "Invoice" && e.targetSymbol === "Document")).toBe(true);
  });
});

describe("PHP", () => {
  const src = [
    "<?php",
    "namespace App;",
    "use App\\Base\\Controller;",
    'require_once "legacy.php";',
    "interface Shape { public function area(): float; }",
    "class Circle extends Base implements Shape {",
    "  public function area(): float { return 3.14; }",
    "}",
    "function helper($x) { return new Controller($x); }",
  ].join("\n");

  it("chunks functions, methods, and interfaces", async () => {
    const { chunks } = await chunkAndEdges(file(src, "app/circle.php"));
    const byName = new Map(chunks.map(c => [c.symbolName, c]));
    expect(byName.get("area")?.symbolKind).toBe("method");
    expect(byName.get("area")?.parentSymbol).toBe("Circle");
    expect(byName.get("helper")?.symbolKind).toBe("function");
    expect(byName.get("Shape")?.symbolKind).toBe("interface");
  });

  it("extracts use/require imports, type exports, heritage, and calls through the alias table", async () => {
    const { graph } = await chunkAndEdges(file(src, "app/circle.php"));
    expect(graph.edges.some(e => e.kind === "imports" && e.targetPath === "App/Base/Controller")).toBe(true);
    expect(graph.edges.some(e => e.kind === "imports" && e.targetPath === "app/legacy.php")).toBe(true);
    expect(graph.exports).toEqual(expect.arrayContaining(["Shape", "Circle", "helper"]));
    expect(graph.edges.some(e => e.kind === "extends" && e.sourceSymbol === "Circle" && e.targetSymbol === "Base")).toBe(true);
    expect(graph.edges.some(e => e.kind === "implements" && e.sourceSymbol === "Circle" && e.targetSymbol === "Shape")).toBe(true);
    expect(graph.edges.some(e => e.kind === "calls" && e.targetPath === "App/Base/Controller")).toBe(true);
  });
});

describe("Kotlin", () => {
  const src = [
    "package app",
    "import com.example.util.Helper",
    "class Engine(val name: String) : Base(), Runnable {",
    "  fun run(x: Int): Int { return Helper.wrap(x) }",
    "}",
    "object Registry {",
    "  fun lookup(k: String) {}",
    "}",
    "fun topLevel(y: Int) = y",
  ].join("\n");

  it("chunks functions with class/object parents despite fieldless grammar", async () => {
    const { chunks } = await chunkAndEdges(file(src, "app/Engine.kt"));
    const byName = new Map(chunks.map(c => [c.symbolName, c]));
    expect(byName.get("run")?.parentSymbol).toBe("Engine");
    expect(byName.get("lookup")?.parentSymbol).toBe("Registry");
    expect(byName.get("topLevel")?.symbolKind).toBe("function");
  });

  it("extracts imports, top-level exports, heritage, and calls via imported names", async () => {
    const { graph } = await chunkAndEdges(file(src, "app/Engine.kt"));
    expect(graph.edges.some(e => e.kind === "imports" && e.targetPath === "com/example/util/Helper")).toBe(true);
    expect(graph.exports).toEqual(expect.arrayContaining(["Engine", "Registry", "topLevel"]));
    expect(graph.edges.some(e => e.kind === "extends" && e.sourceSymbol === "Engine" && e.targetSymbol === "Base")).toBe(true);
    expect(graph.edges.some(e => e.kind === "implements" && e.sourceSymbol === "Engine" && e.targetSymbol === "Runnable")).toBe(true);
    expect(graph.edges.some(e => e.kind === "calls" && e.targetPath === "com/example/util/Helper")).toBe(true);
  });
});

describe("Swift", () => {
  const src = [
    "import Foundation",
    "protocol Shape { func area() -> Double }",
    "struct Circle: Shape {",
    "  var r: Double",
    "  func area() -> Double { return 3.14 * r * r }",
    "}",
    "class Engine: Base {",
    "  func run(_ x: Int) -> Int { return x }",
    "}",
    "func topLevel(y: Int) -> Int { return y }",
  ].join("\n");

  it("chunks functions inside structs/classes and protocols as interfaces", async () => {
    const { chunks } = await chunkAndEdges(file(src, "Sources/Engine.swift"));
    const byName = new Map(chunks.map(c => [c.symbolName, c]));
    expect(byName.get("area")?.parentSymbol).toBe("Circle");
    expect(byName.get("run")?.parentSymbol).toBe("Engine");
    expect(byName.get("Shape")?.symbolKind).toBe("interface");
    expect(byName.get("topLevel")?.symbolKind).toBe("function");
  });

  it("extracts imports, exports, and inheritance", async () => {
    const { graph } = await chunkAndEdges(file(src, "Sources/Engine.swift"));
    expect(graph.edges.some(e => e.kind === "imports" && e.targetPath === "Foundation")).toBe(true);
    expect(graph.exports).toEqual(expect.arrayContaining(["Shape", "Circle", "Engine", "topLevel"]));
    expect(graph.edges.some(e => e.kind === "extends" && e.sourceSymbol === "Engine" && e.targetSymbol === "Base")).toBe(true);
  });
});
