import type { Node as TsNode } from "web-tree-sitter";
import { Chunk, File, SymbolKind } from "./types";
import { computeBlobName } from "./utils";
import { CodeChunker } from "./chunker";
import { ParserPool, ParsedFile, languageForPath } from "./ast-graph-shared";

export interface AstChunkerOptions {
  maxChunkChars: number;
  fallback: CodeChunker;
  /** Optional shared pool so chunker + graph-extractor parse each file once. */
  pool?: ParserPool;
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

export class AstChunker {
  // Pool is shared across calls so we don't construct a Parser per file.
  // Constructor accepts an external pool; the graph extractor instantiated in
  // OpenContext shares the same one, which is how parse-once-per-file works.
  private pool: ParserPool;
  private ownsPool: boolean;

  constructor(private opts: AstChunkerOptions) {
    this.pool = opts.pool ?? new ParserPool();
    this.ownsPool = !opts.pool;
  }

  static languageFor(filePath: string): string | null {
    return languageForPath(filePath);
  }

  /** Public access to the pool so OpenContext can share it with AstGraphExtractor. */
  getPool(): ParserPool { return this.pool; }

  /**
   * Parse the file once and return the tree + dispose handle. Returns null on
   * unsupported extensions, WASM load failures, or parse aborts — caller
   * should treat that the same as the chunker's regex fallback path. Callers
   * must `dispose()` exactly once, ideally in a finally.
   */
  async parseFile(file: File): Promise<ParsedFile | null> {
    return this.pool.parseFile(file.path, file.contents);
  }

  /**
   * Chunk a file into semantic units. If `opts.parsed` is provided, the
   * existing parse tree is reused (so the graph extractor and the chunker
   * share one parse). If parse/coverage fails, falls back to the line-based
   * chunker on the raw source.
   *
   * Note: when called with `parsed`, this method DOES NOT dispose the tree —
   * the caller passed it in and owns its lifecycle. When called without
   * `parsed`, the method parses + disposes internally.
   */
  async chunkFile(file: File, opts: { parsed?: ParsedFile | null } = {}): Promise<Chunk[]> {
    const lang = AstChunker.languageFor(file.path);
    if (!lang) return this.opts.fallback.chunkFile(file);
    const spec = SPECS[lang];

    // Either reuse the passed-in parse, or do one ourselves and dispose at the end.
    const provided = opts.parsed ?? null;
    const parsed = provided ?? (await this.parseFile(file));
    if (!parsed) return this.opts.fallback.chunkFile(file);
    try {
      const collected: { node: TsNode; kind: SymbolKind; parent: string | null }[] = [];
      this.collect(parsed.tree.rootNode, spec, null, collected);
      if (!collected.length) return this.opts.fallback.chunkFile(file);
      const materialized = collected.map(c => ({
        kind: c.kind,
        parent: c.parent,
        name: this.nameOf(c.node, spec),
        startIndex: c.node.startIndex,
        endIndex: c.node.endIndex,
        startLine: c.node.startPosition.row + 1,
        endLine: c.node.endPosition.row + 1,
      }));
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
    } finally {
      // Only dispose if we did the parse ourselves; otherwise the caller owns it.
      if (!provided) parsed.dispose();
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

  dispose(): void {
    if (this.ownsPool) this.pool.disposeAll();
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
