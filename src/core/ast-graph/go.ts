import type { Node as TsNode } from "web-tree-sitter";
import { Ctx, LanguageGraphSpec, fieldText, pushCall, pushExport, pushImport, stringNodeText } from "./shared";

// ─── Go ──────────────────────────────────────────────────────────────────────

export function goSpec(): LanguageGraphSpec {
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

