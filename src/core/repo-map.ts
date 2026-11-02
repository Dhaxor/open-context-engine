/**
 * Repo map — a budgeted symbol outline of the indexed workspace.
 *
 * Aider's killer feature, rebuilt on OCE's index: a compact structural map
 * (files → declared symbols with line ranges) that lets an LLM see a whole
 * codebase's shape in a few thousand tokens, so it can decide what to read
 * in full. Pairs with the class-header chunks and symbol graph the chunker
 * now produces.
 *
 * Selection: files are ranked by symbol count (structure density — a proxy
 * for how much a file defines vs merely uses), then alphabetical for
 * stability. Within a file, top-level symbols come first (parentSymbol unset
 * or a class header), and each line is trimmed to one sentence of context.
 * The map fills the budget greedily and stops.
 */
import { SqliteStore } from "./sqlite-store";
import { Chunk } from "./types";

export interface RepoMapOptions {
  /** Character budget for the whole map (default 4000). */
  maxChars?: number;
  /** Optional path prefix filter, same semantics as search. */
  pathPrefix?: string;
}

export interface RepoMapFile {
  path: string;
  symbols: { name: string; kind?: string; startLine: number; endLine: number }[];
}

const KIND_LABEL: Record<string, string> = {
  class: "class",
  function: "fn",
  method: "method",
  interface: "iface",
  type: "type",
  enum: "enum",
  struct: "struct",
  trait: "trait",
};

/** Build the map text. Returns "" when the index is empty. */
export function buildRepoMap(store: SqliteStore, opts: RepoMapOptions = {}): string {
  const maxChars = Math.max(200, opts.maxChars ?? 4000);
  const files = collectFiles(store, opts.pathPrefix);
  if (!files.length) return "";

  const HEADER = "Repository map (files → declared symbols; line ranges):";
  const out: string[] = [HEADER];
  let used = HEADER.length;
  const NL = String.fromCharCode(10);

  // Stream lines under the budget: the densest file comes first, and its
  // symbol block is capped to what fits — a single huge file must yield a
  // partial map, never an empty one.
  for (const f of files) {
    let fileStarted = false;
    for (const sym of f.symbols) {
      const label = KIND_LABEL[sym.kind ?? ""] ?? "sym";
      const head = fileStarted ? "  " : f.path + NL + "  ";
      const line = head + label + " " + sym.name + " (" + sym.startLine + "-" + sym.endLine + ")";
      if (used + line.length + 1 > maxChars) return out.join(NL);
      out.push(line);
      used += line.length + 1;
      fileStarted = true;
    }
  }
  return out.join(NL);
}

function isTestPath(p: string): boolean {
  return /(^|[\/])(tests?|__tests__)([\/]|$)|\.(test|spec)\.[a-z]+$|_test\.go$/i.test(p);
}

function collectFiles(store: SqliteStore, pathPrefix?: string): RepoMapFile[] {
  const paths = store.getIndexedPaths().filter(p => !pathPrefix || p.startsWith(pathPrefix));
  const out: RepoMapFile[] = [];
  for (const p of paths) {
    const chunks: Chunk[] = store.getChunksByPath(p, 400);
    // Declaration symbols only: chunks the chunker named (class headers,
    // functions, types) — deduped, since a class header and its first member
    // can share a name.
    const symbols: RepoMapFile["symbols"] = [];
    const seen = new Set<string>();
    for (const c of chunks) {
      if (!c.symbolName || seen.has(c.symbolName)) continue;
      seen.add(c.symbolName);
      symbols.push({ name: c.symbolName, kind: c.symbolKind, startLine: c.startLine, endLine: c.endLine });
    }
    if (symbols.length) out.push({ path: p, symbols });
  }
  // Structure density ranks files first, with a demotion for test files —
  // tests declare many tiny functions and would otherwise crowd out the
  // source they cover (aider does the same). Alphabetical tiebreak keeps the
  // map stable across identical re-indexes.
  const rank = (f: RepoMapFile) => f.symbols.length * (isTestPath(f.path) ? 0.2 : 1);
  out.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path));
  return out;
}
