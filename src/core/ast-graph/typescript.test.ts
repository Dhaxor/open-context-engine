import { describe, it, expect } from "vitest";
import type { File } from "../types";
import { edgesOfKind, extract } from "./test-utils";

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

