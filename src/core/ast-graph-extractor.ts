/**
 * AST-based code-graph extractor.
 *
 * Public dispatcher for language-specific AST graph extraction. Shared DFS,
 * edge helpers, and language implementations live under `ast-graph/` so each
 * grammar's symbol/import/call behavior can evolve independently while this
 * module preserves the extractor API consumed by graph-extractor.ts.
 */
import type { Tree as TsTree } from "web-tree-sitter";
import { File } from "./types";
import { cLikeSpec, csharpSpec, javaSpec, kotlinSpec, phpSpec, rubySpec, rustSpec, swiftSpec } from "./ast-graph/other-languages";
import { goSpec } from "./ast-graph/go";
import { pySpec } from "./ast-graph/python";
import { tsSpec } from "./ast-graph/typescript";
import { Ctx, ExtractionResult, LanguageGraphSpec, walk } from "./ast-graph/shared";

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

export type { ExtractionResult };

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
