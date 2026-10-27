#!/usr/bin/env node
/**
 * Generates web/benchmarks.html from the committed eval reports, so the
 * public numbers can never drift from the ones the harness actually measured.
 * Run by `npm run build:web` (chained into `npm run deploy`).
 *
 * Each entry: report = path to a saved `oce eval --out` report. The page
 * renders recall@10 / MRR / nDCG@10 / hit-rate / ctx-recall + latency and the
 * metadata that makes a number honest (search mode, model, case count, date).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** What appears on the page, in order. `label` is prose; `model`/`mode` come
 *  from the report itself so a stale label can't lie. */
const ENTRIES = [
  { group: "Open Context Engine's own gold set (44 cases)", items: [
    { label: "keyword-only (BM25)", report: "eval/baseline.keyword.json" },
    { label: "hybrid — voyage-code-3, equal-weight fusion", report: "eval/baseline.json" },
    { label: "hybrid — local MiniLM, adaptive fusion", report: "eval/minilm.baseline.json" },
  ]},
  { group: "Flask 3.1.2 — a codebase OCE had never seen (27 cases)", items: [
    { label: "keyword-only (BM25)", report: "eval/external/flask.baseline.json" },
    { label: "hybrid — voyage-code-3, equal-weight fusion", report: "eval/external/flask.hybrid.baseline.json" },
    { label: "hybrid — local MiniLM, adaptive fusion", report: "eval/external/flask.minilm.baseline.json" },
  ]},
];

const fmt = (n) => (n === undefined || n === null || Number.isNaN(n) ? "—" : n.toFixed(3));

function row(e) {
  const r = JSON.parse(fs.readFileSync(path.join(root, e.report), "utf8"));
  const a = r.aggregate;
  const when = (r.generatedAt || "").slice(0, 10);
  const mode = r.searchMode === "keyword-only" ? "keyword-only" : "hybrid";
  return `      <tr>
        <td class="lbl">${e.label}</td>
        <td>${mode}</td>
        <td>${r.caseCount}</td>
        <td class="num">${fmt(a.recallAtK)}</td>
        <td class="num">${fmt(a.mrr)}</td>
        <td class="num">${fmt(a.ndcgAtK)}</td>
        <td class="num">${fmt(a.hitRate)}</td>
        <td class="num">${fmt(a.contextRecall)}</td>
        <td class="num">${Math.round(r.meanLatencyMs)}&#8239;ms</td>
        <td class="dim">${when}</td>
      </tr>`;
}

const sections = ENTRIES.map(({ group, items }) => `    <h3>${group}</h3>
    <div class="table-wrap">
    <table class="bench">
      <thead><tr><th>configuration</th><th>mode</th><th>cases</th><th class="num">recall@10</th><th class="num">MRR</th><th class="num">nDCG@10</th><th class="num">hit-rate</th><th class="num">ctx-recall</th><th class="num">latency</th><th class="dim">measured</th></tr></thead>
${items.map(row).join("\n")}
    </table>
    </div>`).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchmarks — Open Context Engine</title>
<meta name="description" content="Measured retrieval quality on committed gold sets: recall@10, MRR, nDCG in keyword-only and hybrid modes, generated from the eval harness's own reports.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="oce.css?v=0.4.0">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230A0D12'/><text x='7' y='22' font-family='monospace' font-size='16' fill='%2345C4E9'>›</text><rect x='17' y='9' width='7' height='14' fill='%23E8EDF4'/></svg>">
<style>
  .bench { border-collapse: collapse; width: 100%; font-size: 14px; }
  .bench th, .bench td { padding: 8px 10px; border-bottom: 1px solid var(--line, #1d2430); text-align: left; }
  .bench thead th { font-family: var(--mono, 'IBM Plex Mono', monospace); font-size: 12px; letter-spacing: .04em; text-transform: uppercase; opacity: .7; }
  .bench td.num { font-family: var(--mono, 'IBM Plex Mono', monospace); text-align: right; }
  .bench td.lbl { font-weight: 500; }
  .bench td.dim { opacity: .55; font-size: 12px; }
  .table-wrap { overflow-x: auto; }
  h3 { margin: 28px 0 10px; }
  .note { opacity: .75; font-size: 14px; max-width: 72ch; }
</style>
</head>
<body>

<header class="nav">
  <div class="wrap nav-inner">
    <a href="/" class="wordmark" aria-label="Open Context Engine home">oce<span class="caret">▍</span></a>
    <nav class="nav-links" aria-label="Main">
      <a href="/#retrieval">Product</a>
      <a href="docs.html" class="optional">Docs</a>
      <a href="pricing.html">Pricing</a>
      <a href="https://github.com/Dhaxor/open-context-engine" class="optional">GitHub</a>
    </nav>
    <button class="install-chip" data-copy="npm install -g @dhaxor/open-context" aria-label="Copy install command">
      npm i -g @dhaxor/open-context <span class="ic-copy">⧉</span>
    </button>
  </div>
</header>

<main>
  <section class="hero wrap" style="padding-bottom: 0;">
    <div class="chunk">eval/*.baseline.json <span class="score">1.00</span></div>
    <h1 style="font-size: var(--t-h1);">Measured, not guessed</h1>
    <p class="sub">This page is <em>generated</em> from the evaluation harness's own committed reports — the same JSON <code>oce eval</code> writes and compares baselines against. If a number here is stale, so is the repo. Re-run any configuration yourself; the gold sets and baselines ship in the <a href="https://github.com/Dhaxor/open-context-engine/tree/main/eval">eval/</a> directory.</p>
  </section>

  <section class="wrap" style="padding-top: 8px;">
${sections}

    <h3>How to read this</h3>
    <p class="note"><strong>keyword-only</strong> runs use BM25 alone (no embedding key, no vectors). <strong>hybrid</strong> fuses BM25 with vector similarity; since Oct 2026 the fusion weights adapt to query shape (definition-shaped queries lean BM25, paraphrases lean semantic) — the voyage rows above predate that change and are kept as the equal-weight reference. <strong>ctx-recall</strong> checks whether the gold file made it into the packed context an LLM actually receives. Gold sets are file-granular: a case passes when the gold file ranks in the top-10 unique files. Flask is an external, never-seen codebase — the honest test of a ranking change.</p>
  </section>
</main>

<footer>
  <div class="wrap foot">
    <div>
      <span class="wordmark">oce<span class="caret">▍</span></span>
      <p class="legal" style="margin-top: 12px;">Open Context Engine · MIT core<br>No telemetry. No code leaves your machine.</p>
    </div>
    <div class="cols">
      <div><span class="col-h">product</span>
        <a href="/#retrieval">Retrieval</a>
        <a href="/#agent">Agent</a>
        <a href="/#local">Local-first</a>
      </div>
      <div><span class="col-h">develop</span>
        <a href="https://github.com/Dhaxor/open-context-engine">GitHub</a>
        <a href="https://www.npmjs.com/package/@dhaxor/open-context">npm</a>
        <a href="docs.html">Docs</a>
      </div>
      <div><span class="col-h">contact</span>
        <a href="mailto:hello@opencontextengine.com">hello@opencontextengine.com</a>
      </div>
    </div>
  </div>
</footer>

<script src="site.js" defer></script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, "web", "benchmarks.html"), html);
console.log(`wrote web/benchmarks.html (${ENTRIES.flatMap(g => g.items).length} configurations)`);
