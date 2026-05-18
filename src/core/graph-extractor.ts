import * as path from "path";
import { GraphEdge, EdgeKind } from "./code-graph";

export interface ExtractionResult {
  edges: GraphEdge[];
  exports: string[];
}

export function extractEdgesFromSource(filePath: string, contents: string, language: string): ExtractionResult {
  switch (language) {
    case "typescript":
    case "tsx":
    case "javascript":
      return extractTypeScriptEdges(filePath, contents);
    case "python":
      return extractPythonEdges(filePath, contents);
    case "go":
      return extractGoEdges(filePath, contents);
    case "rust":
      return extractRustEdges(filePath, contents);
    case "java":
      return extractJavaEdges(filePath, contents);
    case "c_sharp":
      return extractCSharpEdges(filePath, contents);
    default:
      return { edges: [], exports: [] };
  }
}

function extractTypeScriptEdges(filePath: string, contents: string): ExtractionResult {
  const edges: GraphEdge[] = [];
  const exports: string[] = [];

  // Import extraction
  const importPatterns = [
    /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+)(?:\s*,\s*\{([^}]+)\})?)\s+from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of importPatterns) {
    for (const match of contents.matchAll(pattern)) {
      if (pattern === importPatterns[0]) {
        const namedImports = match[1] || match[3] || "";
        const defaultImport = match[2] || "";
        const specifier = match[4];
        const targetPath = resolveSpecifier(filePath, specifier);
        if (!targetPath) continue;

        if (defaultImport) {
          edges.push({ sourcePath: filePath, sourceSymbol: defaultImport, targetPath, targetSymbol: "default", kind: "imports", confidence: 1.0 });
        }
        for (const named of parseNamedImports(namedImports)) {
          edges.push({ sourcePath: filePath, sourceSymbol: named.local, targetPath, targetSymbol: named.imported, kind: "imports", confidence: 1.0 });
        }
      } else {
        const specifier = match[1];
        const targetPath = resolveSpecifier(filePath, specifier);
        if (targetPath) {
          edges.push({ sourcePath: filePath, targetPath, kind: "imports", confidence: 0.9 });
        }
      }
    }
  }

  // Export extraction
  const exportPatterns = [
    /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g,
    /export\s+\{([^}]+)\}/g,
  ];

  for (const pattern of exportPatterns) {
    for (const match of contents.matchAll(pattern)) {
      if (match[1] && !match[1].includes(",")) {
        exports.push(match[1]);
        edges.push({ sourcePath: filePath, sourceSymbol: match[1], targetPath: filePath, targetSymbol: match[1], kind: "exports", confidence: 1.0 });
      } else if (match[1]) {
        for (const name of match[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim())) {
          if (name) {
            exports.push(name);
            edges.push({ sourcePath: filePath, sourceSymbol: name, targetPath: filePath, targetSymbol: name, kind: "exports", confidence: 1.0 });
          }
        }
      }
    }
  }

  // Extends/implements extraction
  const classPatterns = [
    /class\s+(\w+)\s+extends\s+(\w+)/g,
    /class\s+(\w+)\s+implements\s+([^{]+)/g,
    /interface\s+(\w+)\s+extends\s+([^{]+)/g,
  ];

  for (const [idx, pattern] of classPatterns.entries()) {
    for (const match of contents.matchAll(pattern)) {
      const source = match[1];
      const targets = match[2].split(",").map(s => s.trim().split("<")[0].trim());
      const kind: EdgeKind = idx === 1 ? "implements" : "extends";
      for (const target of targets) {
        if (target && /^[A-Z]/.test(target)) {
          edges.push({ sourcePath: filePath, sourceSymbol: source, targetPath: filePath, targetSymbol: target, kind, confidence: 0.8 });
        }
      }
    }
  }

  // Function/method calls (high-confidence: known imports being called)
  const importedSymbols = new Set(edges.filter(e => e.kind === "imports" && e.sourceSymbol).map(e => e.sourceSymbol!));
  const callPattern = /\b([A-Za-z_]\w*)\s*\(/g;
  for (const match of contents.matchAll(callPattern)) {
    const callee = match[1];
    if (importedSymbols.has(callee)) {
      const importEdge = edges.find(e => e.kind === "imports" && e.sourceSymbol === callee);
      if (importEdge) {
        edges.push({ sourcePath: filePath, sourceSymbol: undefined, targetPath: importEdge.targetPath, targetSymbol: importEdge.targetSymbol, kind: "calls", confidence: 0.7 });
      }
    }
  }

  return { edges, exports };
}

function extractPythonEdges(filePath: string, contents: string): ExtractionResult {
  const edges: GraphEdge[] = [];
  const exports: string[] = [];

  // from X import Y
  const fromImport = /from\s+(\.+\w*(?:\.\w+)*)\s+import\s+([^#\n]+)/g;
  for (const match of contents.matchAll(fromImport)) {
    const module = match[1];
    const names = match[2].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim());
    const targetPath = resolvePythonModule(filePath, module);
    if (!targetPath) continue;
    for (const name of names) {
      if (name && name !== "*") {
        edges.push({ sourcePath: filePath, sourceSymbol: name, targetPath, targetSymbol: name, kind: "imports", confidence: 1.0 });
      }
    }
  }

  // import X
  const directImport = /^import\s+(\w+(?:\.\w+)*)/gm;
  for (const match of contents.matchAll(directImport)) {
    const module = match[1];
    const targetPath = resolvePythonModule(filePath, module);
    if (targetPath) {
      edges.push({ sourcePath: filePath, targetPath, kind: "imports", confidence: 0.9 });
    }
  }

  // class X(BaseClass)
  const classPattern = /class\s+(\w+)\s*\(([^)]+)\)/g;
  for (const match of contents.matchAll(classPattern)) {
    const className = match[1];
    exports.push(className);
    const bases = match[2].split(",").map(s => s.trim().split("[")[0].trim());
    for (const base of bases) {
      if (base && base !== "object" && /^[A-Z]/.test(base)) {
        edges.push({ sourcePath: filePath, sourceSymbol: className, targetPath: filePath, targetSymbol: base, kind: "extends", confidence: 0.8 });
      }
    }
  }

  // def at module level = export
  const defPattern = /^def\s+(\w+)/gm;
  for (const match of contents.matchAll(defPattern)) {
    exports.push(match[1]);
  }

  return { edges, exports };
}

function extractGoEdges(filePath: string, contents: string): ExtractionResult {
  const edges: GraphEdge[] = [];
  const exports: string[] = [];

  // import "path" or import alias "path"
  const importBlock = /import\s*\(([^)]+)\)/gs;
  const singleImport = /import\s+(?:(\w+)\s+)?"([^"]+)"/g;

  for (const block of contents.matchAll(importBlock)) {
    const lines = block[1].split("\n");
    for (const line of lines) {
      const m = line.match(/(?:(\w+)\s+)?"([^"]+)"/);
      if (m) {
        const targetPath = m[2];
        edges.push({ sourcePath: filePath, targetPath, kind: "imports", confidence: 1.0 });
      }
    }
  }
  for (const match of contents.matchAll(singleImport)) {
    edges.push({ sourcePath: filePath, targetPath: match[2], kind: "imports", confidence: 1.0 });
  }

  // Exported functions/types (capitalized)
  const funcPattern = /^func\s+(?:\([^)]+\)\s+)?([A-Z]\w*)/gm;
  for (const match of contents.matchAll(funcPattern)) {
    exports.push(match[1]);
  }

  const typePattern = /^type\s+([A-Z]\w*)\s+(?:struct|interface)/gm;
  for (const match of contents.matchAll(typePattern)) {
    exports.push(match[1]);
  }

  return { edges, exports };
}

function extractRustEdges(filePath: string, contents: string): ExtractionResult {
  const edges: GraphEdge[] = [];
  const exports: string[] = [];

  // use crate::X or use super::X
  const usePattern = /use\s+((?:crate|super|self)(?:::\w+)+)(?:::\{([^}]+)\})?/g;
  for (const match of contents.matchAll(usePattern)) {
    const basePath = match[1];
    const names = match[2] ? match[2].split(",").map(s => s.trim()) : [basePath.split("::").pop()!];
    const targetPath = basePath.replace(/::/g, "/");
    for (const name of names) {
      if (name && name !== "self") {
        edges.push({ sourcePath: filePath, sourceSymbol: name, targetPath, targetSymbol: name, kind: "imports", confidence: 0.9 });
      }
    }
  }

  // pub fn/struct/enum/trait = exports
  const pubPattern = /pub\s+(?:fn|struct|enum|trait|type)\s+(\w+)/g;
  for (const match of contents.matchAll(pubPattern)) {
    exports.push(match[1]);
  }

  // impl Trait for Struct
  const implPattern = /impl\s+(\w+)\s+for\s+(\w+)/g;
  for (const match of contents.matchAll(implPattern)) {
    edges.push({ sourcePath: filePath, sourceSymbol: match[2], targetPath: filePath, targetSymbol: match[1], kind: "implements", confidence: 0.9 });
  }

  return { edges, exports };
}

function extractJavaEdges(filePath: string, contents: string): ExtractionResult {
  const edges: GraphEdge[] = [];
  const exports: string[] = [];

  // import com.foo.Bar
  const importPattern = /import\s+(?:static\s+)?([\w.]+)/g;
  for (const match of contents.matchAll(importPattern)) {
    const fqn = match[1];
    const parts = fqn.split(".");
    const symbol = parts[parts.length - 1];
    edges.push({ sourcePath: filePath, sourceSymbol: symbol, targetPath: fqn.replace(/\./g, "/"), targetSymbol: symbol, kind: "imports", confidence: 0.9 });
  }

  // class X extends Y implements Z
  const classPattern = /class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/g;
  for (const match of contents.matchAll(classPattern)) {
    const className = match[1];
    exports.push(className);
    if (match[2]) {
      edges.push({ sourcePath: filePath, sourceSymbol: className, targetPath: filePath, targetSymbol: match[2], kind: "extends", confidence: 0.9 });
    }
    if (match[3]) {
      for (const iface of match[3].split(",").map(s => s.trim().split("<")[0].trim())) {
        if (iface) edges.push({ sourcePath: filePath, sourceSymbol: className, targetPath: filePath, targetSymbol: iface, kind: "implements", confidence: 0.9 });
      }
    }
  }

  return { edges, exports };
}

function extractCSharpEdges(filePath: string, contents: string): ExtractionResult {
  const edges: GraphEdge[] = [];
  const exports: string[] = [];

  // using Namespace
  const usingPattern = /using\s+(?:static\s+)?([\w.]+)\s*;/g;
  for (const match of contents.matchAll(usingPattern)) {
    edges.push({ sourcePath: filePath, targetPath: match[1].replace(/\./g, "/"), kind: "imports", confidence: 0.8 });
  }

  // class X : Base, IInterface
  const classPattern = /(?:class|struct|record)\s+(\w+)(?:\s*<[^>]*>)?\s*:\s*([^{]+)/g;
  for (const match of contents.matchAll(classPattern)) {
    const className = match[1];
    exports.push(className);
    const bases = match[2].split(",").map(s => s.trim().split("<")[0].trim());
    for (const base of bases) {
      if (!base) continue;
      const kind: EdgeKind = base.startsWith("I") && /^I[A-Z]/.test(base) ? "implements" : "extends";
      edges.push({ sourcePath: filePath, sourceSymbol: className, targetPath: filePath, targetSymbol: base, kind, confidence: 0.8 });
    }
  }

  return { edges, exports };
}

function resolveSpecifier(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.posix.dirname(fromPath);
  return path.posix.normalize(path.posix.join(dir, specifier));
}

function resolvePythonModule(fromPath: string, module: string): string | null {
  if (module.startsWith(".")) {
    const dots = module.match(/^\.+/)![0].length;
    const dir = path.posix.dirname(fromPath);
    const parts = dir.split("/");
    const base = parts.slice(0, parts.length - (dots - 1)).join("/");
    const rest = module.slice(dots).replace(/\./g, "/");
    return rest ? path.posix.join(base, rest) : base;
  }
  return module.replace(/\./g, "/");
}

function parseNamedImports(str: string): { imported: string; local: string }[] {
  if (!str.trim()) return [];
  return str.split(",").map(s => {
    const parts = s.trim().split(/\s+as\s+/);
    const imported = parts[0].replace(/^type\s+/, "").trim();
    const local = (parts[1] ?? imported).trim();
    return { imported, local };
  }).filter(x => x.imported);
}
