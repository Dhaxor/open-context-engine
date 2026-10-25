import type { Node as TsNode } from "web-tree-sitter";
import { Ctx, LanguageGraphSpec, fieldText, findChild, pushCall, pushExport, pushHeritage, pushImport, resolveRelative, stringNodeText } from "./shared";

// ─── TypeScript / JavaScript ─────────────────────────────────────────────────

export function tsSpec(): LanguageGraphSpec {
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
