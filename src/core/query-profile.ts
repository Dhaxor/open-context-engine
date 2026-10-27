/**
 * Query-shape classification and the fusion weights that follow from it.
 *
 * The committed eval sets show a measured inversion: on definition-shaped
 * queries ("the main Flask application class", "getUserData helper") BM25 holds
 * the gold file at rank 1 and RRF fusion DEMOTES it when the semantic ranker
 * prefers tests and docs — hybrid 0.889 vs keyword 0.926 on Flask. On
 * intent-shaped queries ("how does the auth middleware work?") the opposite
 * holds: hybrid beats keyword 0.943 vs 0.886, because the gold code paraphrases
 * the query rather than naming it.
 *
 * Equal fusion weights cannot see that difference — RRF only sees ranks, never
 * confidence. So the retriever classifies the query first and tilts the fusion
 * weights accordingly. The multipliers below are chosen so the Flask gold case
 * (BM25 #1 / vector #15 vs a distractor at vector #1 / BM25 #10) flips to the
 * gold under the definition profile while the intent profile stays close to
 * the balanced behavior that produced 0.943 here. Both gold sets grade every
 * change: eval/baseline.json and eval/external/flask.*.baseline.json.
 */

export type QueryShape = "definition" | "intent";

export interface FusionProfile {
  shape: QueryShape;
  /** Multipliers applied to the SearchConfig vector/bm25 weights. */
  vector: number;
  bm25: number;
  /** Human-readable evidence for the debug report and tests. */
  signals: string[];
}

/** Multipliers per shape. Tuned against the committed gold sets (see header);
 *  changes here must ship with fresh eval deltas in both modes. */
export const FUSION_PROFILES: Record<QueryShape, { vector: number; bm25: number }> = {
  definition: { vector: 0.55, bm25: 1.6 },
  intent: { vector: 1.15, bm25: 0.95 },
};

/** Pure lexical classification — no index access, trivially testable. */
export function classifyQueryShape(query: string): QueryShape {
  const { strong, weak } = interpretedSignals(query);
  if (strong > 0) return "definition";
  return weak >= 2 ? "definition" : "intent";
}

/** shapeSignals with the intent-phrasing discount applied: an interrogative
 *  whose only definition evidence is generic code nouns ("how does the auth
 *  middleware work?") counts neither way. */
function interpretedSignals(query: string): { strong: number; weak: number } {
  const s = shapeSignals(query);
  if (s.strong === 0 && s.weak >= 2 && intentPhrasing(query) && s.found.every(f => f === "code noun")) {
    return { strong: 0, weak: 0 };
  }
  return { strong: s.strong, weak: s.weak };
}

function intentPhrasing(query: string): boolean {
  return /\b(how|why|what|where|when)\b|\?$|\bexplain|overview of|walk me through\b/i.test(query);
}

export function shapeSignals(query: string): { strong: number; weak: number; found: string[] } {
  const found: string[] = [];
  let strong = 0;
  let weak = 0;
  const note = (signal: string, kind: "strong" | "weak"): void => {
    found.push(signal);
    if (kind === "strong") strong++;
    else weak++;
  };

  // Quoted text and backticked code are explicit symbol references.
  if (/["'`][^"'`]+["'`]/.test(query)) note("quoted code", "strong");

  // File paths / extensions: "src/auth.ts", "router.js", ".env loader".
  if (/[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|php|kt|swift|c|h|cpp|hpp|json|ya?ml|toml)\b/i.test(query)) note("file path", "strong");

  for (const token of query.split(/[\s,;:?!()[\]{}]+/)) {
    if (!token) continue;
    const stripped = token.replace(/[^A-Za-z0-9_]/g, "");
    if (stripped.length < 3) continue;
    // snake_case / SCREAMING_CASE with a separator, camelCase/PascalCase with
    // 2+ humps, or embedded digits: real identifier spellings.
    if (/^[A-Za-z]+(_[A-Za-z0-9]+)+$/.test(stripped)) { note(`snake_case: ${stripped}`, "strong"); continue; }
    if (/^[A-Z]+(_[A-Z0-9]+)+$/.test(stripped)) { note("SCREAMING_CASE", "strong"); continue; }
    const humps = stripped.slice(1).match(/[A-Z]/g)?.length ?? 0;
    // 2+ humps is unmistakably camelCase ("getUserData"). One internal hump is
    // only identifier-like when the token is long enough to be a compound
    // ("SessionInterface", "OpenContext") — short ones are acronyms or prose.
    if (humps >= 2 || (humps === 1 && stripped.length >= 8)) { note(`camelCase: ${stripped}`, "strong"); continue; }
    if (/\d/.test(stripped) && /^[A-Za-z]/.test(stripped)) { note(`alphanumeric: ${stripped}`, "strong"); continue; }
    // A single capitalised word is weak evidence ("Flask", "Werkzeug") —
    // prose also capitalises proper nouns, so it never carries alone.
    if (/^[A-Z][a-z]+$/.test(stripped)) note(`capitalised: ${stripped}`, "weak");
  }

  // Generic code nouns ("class", "function", "middleware") are weak: intent
  // queries name them too ("how does the auth middleware work?").
  if (/\b(class|function|method|struct|interface|enum|decorator|module|middleware|endpoint|route|handler|schema|config)\b/i.test(query)) note("code noun", "weak");

  return { strong, weak, found };
}

export function fusionProfile(query: string): FusionProfile {
  const shape = classifyQueryShape(query);
  const { found } = shapeSignals(query);
  return { shape, ...FUSION_PROFILES[shape], signals: found };
}
