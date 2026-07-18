import type { Node as TsNode } from "web-tree-sitter";
import { Ctx, LanguageGraphSpec, fieldText, findChild, joinRelative, pushCall, pushExport, pushHeritage, pushImport, stringNodeText, topLevelIn } from "./shared";

// ─── Rust ────────────────────────────────────────────────────────────────────

export function rustSpec(): LanguageGraphSpec {
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

export function javaSpec(): LanguageGraphSpec {
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

export function csharpSpec(): LanguageGraphSpec {
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

export function cLikeSpec(): LanguageGraphSpec {
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

export function rubySpec(): LanguageGraphSpec {
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
// ─── PHP ─────────────────────────────────────────────────────────────────────

export function phpSpec(): LanguageGraphSpec {
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

export function kotlinSpec(): LanguageGraphSpec {
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

export function swiftSpec(): LanguageGraphSpec {
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
