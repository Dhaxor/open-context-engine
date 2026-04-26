import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import type { Parser as TsParser, Language as TsLanguage, Node as TsNode } from "web-tree-sitter";
import { Chunk, File, SymbolKind } from "./types";
import { computeBlobName } from "./utils";
import { CodeChunker } from "./chunker";

const requireFromHere = createRequire(__filename);

export interface AstChunkerOptions {
  maxChunkChars: number;
  fallback: CodeChunker;
}

interface LanguageSpec {
  atomic: Map<string, SymbolKind>;
  containers: Set<string>;
  nameFields: string[];
}

const SPECS: Record<string, LanguageSpec> = {
  typescript: tsSpec(),
  tsx: tsSpec(),
  javascript: tsSpec(),
  python: pySpec(),
  go: goSpec(),
  rust: rustSpec(),
  java: javaSpec(),
  c_sharp: csharpSpec(),
};

const EXTENSION_MAP: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "c_sharp",
};

export class AstChunker {
  private static parserInit: Promise<void> | null = null;
  private static parserModule: typeof import("web-tree-sitter") | null = null;
  private static langCache: Map<string, Promise<TsLanguage | null>> = new Map();

  private parser: TsParser | null = null;

  constructor(private opts: AstChunkerOptions) {}

  static languageFor(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext] ?? null;
  }

  async chunkFile(file: File): Promise<Chunk[]> {
    const lang = AstChunker.languageFor(file.path);
    if (!lang) return this.opts.fallback.chunkFile(file);
    const language = await this.loadLanguage(lang);
    if (!language) return this.opts.fallback.chunkFile(file);
    const spec = SPECS[lang];
    try {
      const parser = await this.getParser();
      parser.setLanguage(language);
      const tree = parser.parse(file.contents);
      if (!tree) return this.opts.fallback.chunkFile(file);
      const root = tree.rootNode;
      const collected: { node: TsNode; kind: SymbolKind; parent: string | null }[] = [];
      this.collect(root, spec, null, collected);
      if (!collected.length) { tree.delete(); return this.opts.fallback.chunkFile(file); }
      const materialized = collected.map(c => ({
        kind: c.kind,
        parent: c.parent,
        name: this.nameOf(c.node, spec),
        startIndex: c.node.startIndex,
        endIndex: c.node.endIndex,
        startLine: c.node.startPosition.row + 1,
        endLine: c.node.endPosition.row + 1,
      }));
      tree.delete();
      const covered = materialized.reduce((s, c) => s + (c.endIndex - c.startIndex), 0);
      if (covered < file.contents.length * 0.35) return this.opts.fallback.chunkFile(file);
      const lines = file.contents.split("\n");
      const out: Chunk[] = [];
      for (const c of materialized) {
        const body = lines.slice(c.startLine - 1, c.endLine).join("\n");
        for (const piece of this.splitOversize(body, c.startLine, c.endLine)) {
          out.push(this.mk(file, piece.body, piece.start, piece.end, c.name, c.kind, c.parent, lang));
        }
      }
      return out;
    } catch (err) {
      if (process.env.OPEN_CONTEXT_DEBUG) console.error(`AstChunker: chunkFile error on ${file.path}:`, err);
      return this.opts.fallback.chunkFile(file);
    }
  }

  private collect(node: TsNode, spec: LanguageSpec, parent: string | null, out: { node: TsNode; kind: SymbolKind; parent: string | null }[]): void {
    for (const child of node.namedChildren) {
      if (!child) continue;
      const kind = spec.atomic.get(child.type);
      if (kind) { out.push({ node: child, kind, parent }); continue; }
      if (spec.containers.has(child.type)) {
        const scoped = this.containerName(child, spec) ?? parent;
        this.collect(child, spec, scoped, out);
      } else {
        this.collect(child, spec, parent, out);
      }
    }
  }

  private containerName(node: TsNode, spec: LanguageSpec): string | null {
    for (const f of spec.nameFields) {
      const n = node.childForFieldName(f);
      if (n?.text) return n.text;
    }
    return null;
  }

  private nameOf(node: TsNode, spec: LanguageSpec): string | undefined {
    for (const f of spec.nameFields) {
      const n = node.childForFieldName(f);
      if (n?.text) return n.text;
    }
    const id = node.descendantsOfType(["identifier", "type_identifier", "property_identifier", "field_identifier"])[0];
    return id?.text || undefined;
  }

  private splitOversize(body: string, start: number, end: number): { body: string; start: number; end: number }[] {
    if (body.length <= this.opts.maxChunkChars) return [{ body, start, end }];
    const lines = body.split("\n");
    const out: { body: string; start: number; end: number }[] = [];
    let i = 0;
    while (i < lines.length) {
      let j = i, len = 0;
      while (j < lines.length && len + lines[j].length + 1 <= this.opts.maxChunkChars) { len += lines[j].length + 1; j++; }
      if (j === i) j = i + 1;
      out.push({ body: lines.slice(i, j).join("\n"), start: start + i, end: start + j - 1 });
      i = j;
    }
    return out;
  }

  private mk(file: File, contents: string, startLine: number, endLine: number, name: string | undefined, kind: SymbolKind, parent: string | null, lang: string): Chunk {
    return {
      id: computeBlobName(`${file.path}:${startLine}-${endLine}`, contents),
      path: file.path,
      startLine, endLine, contents,
      symbolName: name, symbolKind: kind,
      parentSymbol: parent ?? undefined,
      language: lang,
    };
  }

  private async getParser(): Promise<TsParser> {
    if (!this.parser) {
      const mod = await AstChunker.ensureParserInit();
      this.parser = new mod.Parser();
    }
    return this.parser;
  }

  private async loadLanguage(name: string): Promise<TsLanguage | null> {
    let cached = AstChunker.langCache.get(name);
    if (!cached) {
      cached = (async () => {
        try {
          const mod = await AstChunker.ensureParserInit();
          const wasmPath = resolveGrammarWasm(name);
          const bytes = await fs.promises.readFile(wasmPath);
          return await mod.Language.load(bytes);
        } catch (err) {
          if (process.env.OPEN_CONTEXT_DEBUG) console.error(`AstChunker: failed to load ${name}:`, err);
          return null;
        }
      })();
      AstChunker.langCache.set(name, cached);
    }
    return cached;
  }

  private static async ensureParserInit(): Promise<typeof import("web-tree-sitter")> {
    if (AstChunker.parserModule) return AstChunker.parserModule;
    if (!AstChunker.parserInit) {
      AstChunker.parserInit = (async () => {
        const mod = await import("web-tree-sitter");
        await mod.Parser.init();
        AstChunker.parserModule = mod;
      })();
    }
    await AstChunker.parserInit;
    return AstChunker.parserModule!;
  }

  dispose(): void {
    try { this.parser?.delete(); } catch {}
    this.parser = null;
  }
}

function resolveGrammarWasm(name: string): string {
  try {
    return requireFromHere.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
  } catch (err) {
    throw new Error(`Grammar wasm not found for language '${name}': ${(err as Error).message}`);
  }
}

function tsSpec(): LanguageSpec {
  return {
    atomic: new Map<string, SymbolKind>([
      ["function_declaration", "function"],
      ["generator_function_declaration", "function"],
      ["method_definition", "method"],
      ["method_signature", "method"],
      ["function_signature", "function"],
      ["abstract_method_signature", "method"],
      ["type_alias_declaration", "type"],
      ["enum_declaration", "enum"],
      ["interface_declaration", "interface"],
    ]),
    containers: new Set([
      "class_declaration", "abstract_class_declaration",
      "module", "internal_module", "namespace_declaration",
      "class_body", "program", "statement_block", "export_statement",
    ]),
    nameFields: ["name"],
  };
}

function pySpec(): LanguageSpec {
  return {
    atomic: new Map<string, SymbolKind>([
      ["function_definition", "function"],
      ["decorated_definition", "function"],
    ]),
    containers: new Set(["class_definition", "module", "block"]),
    nameFields: ["name"],
  };
}

function goSpec(): LanguageSpec {
  return {
    atomic: new Map<string, SymbolKind>([
      ["function_declaration", "function"],
      ["method_declaration", "method"],
      ["type_declaration", "type"],
    ]),
    containers: new Set(["source_file"]),
    nameFields: ["name"],
  };
}

function rustSpec(): LanguageSpec {
  return {
    atomic: new Map<string, SymbolKind>([
      ["function_item", "function"],
      ["struct_item", "struct"],
      ["enum_item", "enum"],
      ["trait_item", "interface"],
      ["type_item", "type"],
      ["union_item", "struct"],
    ]),
    containers: new Set(["source_file", "impl_item", "mod_item", "declaration_list"]),
    nameFields: ["name"],
  };
}

function javaSpec(): LanguageSpec {
  return {
    atomic: new Map<string, SymbolKind>([
      ["method_declaration", "method"],
      ["constructor_declaration", "method"],
      ["interface_declaration", "interface"],
      ["enum_declaration", "enum"],
      ["annotation_type_declaration", "type"],
    ]),
    containers: new Set(["program", "class_declaration", "class_body", "record_declaration", "enum_body"]),
    nameFields: ["name"],
  };
}

function csharpSpec(): LanguageSpec {
  return {
    atomic: new Map<string, SymbolKind>([
      ["method_declaration", "method"],
      ["constructor_declaration", "method"],
      ["destructor_declaration", "method"],
      ["operator_declaration", "method"],
      ["property_declaration", "field"],
      ["indexer_declaration", "field"],
      ["interface_declaration", "interface"],
      ["struct_declaration", "struct"],
      ["enum_declaration", "enum"],
      ["record_declaration", "class"],
      ["delegate_declaration", "type"],
    ]),
    containers: new Set([
      "compilation_unit", "namespace_declaration", "file_scoped_namespace_declaration",
      "class_declaration", "declaration_list",
    ]),
    nameFields: ["name"],
  };
}
