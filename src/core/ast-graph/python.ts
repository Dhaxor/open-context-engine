import type { Node as TsNode } from "web-tree-sitter";
import { Ctx, LanguageGraphSpec, fieldText, pushCall, pushExport, pushHeritage, pushImport, resolvePythonModule } from "./shared";

// ─── Python ──────────────────────────────────────────────────────────────────

export function pySpec(): LanguageGraphSpec {
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

