/**
 * AST-based code-graph extractor.
 *
 * Replaces the regex extractor in graph-extractor.ts for the same six
 * languages (TS/JS, Python, Go, Rust, Java, C#). The shape of edges emitted
 * is byte-compatible with the regex extractor's output — same `GraphEdge`
 * fields, same `EdgeKind` union, same path-resolution semantics — so the
 * graph-expander consumer needs no changes.
 *
 * Design — distilled from the workflow's adversarial review of the
 * original synthesis:
 *
 * - **One combined DFS per file.** Imports / exports / heritage / calls are
 *   all dispatched from a single `walk(node)` recursion. No per-edge-kind
 *   second pass.
 *
 * - **Type-only imports are tagged**. They emit `imports` edges (so barrel
 *   files still appear in the graph) but they are excluded from the call-
 *   resolution alias table — otherwise a call to a value named the same as
 *   a type-only import would produce a phantom `calls` edge.
 *
 * - **Re-exports emit BOTH `imports` and `exports` edges.** `export { a }
 *   from './m'` is structurally an import in disguise; if we only emitted
 *   an `exports` edge the graph would treat the barrel file as a sink and
 *   the expander would never traverse through it.
 *
 * - **Dynamic `import('./x')` and `require('./y')` are imports, not calls.**
 *   They appear under `call_expression` so a naive "walk imports only at
 *   the top of a statement" rule would miss them entirely.
 *
 * - **Calls edges keep `sourceSymbol: undefined`** to match the regex
 *   extractor's existing output shape — `graph-expander` already keys off
 *   that and changing it would silently shift what `getOutgoing` returns.
 *
 * - **Calls visitor short-circuits when the import table is empty.** Most
 *   source files have no imports (test fixtures, generated code, stubs);
 *   without the early-exit we'd descend into every function body for nothing.
 *
 * - **Tree lifetime is the caller's**. We borrow a `Tree` parsed by the
 *   chunker (or by `parseFile` directly) and never call `tree.delete()`.
 *   The caller in `context.ts` disposes per-file in a `finally`.
 */
import * as path from "path";
import type { Node as TsNode, Tree as TsTree } from "web-tree-sitter";
import { File } from "./types";
import { GraphEdge } from "./code-graph";

export interface ExtractionResult {
  edges: GraphEdge[];
  exports: string[];
}

interface ImportTarget {
  /** Resolved or unresolved target path. We don't drop bare imports — they're
   *  useful for "what does this file pull in" — but we mark them. */
  targetPath: string;
  targetSymbol?: string;
  isTypeOnly: boolean;
}

interface Ctx {
  filePath: string;
  edges: GraphEdge[];
  exports: string[];
  /** local name in this file → what it actually refers to. Populated by the
   *  imports visitor; consumed by the calls visitor. Type-only imports are NOT
   *  added (so they can't generate phantom calls edges). */
  importAliases: Map<string, ImportTarget>;
  /** Fast-path flag the calls visitor consults to early-exit on import-free files. */
  anyImports: boolean;
}

interface LanguageGraphSpec {
  /** Optional pre-walk that records whether the file has any import-like
   *  statement at the TOP level. Used purely to set ctx.anyImports without
   *  paying for a second DFS. */
  prescan?(root: TsNode, ctx: Ctx): void;
  /** Per-node dispatch. Called for every named node in DFS order. */
  visit(node: TsNode, ctx: Ctx): void;
}

const SPECS: Record<string, LanguageGraphSpec> = {
  typescript: tsSpec(),
  tsx: tsSpec(),
  javascript: tsSpec(),
  python: pySpec(),
  go: goSpec(),
  rust: rustSpec(),
  java: javaSpec(),
  c_sharp: csharpSpec(),
  c: cLikeSpec(),
  cpp: cLikeSpec(),
  ruby: rubySpec(),
  php: phpSpec(),
  kotlin: kotlinSpec(),
  swift: swiftSpec(),
};

/** Synchronous: callers already have a parsed tree. */
export function extractEdgesFromTree(file: File, language: string, tree: TsTree): ExtractionResult {
  const spec = SPECS[language];
  if (!spec) return { edges: [], exports: [] };
  const ctx: Ctx = {
    filePath: file.path,
    edges: [],
    exports: [],
    importAliases: new Map(),
    anyImports: false,
  };
  if (spec.prescan) spec.prescan(tree.rootNode, ctx);
  walk(tree.rootNode, spec, ctx);
  return { edges: ctx.edges, exports: ctx.exports };
}

function walk(node: TsNode, spec: LanguageGraphSpec, ctx: Ctx): void {
  spec.visit(node, ctx);
  const children = node.namedChildren;
  for (const child of children) {
    if (child) walk(child, spec, ctx);
  }
}

// ─── path resolution helpers ─────────────────────────────────────────────────

function resolveRelative(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.posix.dirname(fromPath);
  return path.posix.normalize(path.posix.join(dir, specifier));
}

function resolvePythonModule(fromPath: string, module: string): string {
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

function pushImport(
  ctx: Ctx,
  targetPath: string,
  opts: {
    sourceSymbol?: string;          // local name (what the file calls it)
    targetSymbol?: string;          // what the source module called it
    confidence?: number;
    isTypeOnly?: boolean;
  } = {},
): void {
  const sourceSymbol = opts.sourceSymbol;
  ctx.edges.push({
    sourcePath: ctx.filePath,
    sourceSymbol,
    targetPath,
    targetSymbol: opts.targetSymbol,
    kind: "imports",
    confidence: opts.confidence ?? 1.0,
  });
  ctx.anyImports = true;
  if (sourceSymbol && !opts.isTypeOnly) {
    // Last-wins on duplicate local names — that matches JS scoping in
    // practice and keeps the map free of nullish handling at lookup time.
    ctx.importAliases.set(sourceSymbol, {
      targetPath,
      targetSymbol: opts.targetSymbol,
      isTypeOnly: false,
    });
  }
}

function pushExport(ctx: Ctx, name: string): void {
  ctx.exports.push(name);
  ctx.edges.push({
    sourcePath: ctx.filePath,
    sourceSymbol: name,
    targetPath: ctx.filePath,
    targetSymbol: name,
    kind: "exports",
    confidence: 1.0,
  });
}

function pushHeritage(ctx: Ctx, kind: "extends" | "implements", source: string, target: string, confidence = 0.85): void {
  ctx.edges.push({ sourcePath: ctx.filePath, sourceSymbol: source, targetPath: ctx.filePath, targetSymbol: target, kind, confidence });
}

function pushCall(ctx: Ctx, target: ImportTarget, confidence = 0.75): void {
  // Calls edges intentionally use sourceSymbol: undefined to match the
  // regex extractor's existing output. graph-expander keys off this.
  ctx.edges.push({
    sourcePath: ctx.filePath,
    sourceSymbol: undefined,
    targetPath: target.targetPath,
    targetSymbol: target.targetSymbol,
    kind: "calls",
    confidence,
  });
}

function fieldText(node: TsNode, field: string): string | undefined {
  const f = node.childForFieldName(field);
  return f?.text;
}

/** Read the textual content of a `string` node, stripping the surrounding quotes. */
function stringNodeText(node: TsNode): string | null {
  if (node.type !== "string" && node.type !== "interpreted_string_literal" && node.type !== "raw_string_literal"
      && node.type !== "string_literal" && node.type !== "encapsed_string") return null;
  // tree-sitter exposes a `string_fragment` child for JS/TS strings; for
  // others the raw .text includes the quotes. Strip them in either case.
  const frag = node.namedChildren.find((c) => c && (c.type === "string_fragment" || c.type === "raw_str_part" || c.type === "interpreted_string_literal_content" || c.type === "string_content"));
  if (frag) return frag.text;
  const t = node.text;
  if (t.length >= 2 && (t.startsWith("\"") || t.startsWith("'") || t.startsWith("`"))) return t.slice(1, -1);
  return t;
}

/** Join a bare relative specifier (C includes, require_relative) against the
 *  importing file's directory — these are relative even without a leading dot. */
function joinRelative(fromPath: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
}

// ─── TypeScript / JavaScript ─────────────────────────────────────────────────

function tsSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "import_statement": return visitTsImport(node, ctx);
        case "export_statement": return visitTsExport(node, ctx);
        case "class_declaration":
        case "abstract_class_declaration":
          return visitTsClass(node, ctx);
        case "interface_declaration":
          return visitTsInterface(node, ctx);
        case "call_expression":
          // dynamic import / require live here.
          visitTsDynamicImportLike(node, ctx);
          if (ctx.anyImports) visitTsCall(node, ctx);
          return;
      }
    },
  };
}

function visitTsImport(node: TsNode, ctx: Ctx): void {
  const source = node.childForFieldName("source");
  const specifierRaw = source ? stringNodeText(source) : null;
  if (!specifierRaw) return;
  const targetPath = resolveRelative(ctx.filePath, specifierRaw);
  if (!targetPath) return; // bare imports (e.g. "react") are dropped by current semantics

  // Detect top-level "type" / "typeof" tokens BEFORE the import_clause —
  // these mark the WHOLE statement as type-only.
  let stmtTypeOnly = false;
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === "import_clause") break;
    if (child.text === "type" || child.text === "typeof") { stmtTypeOnly = true; break; }
  }

  // Side-effect import: `import './x'` — no import_clause.
  const clause = node.childForFieldName("source") ? findChild(node, "import_clause") : null;
  if (!clause) {
    pushImport(ctx, targetPath, { confidence: 0.9 });
    return;
  }

  for (const child of clause.namedChildren) {
    if (!child) continue;
    if (child.type === "identifier") {
      // default import
      pushImport(ctx, targetPath, { sourceSymbol: child.text, targetSymbol: "default", isTypeOnly: stmtTypeOnly });
    } else if (child.type === "named_imports") {
      for (const spec of child.namedChildren) {
        if (!spec || spec.type !== "import_specifier") continue;
        const perSpecTypeOnly = stmtTypeOnly || spec.children.some((c) => c && (c.text === "type" || c.text === "typeof"));
        const name = fieldText(spec, "name");
        const alias = fieldText(spec, "alias") ?? name;
        if (!alias) continue;
        pushImport(ctx, targetPath, { sourceSymbol: alias, targetSymbol: name, isTypeOnly: perSpecTypeOnly });
      }
    } else if (child.type === "namespace_import") {
      // * as ns
      const id = child.namedChildren.find((c) => c && c.type === "identifier");
      if (id) pushImport(ctx, targetPath, { sourceSymbol: id.text, isTypeOnly: stmtTypeOnly });
    } else if (child.type === "import_require_clause") {
      // import X = require('m')
      const name = child.namedChildren.find((c) => c && c.type === "identifier")?.text;
      if (name) pushImport(ctx, targetPath, { sourceSymbol: name });
    }
  }
}

function visitTsExport(node: TsNode, ctx: Ctx): void {
  // Re-export — `export { a } from './m'` / `export * from './m'` / `export * as ns from './m'`
  const source = node.childForFieldName("source");
  if (source) {
    const specifierRaw = stringNodeText(source);
    if (!specifierRaw) return;
    const targetPath = resolveRelative(ctx.filePath, specifierRaw);
    if (!targetPath) return;

    // The export clause itself
    const exportClause = findChild(node, "export_clause");
    const namespaceExport = findChild(node, "namespace_export");
    const starToken = node.children.find((c) => c && c.text === "*" && c.type === "*");

    if (exportClause) {
      // `export { a, b as c } from './m'` — emit BOTH imports (for graph
      // walking) AND exports (for "what does this file expose")
      for (const spec of exportClause.namedChildren) {
        if (!spec || spec.type !== "export_specifier") continue;
        const name = fieldText(spec, "name");
        const alias = fieldText(spec, "alias") ?? name;
        if (name) pushImport(ctx, targetPath, { sourceSymbol: alias, targetSymbol: name, confidence: 0.95 });
        if (alias) pushExport(ctx, alias);
      }
    } else if (namespaceExport) {
      // `export * as ns from './m'`
      const id = namespaceExport.namedChildren.find((c) => c && c.type === "identifier");
      if (id) {
        pushImport(ctx, targetPath, { sourceSymbol: id.text, confidence: 0.9 });
        pushExport(ctx, id.text);
      }
    } else if (starToken) {
      // `export * from './m'`
      pushImport(ctx, targetPath, { confidence: 0.9 });
    }
    return;
  }

  // Local exports — `export const X = ...`, `export function f(){}`, etc.
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "export_clause") {
      for (const spec of child.namedChildren) {
        if (!spec || spec.type !== "export_specifier") continue;
        const name = fieldText(spec, "alias") ?? fieldText(spec, "name");
        if (name) pushExport(ctx, name);
      }
      continue;
    }
    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      for (const decl of child.namedChildren) {
        if (decl && decl.type === "variable_declarator") {
          const name = fieldText(decl, "name");
          if (name) pushExport(ctx, name);
        }
      }
      continue;
    }
    const name = fieldText(child, "name");
    if (name) pushExport(ctx, name);
  }
}

function visitTsClass(node: TsNode, ctx: Ctx): void {
  const className = fieldText(node, "name");
  if (className) pushExport(ctx, className);
  const heritage = findChild(node, "class_heritage");
  if (!heritage || !className) return;
  for (const child of heritage.namedChildren) {
    if (!child) continue;
    if (child.type === "extends_clause") {
      for (const t of typeIdentifiersIn(child)) pushHeritage(ctx, "extends", className, t);
    } else if (child.type === "implements_clause") {
      for (const t of typeIdentifiersIn(child)) pushHeritage(ctx, "implements", className, t);
    }
  }
}

function visitTsInterface(node: TsNode, ctx: Ctx): void {
  const name = fieldText(node, "name");
  if (name) pushExport(ctx, name);
  if (!name) return;
  for (const child of node.namedChildren) {
    if (child && child.type === "extends_type_clause") {
      for (const t of typeIdentifiersIn(child)) pushHeritage(ctx, "extends", name, t);
    }
  }
}

function visitTsDynamicImportLike(node: TsNode, ctx: Ctx): void {
  const fn = node.childForFieldName("function");
  if (!fn) return;
  const isImport = fn.type === "import";
  const isRequire = fn.type === "identifier" && fn.text === "require";
  if (!isImport && !isRequire) return;
  const args = node.childForFieldName("arguments");
  const first = args?.namedChildren.find((c) => c && c.type === "string");
  if (!first) return;
  const specifierRaw = stringNodeText(first);
  if (!specifierRaw) return;
  const targetPath = resolveRelative(ctx.filePath, specifierRaw);
  if (!targetPath) return;
  pushImport(ctx, targetPath, { confidence: 0.7 });
}

function visitTsCall(node: TsNode, ctx: Ctx): void {
  const fn = node.childForFieldName("function");
  if (!fn) return;
  let calleeName: string | undefined;
  if (fn.type === "identifier") calleeName = fn.text;
  else if (fn.type === "member_expression") {
    const obj = fn.childForFieldName("object");
    if (obj && obj.type === "identifier") calleeName = obj.text;
  }
  if (!calleeName) return;
  const target = ctx.importAliases.get(calleeName);
  if (target) pushCall(ctx, target);
}

function typeIdentifiersIn(node: TsNode): string[] {
  const out: string[] = [];
  const stack: TsNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (!n) continue;
    if (n.type === "type_identifier" || n.type === "identifier") {
      out.push(n.text);
      continue; // don't descend into a leaf identifier
    }
    if (n.type === "generic_type" || n.type === "type_arguments") {
      // skip into the base name only; type args are descendants of the same node.
    }
    for (const c of n.namedChildren) if (c) stack.push(c);
  }
  return out;
}

function findChild(node: TsNode, type: string): TsNode | null {
  for (const c of node.namedChildren) if (c && c.type === type) return c;
  return null;
}

// ─── Python ──────────────────────────────────────────────────────────────────

function pySpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "import_statement": return visitPyImport(node, ctx);
        case "import_from_statement":
        case "future_import_statement":
          return visitPyFromImport(node, ctx);
        case "class_definition": return visitPyClass(node, ctx);
        case "decorated_definition": return; // descend into .definition; child handler picks it up
        case "function_definition": return visitPyTopLevelDef(node, ctx);
        case "call":
          if (ctx.anyImports) visitPyCall(node, ctx);
          return;
      }
    },
  };
}

function visitPyImport(node: TsNode, ctx: Ctx): void {
  // `import x`, `import x.y`, `import x as y`
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "dotted_name") {
      const module = child.text;
      const targetPath = resolvePythonModule(ctx.filePath, module);
      const localName = module.split(".")[0];
      pushImport(ctx, targetPath, { sourceSymbol: localName, confidence: 0.9 });
    } else if (child.type === "aliased_import") {
      const moduleNode = child.childForFieldName("name");
      const alias = fieldText(child, "alias");
      if (!moduleNode) continue;
      const module = moduleNode.text;
      const targetPath = resolvePythonModule(ctx.filePath, module);
      pushImport(ctx, targetPath, { sourceSymbol: alias ?? module.split(".")[0], confidence: 0.9 });
    }
  }
}

function visitPyFromImport(node: TsNode, ctx: Ctx): void {
  // future_import_statement has no `module_name` field — the module is
  // implicitly `__future__`. Hardcode it so the imported names still emit.
  let moduleNode: TsNode | null = null;
  let module: string;
  if (node.type === "future_import_statement") {
    module = "__future__";
  } else {
    moduleNode = node.childForFieldName("module_name");
    module = moduleNode?.text ?? "";
    if (!module) return;
  }
  const targetPath = resolvePythonModule(ctx.filePath, module);
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child === moduleNode) continue;
    if (child.type === "dotted_name") {
      const name = child.text;
      // `from x import *` shows up as a `wildcard_import` node, not a dotted_name,
      // so dotted_name here is always a real symbol.
      pushImport(ctx, targetPath, { sourceSymbol: name, targetSymbol: name });
    } else if (child.type === "aliased_import") {
      const name = fieldText(child, "name");
      const alias = fieldText(child, "alias");
      if (name) pushImport(ctx, targetPath, { sourceSymbol: alias ?? name, targetSymbol: name });
    } else if (child.type === "wildcard_import") {
      pushImport(ctx, targetPath, { confidence: 0.7 });
    }
  }
}

function visitPyClass(node: TsNode, ctx: Ctx): void {
  const className = fieldText(node, "name");
  if (className) pushExport(ctx, className);
  if (!className) return;
  const superList = node.childForFieldName("superclasses");
  if (!superList) return;
  for (const child of superList.namedChildren) {
    if (!child) continue;
    if (child.type === "identifier") pushHeritage(ctx, "extends", className, child.text);
    else if (child.type === "attribute") {
      const last = lastAttributeIdentifier(child);
      if (last) pushHeritage(ctx, "extends", className, last);
    }
    // keyword_argument (e.g. metaclass=) intentionally not emitted as extends —
    // EdgeKind has no `metaclass`; drop silently to avoid muddying the graph.
  }
}

function visitPyTopLevelDef(node: TsNode, ctx: Ctx): void {
  // Only emit exports for module-level defs. A function_definition's parent
  // chain to root is a small constant — walk up cheaply rather than threading
  // a depth counter through visit().
  let p: TsNode | null = node.parent;
  while (p) {
    if (p.type === "module") break;
    if (p.type === "decorated_definition") { p = p.parent; continue; }
    return; // nested def
  }
  const name = fieldText(node, "name");
  if (name) pushExport(ctx, name);
}

function visitPyCall(node: TsNode, ctx: Ctx): void {
  const fn = node.childForFieldName("function");
  if (!fn) return;
  let calleeName: string | undefined;
  if (fn.type === "identifier") calleeName = fn.text;
  else if (fn.type === "attribute") {
    const obj = fn.childForFieldName("object");
    if (obj && obj.type === "identifier") calleeName = obj.text;
  }
  if (!calleeName) return;
  const target = ctx.importAliases.get(calleeName);
  if (target) pushCall(ctx, target);
}

function lastAttributeIdentifier(node: TsNode): string | undefined {
  const attr = node.childForFieldName("attribute");
  return attr?.text;
}

// ─── Go ──────────────────────────────────────────────────────────────────────

function goSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "import_declaration": return visitGoImport(node, ctx);
        case "function_declaration":
        case "method_declaration":
          return visitGoFunc(node, ctx);
        case "type_declaration": return visitGoType(node, ctx);
        case "call_expression":
          if (ctx.anyImports) visitGoCall(node, ctx);
          return;
      }
    },
  };
}

function visitGoImport(node: TsNode, ctx: Ctx): void {
  // import "x" | import alias "x" | import ( "x"; alias "y" )
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "import_spec") emitGoImportSpec(child, ctx);
    else if (child.type === "import_spec_list") {
      for (const spec of child.namedChildren) {
        if (spec && spec.type === "import_spec") emitGoImportSpec(spec, ctx);
      }
    }
  }
}

function emitGoImportSpec(spec: TsNode, ctx: Ctx): void {
  const pathNode = spec.childForFieldName("path");
  if (!pathNode) return;
  const targetPath = stringNodeText(pathNode);
  if (!targetPath) return;
  const nameNode = spec.childForFieldName("name");
  const alias = nameNode?.text;
  // alias may be "_" (blank) or "." (dot import). Both still count as imports.
  pushImport(ctx, targetPath, { sourceSymbol: alias ?? targetPath.split("/").pop(), confidence: 1.0 });
}

function visitGoFunc(node: TsNode, ctx: Ctx): void {
  const name = fieldText(node, "name");
  // Go: capitalized identifier at package level = exported. Methods get
  // exported if their name is capitalized.
  if (name && /^[A-Z]/.test(name)) pushExport(ctx, name);
}

function visitGoType(node: TsNode, ctx: Ctx): void {
  for (const spec of node.namedChildren) {
    if (!spec) continue;
    if (spec.type === "type_spec" || spec.type === "type_alias") {
      const name = fieldText(spec, "name");
      if (name && /^[A-Z]/.test(name)) pushExport(ctx, name);
    }
  }
}

function visitGoCall(node: TsNode, ctx: Ctx): void {
  const fn = node.childForFieldName("function");
  if (!fn) return;
  let calleeName: string | undefined;
  if (fn.type === "identifier") calleeName = fn.text;
  else if (fn.type === "selector_expression") {
    const operand = fn.childForFieldName("operand");
    if (operand && operand.type === "identifier") calleeName = operand.text;
  }
  if (!calleeName) return;
  const target = ctx.importAliases.get(calleeName);
  if (target) pushCall(ctx, target);
}

// ─── Rust ────────────────────────────────────────────────────────────────────

function rustSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "use_declaration": return visitRustUse(node, ctx);
        case "function_item":
        case "struct_item":
        case "enum_item":
        case "trait_item":
        case "type_item":
        case "union_item":
          return visitRustItem(node, ctx);
        case "impl_item": return visitRustImpl(node, ctx);
        case "macro_invocation": return; // do NOT descend — args are token_tree, not calls
        case "call_expression":
          if (ctx.anyImports) visitRustCall(node, ctx);
          return;
      }
    },
  };
}

function visitRustUse(node: TsNode, ctx: Ctx): void {
  // Walk the use_tree, collecting all leaf paths.
  const argument = node.childForFieldName("argument");
  if (!argument) return;
  for (const { pathSegments, alias } of expandRustUseTree(argument)) {
    if (!pathSegments.length) continue;
    const targetPath = pathSegments.join("/");
    const last = pathSegments[pathSegments.length - 1];
    const localName = alias ?? (last === "*" ? undefined : last);
    pushImport(ctx, targetPath, { sourceSymbol: localName, targetSymbol: last, confidence: 0.9 });
  }
}

function expandRustUseTree(node: TsNode, prefix: string[] = []): { pathSegments: string[]; alias?: string }[] {
  const out: { pathSegments: string[]; alias?: string }[] = [];
  if (node.type === "identifier" || node.type === "self" || node.type === "super" || node.type === "crate" || node.type === "scoped_identifier") {
    out.push({ pathSegments: [...prefix, ...node.text.split("::").filter(Boolean)] });
    return out;
  }
  if (node.type === "use_wildcard") {
    out.push({ pathSegments: [...prefix, "*"] });
    return out;
  }
  if (node.type === "use_as_clause") {
    const innerPath = node.childForFieldName("path");
    const alias = fieldText(node, "alias");
    if (innerPath) {
      const segs = innerPath.text.split("::").filter(Boolean);
      out.push({ pathSegments: [...prefix, ...segs], alias });
    }
    return out;
  }
  if (node.type === "use_list") {
    for (const c of node.namedChildren) {
      if (!c) continue;
      out.push(...expandRustUseTree(c, prefix));
    }
    return out;
  }
  if (node.type === "scoped_use_list") {
    const inner = node.childForFieldName("list");
    const pathNode = node.childForFieldName("path");
    const segs = pathNode ? pathNode.text.split("::").filter(Boolean) : [];
    if (inner) out.push(...expandRustUseTree(inner, [...prefix, ...segs]));
    return out;
  }
  return out;
}

function visitRustItem(node: TsNode, ctx: Ctx): void {
  // Visibility marker comes before the keyword; check for a `visibility_modifier` child.
  const isPub = node.namedChildren.some((c) => c && c.type === "visibility_modifier");
  if (!isPub) return;
  const name = fieldText(node, "name");
  if (name) pushExport(ctx, name);
}

function visitRustImpl(node: TsNode, ctx: Ctx): void {
  const traitNode = node.childForFieldName("trait");
  const typeNode = node.childForFieldName("type");
  if (typeNode && traitNode) {
    pushHeritage(ctx, "implements", typeNode.text.split("<")[0].trim(), traitNode.text.split("<")[0].trim(), 0.9);
  }
}

function visitRustCall(node: TsNode, ctx: Ctx): void {
  const fn = node.childForFieldName("function");
  if (!fn) return;
  let calleeName: string | undefined;
  if (fn.type === "identifier") calleeName = fn.text;
  else if (fn.type === "scoped_identifier") {
    const head = fn.childForFieldName("path");
    if (head) calleeName = head.text.split("::").shift();
  } else if (fn.type === "field_expression") {
    const v = fn.childForFieldName("value");
    if (v && v.type === "identifier") calleeName = v.text;
  }
  if (!calleeName) return;
  const target = ctx.importAliases.get(calleeName);
  if (target) pushCall(ctx, target);
}

// ─── Java ────────────────────────────────────────────────────────────────────

function javaSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "import_declaration": return visitJavaImport(node, ctx);
        case "class_declaration":
        case "interface_declaration":
        case "enum_declaration":
        case "record_declaration":
          return visitJavaType(node, ctx);
        case "method_invocation":
          if (ctx.anyImports) visitJavaCall(node, ctx);
          return;
      }
    },
  };
}

function visitJavaImport(node: TsNode, ctx: Ctx): void {
  const isStatic = node.children.some((c) => c && c.text === "static");
  const isWildcard = node.children.some((c) => c && c.text === "*");
  const scoped = node.namedChildren.find((c) => c && (c.type === "scoped_identifier" || c.type === "identifier"));
  if (!scoped) return;
  const fqn = scoped.text;
  const parts = fqn.split(".");
  const last = parts[parts.length - 1];
  const targetPath = fqn.replace(/\./g, "/");
  const localName = isWildcard ? undefined : last;
  pushImport(ctx, targetPath, { sourceSymbol: localName, targetSymbol: last, confidence: isStatic ? 0.85 : 0.9 });
}

function visitJavaType(node: TsNode, ctx: Ctx): void {
  const isPublic = node.namedChildren.some((c) => c && c.type === "modifiers" && c.text.includes("public"));
  const name = fieldText(node, "name");
  if (name && isPublic) pushExport(ctx, name);
  if (!name) return;
  const superclass = findChild(node, "superclass");
  if (superclass) {
    for (const t of javaTypeNames(superclass)) pushHeritage(ctx, "extends", name, t);
  }
  const superInterfaces = findChild(node, "super_interfaces");
  if (superInterfaces) {
    for (const t of javaTypeNames(superInterfaces)) pushHeritage(ctx, "implements", name, t);
  }
  const extendsInterfaces = findChild(node, "extends_interfaces");
  if (extendsInterfaces) {
    for (const t of javaTypeNames(extendsInterfaces)) pushHeritage(ctx, "extends", name, t);
  }
}

function javaTypeNames(node: TsNode): string[] {
  const out: string[] = [];
  const stack: TsNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (!n) continue;
    if (n.type === "type_identifier") { out.push(n.text); continue; }
    if (n.type === "generic_type") {
      const base = n.childForFieldName("type") ?? n.childForFieldName("name") ?? n.namedChildren[0];
      if (base) stack.push(base);
      continue;
    }
    for (const c of n.namedChildren) if (c) stack.push(c);
  }
  return out;
}

function visitJavaCall(node: TsNode, ctx: Ctx): void {
  const obj = node.childForFieldName("object");
  if (obj && obj.type === "identifier") {
    const target = ctx.importAliases.get(obj.text);
    if (target) pushCall(ctx, target);
  }
}

// ─── C# ──────────────────────────────────────────────────────────────────────

function csharpSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "using_directive": return visitCsUsing(node, ctx);
        case "class_declaration":
        case "interface_declaration":
        case "struct_declaration":
        case "record_declaration":
          return visitCsType(node, ctx);
        case "invocation_expression":
          if (ctx.anyImports) visitCsCall(node, ctx);
          return;
      }
    },
  };
}

function visitCsUsing(node: TsNode, ctx: Ctx): void {
  const aliasNode = node.childForFieldName("alias");
  const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((c) => c && (c.type === "qualified_name" || c.type === "identifier"));
  if (!nameNode) return;
  const fqn = nameNode.text;
  const targetPath = fqn.replace(/\./g, "/");
  const localName = aliasNode?.text ?? fqn.split(".").pop();
  pushImport(ctx, targetPath, { sourceSymbol: localName, targetSymbol: localName, confidence: 0.85 });
}

function visitCsType(node: TsNode, ctx: Ctx): void {
  const modifiers = findChild(node, "modifier_list");
  const isPublic = modifiers ? modifiers.text.includes("public") : node.children.some((c) => c && c.text === "public");
  const name = fieldText(node, "name");
  if (name && isPublic) pushExport(ctx, name);
  if (!name) return;
  const baseList = findChild(node, "base_list");
  if (!baseList) return;
  for (const child of baseList.namedChildren) {
    if (!child) continue;
    const targetName = child.text.split("<")[0].trim();
    if (!targetName) continue;
    // C# convention: I-prefixed = interface; we treat structurally where possible.
    const kind: "implements" | "extends" = /^I[A-Z]/.test(targetName) ? "implements" : "extends";
    pushHeritage(ctx, kind, name, targetName, 0.8);
  }
}

function visitCsCall(node: TsNode, ctx: Ctx): void {
  const fn = node.childForFieldName("function");
  if (!fn) return;
  let calleeName: string | undefined;
  if (fn.type === "identifier") calleeName = fn.text;
  else if (fn.type === "member_access_expression") {
    const exprChild = fn.namedChildren.find((c) => c && c.type === "identifier");
    if (exprChild) calleeName = exprChild.text;
  }
  if (!calleeName) return;
  const target = ctx.importAliases.get(calleeName);
  if (target) pushCall(ctx, target);
}

// ─── C / C++ ─────────────────────────────────────────────────────────────────
// Includes are file-level imports; there is no symbol binding to feed a call
// table, so calls are intentionally not extracted (they'd all be guesses).

function cLikeSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "preproc_include": {
          const pathNode = node.childForFieldName("path");
          if (!pathNode) return;
          if (pathNode.type === "system_lib_string") return; // <stdio.h> — not a project file
          const spec = stringNodeText(pathNode);
          if (spec) pushImport(ctx, joinRelative(ctx.filePath, spec), { confidence: 0.95 });
          return;
        }
        case "function_definition": {
          const isStatic = node.namedChildren.some((c) => c && c.type === "storage_class_specifier" && c.text === "static");
          if (isStatic) return;
          const name = cDeclaratorIdentifier(node);
          if (name) pushExport(ctx, name);
          return;
        }
        case "class_specifier":
        case "struct_specifier":
        case "enum_specifier": {
          const name = fieldText(node, "name");
          // Forward declarations (`struct Foo;`) have no body — skip them.
          if (name && node.childForFieldName("body")) pushExport(ctx, name);
          if (node.type === "class_specifier" || node.type === "struct_specifier") {
            const name2 = fieldText(node, "name");
            const bases = findChild(node, "base_class_clause");
            if (name2 && bases) {
              for (const b of bases.namedChildren) {
                if (b && (b.type === "type_identifier" || b.type === "qualified_identifier")) pushHeritage(ctx, "extends", name2, b.text, 0.85);
              }
            }
          }
          return;
        }
        case "type_definition": {
          const d = node.childForFieldName("declarator");
          if (d?.type === "type_identifier") pushExport(ctx, d.text);
          return;
        }
      }
    },
  };
}

function cDeclaratorIdentifier(node: TsNode): string | undefined {
  let d = node.childForFieldName("declarator");
  while (d) {
    if (d.type === "identifier" || d.type === "field_identifier" || d.type === "qualified_identifier") return d.text;
    d = d.childForFieldName("declarator");
  }
  return undefined;
}

// ─── Ruby ────────────────────────────────────────────────────────────────────

function rubySpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "call": {
          // require "x" / require_relative "./x" are ordinary method calls.
          const method = node.namedChildren.find((c) => c && c.type === "identifier");
          if (!method || (method.text !== "require" && method.text !== "require_relative")) return;
          const args = node.namedChildren.find((c) => c && c.type === "argument_list");
          const str = args?.namedChildren.find((c) => c && c.type === "string");
          const spec = str ? stringNodeText(str) : null;
          if (!spec) return;
          if (method.text === "require_relative") pushImport(ctx, joinRelative(ctx.filePath, spec), { confidence: 0.95 });
          // bare `require "json"` targets a gem, not a project file — dropped
          // to match the TS handling of bare imports.
          return;
        }
        case "module":
        case "class": {
          const name = fieldText(node, "name");
          if (name) pushExport(ctx, name);
          if (node.type === "class" && name) {
            const sup = node.childForFieldName("superclass");
            const target = sup?.namedChildren.find((c) => c && (c.type === "constant" || c.type === "scope_resolution"));
            if (target) pushHeritage(ctx, "extends", name, target.text, 0.9);
          }
          return;
        }
        case "method":
        case "singleton_method": {
          // Top-level methods only — instance methods belong to their class chunk.
          if (topLevelIn(node, "program")) {
            const name = fieldText(node, "name");
            if (name) pushExport(ctx, name);
          }
          return;
        }
      }
    },
  };
}

/** True when the node's nearest interesting ancestor is the file root. */
function topLevelIn(node: TsNode, rootType: string): boolean {
  let p: TsNode | null = node.parent;
  while (p) {
    if (p.type === rootType) return true;
    if (p.type === "class" || p.type === "module" || p.type === "class_declaration" || p.type === "object_declaration") return false;
    p = p.parent;
  }
  return false;
}

// ─── PHP ─────────────────────────────────────────────────────────────────────

function phpSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "namespace_use_declaration": {
          for (const clause of node.namedChildren) {
            if (!clause || clause.type !== "namespace_use_clause") continue;
            const qn = clause.namedChildren.find((c) => c && (c.type === "qualified_name" || c.type === "name"));
            if (!qn) continue;
            const fqn = qn.text.replace(/^\\/, "");
            const parts = fqn.split("\\");
            const last = parts[parts.length - 1];
            const aliasNode = clause.namedChildren.find((c) => c && c.type === "namespace_aliasing_clause");
            const alias = aliasNode?.namedChildren.find((c) => c && c.type === "name")?.text;
            pushImport(ctx, parts.join("/"), { sourceSymbol: alias ?? last, targetSymbol: last, confidence: 0.9 });
          }
          return;
        }
        case "require_expression":
        case "require_once_expression":
        case "include_expression":
        case "include_once_expression": {
          const str = node.namedChildren.find((c) => c && (c.type === "encapsed_string" || c.type === "string"));
          const spec = str ? stringNodeText(str) : null;
          if (spec) pushImport(ctx, joinRelative(ctx.filePath, spec), { confidence: 0.85 });
          return;
        }
        case "class_declaration":
        case "interface_declaration":
        case "trait_declaration":
        case "enum_declaration": {
          const name = fieldText(node, "name");
          if (name) pushExport(ctx, name);
          if (!name) return;
          const base = findChild(node, "base_clause");
          if (base) for (const b of base.namedChildren) {
            if (b && (b.type === "name" || b.type === "qualified_name")) pushHeritage(ctx, "extends", name, b.text.split("\\").pop()!, 0.9);
          }
          const impl = findChild(node, "class_interface_clause");
          if (impl) for (const b of impl.namedChildren) {
            if (b && (b.type === "name" || b.type === "qualified_name")) pushHeritage(ctx, "implements", name, b.text.split("\\").pop()!, 0.9);
          }
          return;
        }
        case "function_definition": {
          const name = fieldText(node, "name");
          if (name) pushExport(ctx, name);
          return;
        }
        case "object_creation_expression":
        case "scoped_call_expression": {
          if (!ctx.anyImports) return;
          const nameNode = node.namedChildren.find((c) => c && (c.type === "name" || c.type === "qualified_name"));
          if (!nameNode) return;
          const target = ctx.importAliases.get(nameNode.text.split("\\").pop()!);
          if (target) pushCall(ctx, target);
          return;
        }
      }
    },
  };
}

// ─── Kotlin ──────────────────────────────────────────────────────────────────

function kotlinSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "import_header": {
          const id = node.namedChildren.find((c) => c && c.type === "identifier");
          if (!id) return;
          const fqn = id.text;
          const parts = fqn.split(".");
          const last = parts[parts.length - 1];
          const wildcard = node.namedChildren.some((c) => c && c.type === "wildcard_import");
          pushImport(ctx, parts.join("/"), {
            sourceSymbol: wildcard ? undefined : last,
            targetSymbol: wildcard ? undefined : last,
            confidence: 0.9,
          });
          return;
        }
        case "class_declaration":
        case "object_declaration": {
          const name = node.namedChildren.find((c) => c && c.type === "type_identifier")?.text;
          if (name && topLevelIn(node, "source_file")) pushExport(ctx, name);
          if (!name) return;
          for (const spec of node.namedChildren) {
            if (!spec || spec.type !== "delegation_specifier") continue;
            const ctor = spec.namedChildren.find((c) => c && c.type === "constructor_invocation");
            if (ctor) {
              const t = ctor.namedChildren.find((c) => c && c.type === "user_type");
              if (t) pushHeritage(ctx, "extends", name, t.text.split("<")[0], 0.85);
            } else {
              const t = spec.namedChildren.find((c) => c && c.type === "user_type");
              if (t) pushHeritage(ctx, "implements", name, t.text.split("<")[0], 0.8);
            }
          }
          return;
        }
        case "function_declaration": {
          if (!topLevelIn(node, "source_file")) return;
          const name = node.namedChildren.find((c) => c && c.type === "simple_identifier")?.text;
          if (name) pushExport(ctx, name);
          return;
        }
        case "call_expression": {
          if (!ctx.anyImports) return;
          const head = node.namedChildren[0];
          let calleeName: string | undefined;
          if (head?.type === "simple_identifier") calleeName = head.text;
          else if (head?.type === "navigation_expression") {
            const obj = head.namedChildren[0];
            if (obj?.type === "simple_identifier") calleeName = obj.text;
          }
          if (!calleeName) return;
          const target = ctx.importAliases.get(calleeName);
          if (target) pushCall(ctx, target);
          return;
        }
      }
    },
  };
}

// ─── Swift ───────────────────────────────────────────────────────────────────

function swiftSpec(): LanguageGraphSpec {
  return {
    visit(node, ctx) {
      switch (node.type) {
        case "import_declaration": {
          const id = node.namedChildren.find((c) => c && c.type === "identifier");
          if (!id) return;
          pushImport(ctx, id.text.replace(/\./g, "/"), { confidence: 0.85 });
          return;
        }
        case "class_declaration": {
          // Covers classes, structs, enums, and extensions in this grammar.
          const name = fieldText(node, "name")?.split("<")[0];
          if (name && topLevelIn(node, "source_file")) pushExport(ctx, name);
          if (!name) return;
          for (const spec of node.namedChildren) {
            if (!spec || spec.type !== "inheritance_specifier") continue;
            const t = spec.namedChildren.find((c) => c && c.type === "user_type");
            if (t) pushHeritage(ctx, "extends", name, t.text.split("<")[0], 0.8);
          }
          return;
        }
        case "protocol_declaration": {
          const name = fieldText(node, "name");
          if (name) pushExport(ctx, name);
          return;
        }
        case "function_declaration": {
          if (!topLevelIn(node, "source_file")) return;
          const name = node.namedChildren.find((c) => c && c.type === "simple_identifier")?.text;
          if (name) pushExport(ctx, name);
          return;
        }
      }
    },
  };
}
