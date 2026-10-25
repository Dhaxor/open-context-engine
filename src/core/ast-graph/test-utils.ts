import { afterAll, beforeAll } from "vitest";
import { ParserPool } from "../ast-graph-shared";
import { extractEdgesFromTree } from "../ast-graph-extractor";
import type { GraphEdge } from "../code-graph";
import type { File } from "../types";
import type { ExtractionResult } from "./shared";

let pool: ParserPool;
beforeAll(() => { pool = new ParserPool(); });
afterAll(() => { pool.disposeAll(); });

export async function extract(file: File): Promise<ExtractionResult> {
  const parsed = await pool.parseFile(file.path, file.contents);
  if (!parsed) throw new Error(`pool.parseFile returned null for ${file.path}`);
  try { return extractEdgesFromTree(file, parsed.language, parsed.tree); }
  finally { parsed.dispose(); }
}

export function edgesOfKind(edges: GraphEdge[], kind: GraphEdge["kind"]): GraphEdge[] {
  return edges.filter(e => e.kind === kind);
}
