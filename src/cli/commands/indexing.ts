import * as path from "path";
import { OpenContext, defaultStorePath } from "../../core/context";
import { resolveConfig, withStoreOptions, staticEmbedder } from "../config";
import { CliIo } from "../io";
import { keywordOnlyWarning } from "../session";

export function registerIndexingCommands(program: import("commander").Command, io: CliIo): void {
  const { text, json, progress, error } = io;

  withStoreOptions(program.command("index").description("Index workspace").option("-w, --workspace <path>", "Workspace root", process.cwd()).option("-p, --provider <provider>", "Embedding provider").option("-m, --model <model>", "Embedding model").option("--api-key <key>", "API key").option("--incremental", "Incremental").option("--no-embed-cache", "Disable the shared embedding cache")).action(async (opts) => {
    const ctx = await OpenContext.create(resolveConfig(opts, io));
    try {
      text("Indexing..."); const r = opts.incremental ? await ctx.incrementalIndex((s,c,t) => t > 0 && progress(`\r[${s}] ${c}/${t}`)) : await ctx.indexWorkspace((s,c,t) => t > 0 && progress(`\r[${s}] ${c}/${t}`));
      text(`\nDone in ${r.duration}ms | New: ${r.newlyIndexed.length} | Existing: ${r.alreadyIndexed.length} | Removed: ${r.removed.length} | Chunks: ${ctx.getChunkCount()}`);
      const degraded = keywordOnlyWarning(ctx.getStatus());
      if (degraded) error(degraded);
      if (r.failed?.length) {
        error(`\n⚠ ${r.failed.length} file(s) failed to embed and will be retried on the next index run.`);
        if (r.failedReason) error(`  Reason: ${r.failedReason}`);
        process.exitCode = 1;
      }
    } finally {
      // Release the store before exit: process teardown would too, but an
      // open handle also locks the db against `oce clean` on Windows and
      // keeps WAL files on disk.
      ctx.close();
    }
  });

  withStoreOptions(program.command("watch").description("Index the workspace and keep it live as files change").option("-w, --workspace <path>", "Workspace", process.cwd()).option("-p, --provider <provider>", "Embedding provider").option("-m, --model <model>", "Embedding model").option("--api-key <key>", "API key").option("--no-embed-cache", "Disable the shared embedding cache")).action(async (opts) => {
    const config = resolveConfig(opts, io);
    const { createLiveContext } = await import("../../core/live-index");
    text(`Indexing ${config.workspaceRoot} ...`);
    const handle = await createLiveContext(config, {
      onProgress: (s, c, t) => t > 0 && progress(`\r[${s}] ${c}/${t}   `),
      onReindex: (r) => text(`\n[reindex] +${r.newlyIndexed.length} new, ${r.removed.length} removed (${r.duration}ms) | ${handle.context.getChunkCount()} chunks${r.failed?.length ? ` | ⚠ ${r.failed.length} failed (will retry)` : ""}`),
      onError: (e) => error(`\n[watch error] ${e.message}`),
    });
    const degraded = keywordOnlyWarning(handle.context.getStatus());
    if (degraded) error(degraded);
    text(`\nWatching for changes — ${handle.context.getChunkCount()} chunks indexed. Press Ctrl+C to stop.`);
    const stop = async () => { await handle.stop(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

  program.command("status").description("Show index health: store, chunks, files, search mode, policy, license")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--store-path <path>", "Custom store directory")
    .option("--json", "Emit as JSON")
    .action(async (opts: any) => {
      const fs = await import("fs");
      const config = resolveConfig(opts, io, { requireCreds: false });
      config.embedder = staticEmbedder(config.embedding);
      // `status` reports; it must never rebuild. Without this, running it without
      // naming the provider the index was built with silently wipes the index —
      // a read-only-sounding command destroying the thing it was asked about.
      config.readOnly = true;
      const storeDir = config.storePath || defaultStorePath(config.workspaceRoot);
      const dbPath = path.join(storeDir, "context.db");
      const ctx = await OpenContext.create(config);
      try {
        const status = ctx.getStatus();
        const policy = ctx.getPolicy();
        const { getLicense } = await import("../../core/license");
        const license = getLicense();
        let dbSizeBytes = 0;
        try { dbSizeBytes = fs.statSync(dbPath).size; } catch {}
        const report = {
          workspace: config.workspaceRoot,
          store: { dir: storeDir, dbSizeBytes },
          index: {
            chunks: ctx.getChunkCount(),
            searchMode: status.searchMode,
            ...(status.degradedReason ? { degradedReason: status.degradedReason } : {}),
            ...(status.staleReason ? { staleReason: status.staleReason } : {}),
          },
          embedding: { provider: config.embedding.provider, model: config.embedding.model, dimension: config.embedding.dimension },
          policy: policy ? { sources: policy.sources, locked: policy.locked, summary: (await import("../../core/policy")).describePolicy(policy) } : null,
          license: { plan: license.plan, valid: license.valid, ...(license.payload?.org ? { org: license.payload.org } : {}) },
        };
        if (opts.json) { json(report); return; }
        text(`workspace  ${report.workspace}`);
        text(`store      ${storeDir} (${(dbSizeBytes / 1e6).toFixed(1)} MB)`);
        const mode = status.degradedKind === "keyword_only"
          ? "keyword search — no embedding provider (run 'oce setup' for semantic)"
          : `${report.index.searchMode}${status.degradedReason ? ` (${status.degradedReason})` : ""}`;
        text(`index      ${report.index.chunks.toLocaleString()} chunks · ${mode}`);
        if (status.staleReason) {
          text(`⚠ stale    ${status.staleReason} — run 'oce index' to rebuild.`);
        }
        text(`embedding  ${report.embedding.provider}/${report.embedding.model} (${report.embedding.dimension}d)`);
        text(`policy     ${report.policy ? report.policy.summary : "(disabled)"}`);
        text(`license    ${report.license.plan}${report.license.org ? ` (${report.license.org})` : ""}`);
      } finally {
        ctx.close();
      }
    });

  program.command("clean").description("Delete the workspace's index store (sessions, memories, and audit logs are kept)")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--store-path <path>", "Custom store directory")
    .option("--yes", "Confirm deletion (required)")
    .action(async (opts: any) => {
      const fs = await import("fs");
      const storeDir = opts.storePath || defaultStorePath(opts.workspace);
      const dbPath = path.join(storeDir, "context.db");
      if (!fs.existsSync(dbPath)) { text(`No index database at ${dbPath}.`); return; }
      if (!opts.yes) {
        io.fatal(`This deletes the index database at ${dbPath} (a re-index rebuilds it). Re-run with --yes to confirm.`);
      }
      let removed = 0;
      for (const suffix of ["", "-wal", "-shm", ".pre-pull"]) {
        try { fs.unlinkSync(dbPath + suffix); removed++; } catch {}
      }
      text(`Removed ${removed} file(s) from ${storeDir}. Run 'oce index' to rebuild.`);
    });
}
