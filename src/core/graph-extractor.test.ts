import { describe, it, expect } from "vitest";
import { extractEdgesFromSource } from "./graph-extractor";

describe("extractEdgesFromSource", () => {
  describe("TypeScript", () => {
    it("extracts named imports", () => {
      const code = `import { foo, bar } from "./utils";`;
      const { edges } = extractEdgesFromSource("src/main.ts", code, "typescript");
      const imports = edges.filter(e => e.kind === "imports");
      expect(imports.length).toBe(2);
      expect(imports[0].sourceSymbol).toBe("foo");
      expect(imports[0].targetPath).toBe("src/utils");
      expect(imports[1].sourceSymbol).toBe("bar");
    });

    it("extracts default imports", () => {
      const code = `import React from "./react-shim";`;
      const { edges } = extractEdgesFromSource("src/app.tsx", code, "tsx");
      const imports = edges.filter(e => e.kind === "imports");
      expect(imports.some(e => e.sourceSymbol === "React" && e.targetSymbol === "default")).toBe(true);
    });

    it("extracts exports", () => {
      const code = `export function hello() {}\nexport const world = 1;\nexport class Foo {}`;
      const { edges, exports } = extractEdgesFromSource("src/lib.ts", code, "typescript");
      expect(exports).toContain("hello");
      expect(exports).toContain("world");
      expect(exports).toContain("Foo");
      expect(edges.filter(e => e.kind === "exports").length).toBe(3);
    });

    it("extracts class extends", () => {
      const code = `class Dog extends Animal {}`;
      const { edges } = extractEdgesFromSource("src/dog.ts", code, "typescript");
      const ext = edges.filter(e => e.kind === "extends");
      expect(ext.length).toBe(1);
      expect(ext[0].sourceSymbol).toBe("Dog");
      expect(ext[0].targetSymbol).toBe("Animal");
    });

    it("extracts class implements", () => {
      const code = `class UserService implements IService, Disposable {}`;
      const { edges } = extractEdgesFromSource("src/user.ts", code, "typescript");
      const impl = edges.filter(e => e.kind === "implements");
      expect(impl.length).toBe(2);
      expect(impl[0].targetSymbol).toBe("IService");
      expect(impl[1].targetSymbol).toBe("Disposable");
    });

    it("extracts function calls to imported symbols", () => {
      const code = `import { createUser } from "./users";\n\nconst u = createUser("name");`;
      const { edges } = extractEdgesFromSource("src/main.ts", code, "typescript");
      const calls = edges.filter(e => e.kind === "calls");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].targetSymbol).toBe("createUser");
    });

    it("ignores non-relative imports", () => {
      const code = `import express from "express";\nimport { readFile } from "fs";`;
      const { edges } = extractEdgesFromSource("src/app.ts", code, "typescript");
      expect(edges.filter(e => e.kind === "imports")).toHaveLength(0);
    });

    it("handles re-exports", () => {
      const code = `export { foo, bar } from "./utils";`;
      const { exports } = extractEdgesFromSource("src/index.ts", code, "typescript");
      expect(exports).toContain("foo");
      expect(exports).toContain("bar");
    });
  });

  describe("Python", () => {
    it("extracts from-imports", () => {
      const code = `from .utils import helper, process_data`;
      const { edges } = extractEdgesFromSource("src/main.py", code, "python");
      const imports = edges.filter(e => e.kind === "imports");
      expect(imports.length).toBe(2);
      expect(imports[0].sourceSymbol).toBe("helper");
      expect(imports[1].sourceSymbol).toBe("process_data");
    });

    it("extracts class inheritance", () => {
      const code = `class Dog(Animal, Serializable):\n    pass`;
      const { edges } = extractEdgesFromSource("src/models.py", code, "python");
      const ext = edges.filter(e => e.kind === "extends");
      expect(ext.length).toBe(2);
      expect(ext[0].targetSymbol).toBe("Animal");
      expect(ext[1].targetSymbol).toBe("Serializable");
    });

    it("extracts module-level function exports", () => {
      const code = `def process_data():\n    pass\n\ndef validate():\n    pass`;
      const { exports } = extractEdgesFromSource("src/utils.py", code, "python");
      expect(exports).toContain("process_data");
      expect(exports).toContain("validate");
    });
  });

  describe("Go", () => {
    it("extracts imports from block", () => {
      const code = `import (\n\t"fmt"\n\t"net/http"\n)`;
      const { edges } = extractEdgesFromSource("main.go", code, "go");
      expect(edges.filter(e => e.kind === "imports").length).toBe(2);
    });

    it("extracts exported functions", () => {
      const code = `func HandleRequest(w http.ResponseWriter, r *http.Request) {}`;
      const { exports } = extractEdgesFromSource("handler.go", code, "go");
      expect(exports).toContain("HandleRequest");
    });
  });

  describe("Rust", () => {
    it("extracts use statements", () => {
      const code = `use crate::utils::helper;\nuse super::config;`;
      const { edges } = extractEdgesFromSource("src/main.rs", code, "rust");
      const imports = edges.filter(e => e.kind === "imports");
      expect(imports.length).toBe(2);
    });

    it("extracts impl Trait for Struct", () => {
      const code = `impl Display for User {}`;
      const { edges } = extractEdgesFromSource("src/user.rs", code, "rust");
      const impl = edges.filter(e => e.kind === "implements");
      expect(impl.length).toBe(1);
      expect(impl[0].sourceSymbol).toBe("User");
      expect(impl[0].targetSymbol).toBe("Display");
    });

    it("extracts pub items as exports", () => {
      const code = `pub fn process() {}\npub struct Config {}`;
      const { exports } = extractEdgesFromSource("src/lib.rs", code, "rust");
      expect(exports).toContain("process");
      expect(exports).toContain("Config");
    });
  });

  describe("Java", () => {
    it("extracts imports", () => {
      const code = `import com.example.service.UserService;`;
      const { edges } = extractEdgesFromSource("App.java", code, "java");
      const imports = edges.filter(e => e.kind === "imports");
      expect(imports.length).toBe(1);
      expect(imports[0].sourceSymbol).toBe("UserService");
    });

    it("extracts class hierarchy", () => {
      const code = `class Dog extends Animal implements Serializable, Comparable {}`;
      const { edges } = extractEdgesFromSource("Dog.java", code, "java");
      expect(edges.filter(e => e.kind === "extends").length).toBe(1);
      expect(edges.filter(e => e.kind === "implements").length).toBe(2);
    });
  });

  describe("unsupported language", () => {
    it("returns empty for unknown languages", () => {
      const { edges, exports } = extractEdgesFromSource("file.txt", "hello", "unknown");
      expect(edges).toHaveLength(0);
      expect(exports).toHaveLength(0);
    });
  });
});
