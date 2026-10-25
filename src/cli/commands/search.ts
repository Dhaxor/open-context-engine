import { OpenContext } from "../../core/context";
import { resolveConfig, withStoreOptions } from "../config";
import { CliIo } from "../io";

export function registerSearchCommands(program: import("commander").Command, io: CliIo): void {
  const { text, json, progress } = io;

  withStoreOptions(program.command("search <query>").description("Search codebase").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Provider").option("-m, --model <model>", "Model").option("--api-key <key>", "API key").option("-k, --top-k <n>", "Max results").option("--json", "Emit results as JSON (path, lines, score, snippet)")).action(async (query, opts) => {
    const ctx = await OpenContext.create(resolveConfig(opts, io));
    try {
      if (opts.json) {
        const results = await ctx.searchRaw(query, opts.topK ? Number(opts.topK) : undefined);
        json(results.map(r => ({
          path: r.chunk.path,
          startLine: r.chunk.startLine,
          endLine: r.chunk.endLine,
          score: r.score,
          vectorScore: r.vectorScore,
          rerankScore: r.rerankScore,
          symbol: r.chunk.symbolName,
          snippet: r.chunk.contents.slice(0, 400),
        })));
      } else {
        text(await ctx.search(query));
      }
    } finally {
      ctx.close();
    }
  });

  program.command("multi-search <query>").description("Search across multiple repositories at once (Team license required)")
    .option("--repos <paths>", "Comma-separated repo paths to search")
    .option("-p, --provider <provider>", "Embedding provider")
    .option("-m, --model <model>", "Embedding model")
    .option("--api-key <key>", "API key")
    .option("-k, --top-k <n>", "Max results", "15")
    .option("--no-index", "Skip indexing; query the existing per-repo indexes")
    .action(async (query: string, opts: any) => {
      const { loadEnterpriseEdition, getLicense } = await import("../../core/license");
      const ee = await loadEnterpriseEdition(getLicense());
      if (!ee) {
        io.fatal("Multi-repo search is a Team feature. Activate a license with 'oce activate <key>' (check 'oce license').");
      }
      const repoPaths = String(opts.repos || "").split(",").map((s: string) => s.trim()).filter(Boolean);
      if (!repoPaths.length) { io.fatal("Specify repos with --repos <path1,path2,...>."); }
      const base = resolveConfig(opts, io);
      const mr = await ee.createMultiRepoContext({ repos: repoPaths.map((p: string) => ({ path: p })), base });
      if (opts.index !== false) {
        progress(`Indexing ${mr.repoNames().length} repo(s): ${mr.repoNames().join(", ")} ...\n`);
        const counts = await mr.indexAll((repo: string, s: string, c: number, t: number) => t > 0 && progress(`\r[${repo}] ${s} ${c}/${t}     `));
        progress("\n" + counts.map((c: any) => `${c.repo}: ${c.chunks} chunks`).join(" | ") + "\n\n");
      }
      text(await mr.searchFormatted(query, Number(opts.topK)));
      mr.close();
    });

  program.command("eval").description("Score retrieval quality against a labeled query set (recall@k, MRR, nDCG)")
    .requiredOption("--cases <file>", "JSON file of eval cases: [{ id, query, expectedPaths: [..] }]")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("-p, --provider <provider>", "Embedding provider")
    .option("-m, --model <model>", "Embedding model")
    .option("--api-key <key>", "API key")
    .option("-k, --top-k <n>", "Metric cutoff: gold files must rank in the top k unique files", "10")
    .option("--retrieve-k <n>", "Chunks requested per query before files are deduped (default 3x top-k)")
    .option("--no-expand", "Disable symbol/graph expansion — measures what expansion contributes")
    .option("--no-packed", "Skip the packed-context check (one extra search per case)")
    .option("--no-index", "Skip the incremental index before evaluating (use the index as-is)")
    .option("--out <file>", "Write the full report JSON to this file")
    .option("--baseline <file>", "Compare against a previously saved report and print deltas")
    .option("--json", "Print the report as JSON to stdout (suppresses the table)")
    .action(async (opts: any) => {
      const fs = await import("fs");
      const diag = io.diagnosticsFor(opts);
      const { runEval, parseEvalCases, compareReports } = await import("../../eval/runner");
      const cases = parseEvalCases(JSON.parse(await fs.promises.readFile(opts.cases, "utf8")));
      const k = Math.max(1, Number(opts.topK));
      const retrieveK = opts.retrieveK ? Math.max(k, Number(opts.retrieveK)) : k * 3;
      const ctx = await OpenContext.create(resolveConfig(opts, io));
      try {
        if (opts.index !== false) {
          diag.info("Refreshing index...");
          await ctx.incrementalIndex((s, c, t) => t > 0 && diag.progress(`\r[${s}] ${c}/${t}   `));
          diag.progress("\n");
        }
        if (!ctx.getChunkCount()) {
          io.fatal("Index is empty — run 'oce index' first or drop --no-index.");
        }
        const expand = opts.expand !== false;
        const report = await runEval(
          (query) => ctx.searchRaw(query, retrieveK, { expandSymbols: expand }),
          cases,
          {
            k,
            // The packed check runs the REAL search() pipeline (default topK +
            // packing budget) — gold presence in it is what the LLM actually sees.
            packedSearch: opts.packed !== false ? (query) => ctx.search(query, undefined, { expandSymbols: expand }) : undefined,
            onCase: (r, i, total) => {
              if (opts.json) return;
              const mark = r.error ? "✗ ERR" : r.metrics.hit ? `✓ @${r.metrics.firstHitRank}` : "✗ miss";
              const ctxMark = r.metrics.contextRecall === undefined ? "" : ` ctx=${r.metrics.contextRecall > 0 ? "✓" : "✗"}`;
              text(`[${String(i + 1).padStart(2)}/${total}] ${mark.padEnd(7)} ndcg=${r.metrics.ndcg.toFixed(3)}${ctxMark} ${r.id}${r.error ? ` (${r.error})` : ""}`);
            },
          },
        );
        const mode = ctx.getStatus().searchMode;
        report.searchMode = mode; // persisted into --out/--json so saved baselines carry their mode
        if (opts.out) await fs.promises.writeFile(opts.out, JSON.stringify(report, null, 2));
        if (opts.json) { json(report); return; }
        const a = report.aggregate;
        text(`\nk=${k} retrieveK=${retrieveK} expand=${expand} | cases: ${a.cases}${mode === "keyword-only" ? " | ⚠ KEYWORD-ONLY MODE — not comparable to hybrid baselines" : ""}`);
        const ctxLine = a.contextRecall !== undefined ? `  ctx-recall=${a.contextRecall.toFixed(3)}  ctx-hit-rate=${(a.contextHitRate ?? 0).toFixed(3)}` : "";
        text(`recall@k=${a.recallAtK.toFixed(3)}  MRR=${a.mrr.toFixed(3)}  nDCG@k=${a.ndcgAtK.toFixed(3)}  hit-rate=${a.hitRate.toFixed(3)}${ctxLine}  mean-latency=${report.meanLatencyMs.toFixed(0)}ms`);
        const misses = report.results.filter(r => !r.metrics.hit);
        if (misses.length) {
          text(`\nMisses (${misses.length}):`);
          for (const m of misses) text(`  ${m.id}: expected ${m.expectedPaths.join(", ")} — got [${m.retrievedFiles.slice(0, 3).join(", ")}${m.retrievedFiles.length > 3 ? ", …" : ""}]`);
        }
        if (opts.baseline) {
          const baseline = JSON.parse(await fs.promises.readFile(opts.baseline, "utf8"));
          if (baseline.searchMode && baseline.searchMode !== mode) {
            text(`\n⚠ baseline was ${baseline.searchMode}, this run is ${mode} — deltas reflect the mode change, not retrieval quality.`);
          } else if (!baseline.searchMode && mode === "keyword-only") {
            text(`\n⚠ baseline has no search-mode marker (likely hybrid); this run is keyword-only — deltas are not meaningful.`);
          }
          const cmp = compareReports(baseline, report);
          const sign = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
          const ctxDelta = cmp.aggregate.contextRecall !== undefined ? ` Δctx-recall=${sign(cmp.aggregate.contextRecall)} Δctx-hit=${sign(cmp.aggregate.contextHitRate ?? 0)}` : "";
          text(`\nvs baseline (${cmp.perCase.length} shared cases): ΔnDCG=${sign(cmp.aggregate.ndcgAtK)} ΔMRR=${sign(cmp.aggregate.mrr)} Δrecall=${sign(cmp.aggregate.recallAtK)} Δhit-rate=${sign(cmp.aggregate.hitRate)}${ctxDelta}`);
          text(`improved: ${cmp.improved}  regressed: ${cmp.regressed}  unchanged: ${cmp.unchanged}`);
          for (const d of cmp.perCase.filter(d => d.direction === "regressed")) text(`  ▼ ${d.id} ΔnDCG=${sign(d.ndcg)}`);
          if (cmp.onlyInBaseline.length || cmp.onlyInCurrent.length) {
            text(`(cases only in baseline: ${cmp.onlyInBaseline.length}; only in current: ${cmp.onlyInCurrent.length} — excluded from deltas)`);
          }
        }
      } finally {
        ctx.close();
      }
    });

  program.command("bench").description("Benchmark indexing throughput on this workspace (parse/chunk pipeline; no API calls)")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--workers <n>", "Worker count for the parallel pass (default: auto)")
    .option("--json", "Print results as JSON")
    .action(async (opts: any) => {
      const diag = io.diagnosticsFor(opts);
      const { FileFilter } = await import("../../core/file-filter");
      const { AstChunker } = await import("../../core/ast-chunker");
      const { CodeChunker } = await import("../../core/chunker");
      const { extractEdges } = await import("../../core/graph-extractor");
      const { ChunkWorkerPool, defaultPoolSize } = await import("../../core/chunk-pool");

      const filter = new FileFilter();
      diag.info("Collecting files...");
      const files = await filter.collectFiles(opts.workspace);
      const totalBytes = files.reduce((s, f) => s + f.contents.length, 0);

      const maxChunkChars = 80_000;
      const runInline = async () => {
        const chunker = new AstChunker({ maxChunkChars, fallback: new CodeChunker(undefined, undefined, maxChunkChars) });
        const start = Date.now();
        let chunkCount = 0, edgeCount = 0;
        for (const file of files) {
          const parsed = await chunker.parseFile(file);
          try {
            chunkCount += (await chunker.chunkFile(file, { parsed })).length;
            const lang = AstChunker.languageFor(file.path);
            if (lang) { try { edgeCount += extractEdges(file, lang, parsed?.tree ?? null).edges.length; } catch {} }
          } finally { parsed?.dispose(); }
        }
        const ms = Date.now() - start;
        chunker.dispose();
        return { ms, chunkCount, edgeCount };
      };

      diag.info(`Chunking ${files.length} files (${(totalBytes / 1e6).toFixed(1)} MB) in-process...`);
      const inline = await runInline();

      let pooled: { ms: number; chunkCount: number; edgeCount: number; workers: number } | null = null;
      if (ChunkWorkerPool.isAvailable()) {
        const workers = opts.workers ? Math.max(1, Number(opts.workers)) : defaultPoolSize();
        diag.info(`Chunking again with ${workers} worker thread(s)...`);
        const pool = new ChunkWorkerPool({ maxChunkChars, size: workers });
        const start = Date.now();
        const results = await pool.run(files);
        const ms = Date.now() - start;
        await pool.destroy();
        pooled = {
          ms,
          chunkCount: results.reduce((s, r) => s + r.chunks.length, 0),
          edgeCount: results.reduce((s, r) => s + r.edges.length, 0),
          workers,
        };
      } else {
        diag.warn("(worker pool unavailable — dist/core/chunk-worker.js not built; run 'npm run build')");
      }

      const report = {
        files: files.length,
        megabytes: +(totalBytes / 1e6).toFixed(2),
        inline: { ms: inline.ms, filesPerSec: +(files.length / (inline.ms / 1000)).toFixed(1), chunks: inline.chunkCount, edges: inline.edgeCount },
        ...(pooled ? {
          workers: {
            count: pooled.workers, ms: pooled.ms,
            filesPerSec: +(files.length / (pooled.ms / 1000)).toFixed(1),
            speedup: +(inline.ms / pooled.ms).toFixed(2),
          },
        } : {}),
      };
      if (opts.json) { json(report); return; }
      text(`\nfiles: ${report.files}  size: ${report.megabytes} MB`);
      text(`in-process: ${inline.ms}ms  (${report.inline.filesPerSec} files/s, ${inline.chunkCount} chunks, ${inline.edgeCount} edges)`);
      if (pooled) text(`workers x${pooled.workers}: ${pooled.ms}ms  (${report.workers!.filesPerSec} files/s, speedup ${report.workers!.speedup}x)`);
    });
}
