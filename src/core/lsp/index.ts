/**
 * LSP-backed symbol lookup, anchored by the index.
 *
 * The store already knows which file declares a symbol and where its chunk
 * starts — that anchor is all an LSP server needs for a position-accurate
 * definition/references query, which is compiler-grade where the AST graph is
 * heuristic (name-shadowing, re-exports, dynamic patterns). Flow:
 *
 *   symbol → store anchor (file, line) → LSP definition/references →
 *   locations mapped back to workspace-relative paths.
 *
 * Clients are reused per (root, server command) and disposed on process exit.
 * Every failure mode (no server installed, spawn failure, timeout, method not
 * supported) resolves to null so callers fall back to the graph untouched.
 */
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { LspClient, LspError } from "./client";
import { resolveServerCommand } from "./servers";
import type { SqliteStore } from "../sqlite-store";

export interface SymbolHit { path: string; startLine: number; endLine: number }

export interface LspFinder {
  /** Definition locations for an exact symbol, workspace-relative. Null = LSP unavailable. */
  definition(symbol: string): Promise<SymbolHit[] | null>;
  /** Reference locations for an exact symbol, workspace-relative. Null = LSP unavailable. */
  references(symbol: string, limit?: number): Promise<SymbolHit[] | null>;
  dispose(): Promise<void>;
}

const clients = new Map<string, LspClient>();

async function getClient(rootAbs: string, ext: string, log?: (s: string) => void): Promise<LspClient | null> {
  const spec = resolveServerCommand(ext);
  if (!spec) return null;
  const key = serverKey(rootAbs, spec);
  const existing = clients.get(key);
  if (existing) return existing; // a dead client fails on the next request; callers treat that as "no LSP"
  try {
    const client = await LspClient.start({ command: spec.command, args: spec.args, cwd: rootAbs, rootPath: rootAbs, onLog: log });
    clients.set(key, client);
    return client;
  } catch (e) {
    log?.(`lsp: ${spec.command} unavailable: ${(e as Error).message}`);
    return null;
  }
}

function serverKey(rootAbs: string, spec: { command: string; args: string[] }): string {
  return `${rootAbs}|${spec.command} ${spec.args.join(" ")}`;
}

function toRelative(rootReal: string, uri: string): string | null {
  try {
    // fileURLToPath decodes percent-encoding (spaces in install paths) and
    // handles the /C:/ drive-slash form on Windows — URL.pathname does neither.
    const abs = fileURLToPath(uri);
    // realpath normalizes 8.3 short names and symlinks so both sides of the
    // relative() call spell the same directory the same way. A file the server
    // reports but the disk no longer has still counts — realpath its
    // directory and keep the basename.
    let real: string;
    try { real = fs.realpathSync.native(abs); }
    catch { real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); }
    const rel = path.relative(rootReal, real).replace(/\\/g, "/");
    return rel.startsWith("..") || rel === "" ? null : rel;
  } catch {
    return null;
  }
}

/** Line (0-based) and character of `symbol` inside its defining chunk. */
function anchorPosition(contents: string, symbol: string): { line: number; character: number } {
  const idx = contents.indexOf(symbol);
  const before = idx >= 0 ? contents.slice(0, idx) : "";
  return { line: Math.max(0, before.split("\n").length - 1), character: idx >= 0 ? before.length - (before.lastIndexOf("\n") + 1) : 0 };
}

export function createLspFinder(rootAbs: string, store: SqliteStore, log?: (s: string) => void): LspFinder {
  // Comparison base for toRelative: realpath'd, because servers echo URIs
  // through the OS (resolving 8.3 short names / symlinks) while rootAbs may
  // not be resolved — e.g. mkdtemp paths under %TEMP% on Windows.
  let rootReal = rootAbs;
  try { rootReal = fs.realpathSync.native(rootAbs); } catch { /* keep unresolved */ }
  const anchorFor = (symbol: string): { file: string; abs: string; pos: { line: number; character: number } } | null => {
    const chunks = store.getChunksBySymbol(symbol, 1);
    if (!chunks.length) return null;
    const chunk = chunks[0];
    const rel = chunk.path;
    const abs = path.resolve(rootAbs, rel);
    if (!fs.existsSync(abs)) return null;
    return { file: rel, abs, pos: anchorPosition(chunk.contents, symbol) };
  };

  const run = async (symbol: string, kind: "definition" | "references", limit: number): Promise<SymbolHit[] | null> => {
    const anchor = anchorFor(symbol);
    if (!anchor) return null;
    const ext = path.extname(anchor.file).toLowerCase();
    const spec = resolveServerCommand(ext);
    const client = spec ? await getClient(rootAbs, ext, log) : null;
    if (!client || !spec) return null;
    try {
      const locations = kind === "definition"
        ? await client.definition(anchor.abs, anchor.pos.line, anchor.pos.character)
        : await client.references(anchor.abs, anchor.pos.line, anchor.pos.character, true);
      const hits: SymbolHit[] = [];
      for (const loc of locations) {
        const rel = toRelative(rootReal, loc.uri);
        if (!rel) continue; // outside the workspace — not an indexed concept
        hits.push({ path: rel, startLine: loc.range.start.line + 1, endLine: loc.range.end.line + 1 });
        if (hits.length >= limit) break;
      }
      return hits;
    } catch (e) {
      // A dead or misbehaving server is a downgrade trigger, not an error.
      log?.(`lsp: ${kind} failed: ${(e as LspError).message}`);
      clients.delete(serverKey(rootAbs, spec));
      return null;
    }
  };

  return {
    definition: (symbol) => run(symbol, "definition", 20),
    references: (symbol, limit = 30) => run(symbol, "references", limit),
    dispose: async () => { /* clients are shared; disposal happens via disposeAllLspClients */ },
  };
}

export async function disposeAllLspClients(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.allSettled(all.map(c => c.dispose()));
}

process.on("exit", () => {
  for (const c of clients.values()) { try { c.dispose(); } catch { /* best-effort */ } }
});
