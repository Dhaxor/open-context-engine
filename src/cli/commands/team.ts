import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { OpenContext, defaultStorePath } from "../../core/context";
import { resolveConfig, staticEmbedder, requireTeamIndex } from "../config";
import { CliIo } from "../io";

export function registerTeamCommands(program: import("commander").Command, io: CliIo): void {
  const { text, info, progress } = io;

  program.command("push-index <dest>").description("Export the index as an artifact and publish it — Team feature. <dest> is a file path or HTTP(S) URL (PUT; presigned S3/GCS URLs work).")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("-p, --provider <provider>", "Embedding provider")
    .option("-m, --model <model>", "Embedding model")
    .option("--api-key <key>", "API key")
    .option("--store-path <path>", "Custom store directory")
    .option("--token <token>", "Bearer token for HTTP uploads (or OCE_INDEX_TOKEN)")
    .option("--no-index", "Export the store as-is without refreshing the index first")
    .option("--no-embed-cache", "Disable the shared embedding cache")
    .action(async (dest: string, opts: any) => {
      requireTeamIndex(io, "push-index");
      const refresh = opts.index !== false;
      const config = resolveConfig(opts, io, { requireCreds: refresh });
      if (!refresh) config.embedder = staticEmbedder(config.embedding);
      const { pushArtifact } = await import("../../core/index-artifact");
      const ctx = await OpenContext.create(config);
      try {
        if (refresh) {
          info("Refreshing index...");
          await ctx.incrementalIndex((s, c, t) => t > 0 && progress(`\r[${s}] ${c}/${t}   `));
          progress("\n");
        }
        if (!ctx.getChunkCount()) { io.fatal("Index is empty — run 'oce index' first."); }
        const isLocal = !/^https?:\/\//i.test(dest);
        const artifactFile = isLocal ? dest : path.join(os.tmpdir(), `oce-index-${Date.now()}.db.gz`);
        const manifest = await ctx.exportIndex(artifactFile);
        if (!isLocal) {
          progress(`Uploading to ${dest} ...\n`);
          await pushArtifact(artifactFile, dest, { token: opts.token || process.env.OCE_INDEX_TOKEN });
          await fs.promises.rm(artifactFile, { force: true });
        }
        const size = isLocal ? ` (${(fs.statSync(dest).size / 1e6).toFixed(1)} MB)` : "";
        text(`Published index artifact${size}: ${manifest.chunkCount} chunks, ${manifest.fileCount} files, ${manifest.embeddingModel} ${manifest.dimension}d${manifest.git?.commit ? `, commit ${manifest.git.commit.slice(0, 8)}` : ""}.`);
        text(`Teammates install it with: oce pull-index ${isLocal ? dest : "<url>"}`);
      } finally {
        ctx.close();
      }
    });

  program.command("pull-index <src>").description("Install a team index artifact, then re-index only your local changes — Team feature. <src> is a file path or HTTP(S) URL.")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("-p, --provider <provider>", "Embedding provider")
    .option("-m, --model <model>", "Embedding model")
    .option("--api-key <key>", "API key")
    .option("--store-path <path>", "Custom store directory")
    .option("--token <token>", "Bearer token for HTTP downloads (or OCE_INDEX_TOKEN)")
    .option("--no-reconcile", "Install the artifact without re-indexing local changes")
    .option("--no-embed-cache", "Disable the shared embedding cache")
    .action(async (src: string, opts: any) => {
      requireTeamIndex(io, "pull-index");
      const reconcile = opts.reconcile !== false;
      const config = resolveConfig(opts, io, { requireCreds: reconcile });
      const { pullArtifact, installArtifact } = await import("../../core/index-artifact");
      const storeDir = config.storePath || defaultStorePath(config.workspaceRoot);
      const isLocal = !/^https?:\/\//i.test(src);
      let artifactFile = src;
      if (!isLocal) {
        artifactFile = path.join(os.tmpdir(), `oce-index-pull-${Date.now()}.db.gz`);
        progress(`Downloading ${src} ...\n`);
        await pullArtifact(src, artifactFile, { token: opts.token || process.env.OCE_INDEX_TOKEN });
      }
      try {
        const manifest = await installArtifact(artifactFile, storeDir, {
          provider: config.embedding.provider,
          model: config.embedding.model,
          dimension: config.embedding.dimension,
        });
        text(`Installed team index: ${manifest.chunkCount} chunks, ${manifest.fileCount} files, built ${manifest.createdAt.slice(0, 19)}${manifest.git?.commit ? ` at commit ${manifest.git.commit.slice(0, 8)}` : ""}.`);
        if (reconcile) {
          const ctx = await OpenContext.create(config);
          try {
            progress("Reconciling local changes...\n");
            const r = await ctx.incrementalIndex((s, c, t) => t > 0 && progress(`\r[${s}] ${c}/${t}   `));
            progress("\n");
            text(`Reconciled: ${r.newlyIndexed.length} file(s) re-embedded locally, ${r.alreadyIndexed.length} reused from the artifact, ${r.removed.length} removed.`);
            if (r.failed?.length) { io.fail(`⚠ ${r.failed.length} file(s) failed to embed — retried on the next index. ${r.failedReason ?? ""}`); }
          } finally {
            ctx.close();
          }
        } else {
          text("Skipped reconciliation (--no-reconcile) — run 'oce index --incremental' to fold in local changes.");
        }
      } finally {
        if (!isLocal) await fs.promises.rm(artifactFile, { force: true });
      }
    });
}
