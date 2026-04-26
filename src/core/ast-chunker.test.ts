import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AstChunker } from "./ast-chunker";
import { CodeChunker } from "./chunker";
import { File } from "./types";

function file(contents: string, p: string): File { return { path: p, contents }; }

let chunker: AstChunker;

beforeAll(() => {
  chunker = new AstChunker({ maxChunkChars: 20000, fallback: new CodeChunker(80, 15, 20000) });
});

afterAll(() => { chunker.dispose(); });

describe("AstChunker.languageFor", () => {
  it("maps well-known extensions", () => {
    expect(AstChunker.languageFor("a.ts")).toBe("typescript");
    expect(AstChunker.languageFor("a.tsx")).toBe("tsx");
    expect(AstChunker.languageFor("a.js")).toBe("javascript");
    expect(AstChunker.languageFor("a.py")).toBe("python");
    expect(AstChunker.languageFor("a.go")).toBe("go");
    expect(AstChunker.languageFor("a.rs")).toBe("rust");
    expect(AstChunker.languageFor("a.java")).toBe("java");
    expect(AstChunker.languageFor("a.cs")).toBe("c_sharp");
  });

  it("returns null for unsupported extensions", () => {
    expect(AstChunker.languageFor("a.md")).toBeNull();
    expect(AstChunker.languageFor("Dockerfile")).toBeNull();
  });
});

describe("AstChunker (TypeScript)", () => {
  it("emits one chunk per top-level function", async () => {
    const src = [
      "export function alpha() { return 1; }",
      "export function beta() { return 2; }",
      "export function gamma() { return 3; }",
    ].join("\n\n");
    const chunks = await chunker.chunkFile(file(src, "src/x.ts"));
    const names = chunks.map(c => c.symbolName).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
    for (const c of chunks) {
      expect(c.symbolKind).toBe("function");
      expect(c.language).toBe("typescript");
    }
  });

  it("emits methods from inside a class with parentSymbol", async () => {
    const src = [
      "export class Widget {",
      "  render() { return 1; }",
      "  dispose() { return 2; }",
      "}",
    ].join("\n");
    const chunks = await chunker.chunkFile(file(src, "src/widget.ts"));
    const methods = chunks.filter(c => c.symbolKind === "method");
    expect(methods.map(m => m.symbolName).sort()).toEqual(["dispose", "render"]);
    for (const m of methods) expect(m.parentSymbol).toBe("Widget");
  });

  it("captures interface and type_alias declarations", async () => {
    const src = [
      "export interface Foo { a: number; }",
      "export type Bar = string | number;",
    ].join("\n");
    const chunks = await chunker.chunkFile(file(src, "src/t.ts"));
    const kinds = chunks.map(c => c.symbolKind).sort();
    expect(kinds).toContain("interface");
    expect(kinds).toContain("type");
  });
});

describe("AstChunker (Python)", () => {
  it("chunks top-level def and class methods", async () => {
    const src = [
      "def top_level(x):",
      "    return x + 1",
      "",
      "class Service:",
      "    def start(self): return 1",
      "    def stop(self): return 2",
    ].join("\n");
    const chunks = await chunker.chunkFile(file(src, "svc.py"));
    const byKind = chunks.reduce<Record<string, string[]>>((acc, c) => {
      const k = c.symbolKind || "?"; (acc[k] ||= []).push(c.symbolName || "");
      return acc;
    }, {});
    expect(byKind["function"]?.sort()).toEqual(["start", "stop", "top_level"]);
    const methods = chunks.filter(c => c.parentSymbol === "Service");
    expect(methods.map(m => m.symbolName).sort()).toEqual(["start", "stop"]);
  });
});

describe("AstChunker (Go/Rust/Java)", () => {
  it("parses Go functions", async () => {
    const src = "package main\n\nfunc Add(a, b int) int { return a + b }\n";
    const chunks = await chunker.chunkFile(file(src, "main.go"));
    expect(chunks.map(c => c.symbolName)).toContain("Add");
    expect(chunks[0].language).toBe("go");
  });

  it("parses Rust fn and struct", async () => {
    const src = "pub struct User { name: String }\n\npub fn greet(u: &User) -> String { u.name.clone() }\n";
    const chunks = await chunker.chunkFile(file(src, "lib.rs"));
    const names = chunks.map(c => c.symbolName).sort();
    expect(names).toContain("User");
    expect(names).toContain("greet");
  });

  it("parses Java methods inside a class", async () => {
    const src = [
      "public class Calc {",
      "  public int add(int a, int b) { return a + b; }",
      "  public int sub(int a, int b) { return a - b; }",
      "}",
    ].join("\n");
    const chunks = await chunker.chunkFile(file(src, "Calc.java"));
    const methods = chunks.filter(c => c.symbolKind === "method").map(c => c.symbolName).sort();
    expect(methods).toEqual(["add", "sub"]);
  });
});

describe("AstChunker fallback", () => {
  it("falls back for unknown extensions", async () => {
    const src = Array.from({ length: 50 }, (_, i) => `# line ${i}`).join("\n");
    const chunks = await chunker.chunkFile(file(src, "notes.md"));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.symbolName).toBeUndefined();
  });

  it("falls back for files with no recognizable top-level symbols", async () => {
    const src = "console.log('hi');\nconst x = 1;\n";
    const chunks = await chunker.chunkFile(file(src, "top.ts"));
    expect(chunks.length).toBeGreaterThan(0);
  });
});
