import * as path from "path";
import type { Node as TsNode } from "web-tree-sitter";
import type { GraphEdge } from "../code-graph";

export interface ExtractionResult {
  edges: GraphEdge[];
  exports: string[];
}

export interface ImportTarget {
  targetPath: string;
  targetSymbol?: string;
  isTypeOnly: boolean;
}

export interface Ctx {
  filePath: string;
  edges: GraphEdge[];
  exports: string[];
  importAliases: Map<string, ImportTarget>;
  anyImports: boolean;
}

export interface LanguageGraphSpec {
  prescan?(root: TsNode, ctx: Ctx): void;
  visit(node: TsNode, ctx: Ctx): void;
}

export function walk(node: TsNode, spec: LanguageGraphSpec, ctx: Ctx): void {
  spec.visit(node, ctx);
  for (const child of node.namedChildren) if (child) walk(child, spec, ctx);
}

export function resolveRelative(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.posix.dirname(fromPath);
  return path.posix.normalize(path.posix.join(dir, specifier));
}

export function resolvePythonModule(fromPath: string, module: string): string {
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

export function pushImport(ctx: Ctx, targetPath: string, opts: { sourceSymbol?: string; targetSymbol?: string; confidence?: number; isTypeOnly?: boolean } = {}): void {
  const sourceSymbol = opts.sourceSymbol;
  ctx.edges.push({ sourcePath: ctx.filePath, sourceSymbol, targetPath, targetSymbol: opts.targetSymbol, kind: "imports", confidence: opts.confidence ?? 1.0 });
  ctx.anyImports = true;
  if (sourceSymbol && !opts.isTypeOnly) ctx.importAliases.set(sourceSymbol, { targetPath, targetSymbol: opts.targetSymbol, isTypeOnly: false });
}

export function pushExport(ctx: Ctx, name: string): void {
  ctx.exports.push(name);
  ctx.edges.push({ sourcePath: ctx.filePath, sourceSymbol: name, targetPath: ctx.filePath, targetSymbol: name, kind: "exports", confidence: 1.0 });
}

export function pushHeritage(ctx: Ctx, kind: "extends" | "implements", source: string, target: string, confidence = 0.85): void {
  ctx.edges.push({ sourcePath: ctx.filePath, sourceSymbol: source, targetPath: ctx.filePath, targetSymbol: target, kind, confidence });
}

export function pushCall(ctx: Ctx, target: ImportTarget, confidence = 0.75): void {
  ctx.edges.push({ sourcePath: ctx.filePath, sourceSymbol: undefined, targetPath: target.targetPath, targetSymbol: target.targetSymbol, kind: "calls", confidence });
}

export function fieldText(node: TsNode, field: string): string | undefined { return node.childForFieldName(field)?.text; }

export function stringNodeText(node: TsNode): string | null {
  if (node.type !== "string" && node.type !== "interpreted_string_literal" && node.type !== "raw_string_literal" && node.type !== "string_literal" && node.type !== "encapsed_string") return null;
  const frag = node.namedChildren.find((c) => c && (c.type === "string_fragment" || c.type === "raw_str_part" || c.type === "interpreted_string_literal_content" || c.type === "string_content"));
  if (frag) return frag.text;
  const t = node.text;
  if (t.length >= 2 && (t.startsWith("\"") || t.startsWith("'") || t.startsWith("`"))) return t.slice(1, -1);
  return t;
}

export function joinRelative(fromPath: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
}

export function findChild(node: TsNode, type: string): TsNode | null {
  for (const c of node.namedChildren) if (c && c.type === type) return c;
  return null;
}

export function topLevelIn(node: TsNode, rootType: string): boolean {
  let p: TsNode | null = node.parent;
  while (p) {
    if (p.type === rootType) return true;
    if (p.type === "class" || p.type === "module" || p.type === "class_declaration" || p.type === "object_declaration") return false;
    p = p.parent;
  }
  return false;
}
