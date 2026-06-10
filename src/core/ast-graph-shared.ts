/**
 * Shared tree-sitter parse infrastructure.
 *
 * Both AstChunker and AstGraphExtractor need to parse a file into a
 * tree-sitter syntax tree, and we want exactly one parse per file per
 * indexing pass. This module owns the parser module init, the per-language
 * WASM cache, and the file extension → grammar id mapping. It also exposes
 * a tiny `parseFile` helper that returns the tree + a dispose thunk; callers
 * pass the parsed result to whichever consumers need it and call dispose
 * once, in a finally, BEFORE the next file is parsed.
 *
 * Why this matters: tree-sitter syntax trees live in WASM linear memory off
 * the JS heap, are 2-10x the source size, and don't show up in V8 heap
 * profilers. Leaking even a handful per indexing pass on a 10k-file repo is
 * how the engine becomes "mysteriously slow after a re-index".
 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import type {
  Parser as TsParser,
  Language as TsLanguage,
  Tree as TsTree,
} from "web-tree-sitter";

const requireFromHere = createRequire(__filename);

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

export function languageForPath(filePath: string): string | null {
  return EXTENSION_MAP[path.extname(filePath).toLowerCase()] ?? null;
}

let parserInit: Promise<void> | null = null;
let parserModule: typeof import("web-tree-sitter") | null = null;
const langCache: Map<string, Promise<TsLanguage | null>> = new Map();

async function ensureParserInit(): Promise<typeof import("web-tree-sitter")> {
  if (parserModule) return parserModule;
  if (!parserInit) {
    parserInit = (async () => {
      const mod = await import("web-tree-sitter");
      await mod.Parser.init();
      parserModule = mod;
    })();
  }
  await parserInit;
  return parserModule!;
}

export async function loadLanguage(name: string): Promise<TsLanguage | null> {
  let cached = langCache.get(name);
  if (!cached) {
    cached = (async () => {
      try {
        const mod = await ensureParserInit();
        const wasmPath = resolveGrammarWasm(name);
        const bytes = await fs.promises.readFile(wasmPath);
        return await mod.Language.load(bytes);
      } catch (err) {
        if (process.env.OPEN_CONTEXT_DEBUG) console.error(`tree-sitter: failed to load ${name}:`, err);
        return null;
      }
    })();
    langCache.set(name, cached);
  }
  return cached;
}

function resolveGrammarWasm(name: string): string {
  try {
    return requireFromHere.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
  } catch (err) {
    throw new Error(`Grammar wasm not found for language '${name}': ${(err as Error).message}`);
  }
}

export interface ParsedFile {
  language: string;          // grammar id, e.g. "typescript" / "python"
  tree: TsTree;
  dispose(): void;           // releases the WASM-side tree memory
}

/**
 * Parse one file. Returns null when the language isn't supported, the WASM
 * grammar fails to load, or the parse aborts. **Callers must call
 * `dispose()` exactly once** — preferably in a try/finally so the tree never
 * outlives a single file iteration in the indexing loop.
 *
 * A Parser instance is reusable across files; we cache one per language id
 * and `setLanguage` between calls.
 */
export class ParserPool {
  // One Parser per language id. Reused across files within the same indexing
  // pass to avoid repeated Parser construction.
  private parsers: Map<string, TsParser> = new Map();

  async parseFile(filePath: string, contents: string): Promise<ParsedFile | null> {
    const language = languageForPath(filePath);
    if (!language) return null;
    const lang = await loadLanguage(language);
    if (!lang) return null;
    const mod = await ensureParserInit();
    let parser = this.parsers.get(language);
    if (!parser) {
      parser = new mod.Parser();
      this.parsers.set(language, parser);
    }
    parser.setLanguage(lang);
    let tree: TsTree | null;
    try {
      tree = parser.parse(contents);
    } catch (err) {
      if (process.env.OPEN_CONTEXT_DEBUG) console.error(`tree-sitter: parse error on ${filePath}:`, err);
      return null;
    }
    if (!tree) return null;
    let disposed = false;
    return {
      language,
      tree,
      dispose() {
        if (disposed) return;
        disposed = true;
        try { tree!.delete(); } catch {}
      },
    };
  }

  /** Release every cached Parser. Call on workspace teardown, not per-file. */
  disposeAll(): void {
    for (const p of this.parsers.values()) {
      try { p.delete(); } catch {}
    }
    this.parsers.clear();
  }
}
