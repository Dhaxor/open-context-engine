import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { pipeline } from "stream/promises";

/**
 * Team index sync — index artifacts.
 *
 * An artifact is the store database itself (a complete SQLite file with
 * vectors, FTS, graph, and file hashes) gzipped, with a manifest stamped into
 * its `meta` table under `artifact_*` keys. Build the index once — in CI or
 * on a lead's machine — publish the artifact anywhere (S3 presigned URL,
 * artifact registry, a shared drive), and teammates pull it instead of paying
 * to re-embed the whole repo. After a pull, a normal incremental index
 * reconciles the local working-tree diff: the file-hash table rode along in
 * the artifact, so only files that differ from the artifact get re-embedded.
 *
 * This module is transport-thin on purpose: local paths and HTTP(S) GET/PUT
 * (which covers presigned S3/GCS URLs) — your CI's artifact store does the
 * heavy lifting. No OCE cloud service is involved; the privacy story is
 * "code goes only to storage YOU control".
 */

export interface IndexArtifactManifest {
  formatVersion: 1;
  createdAt: string;
  embeddingProvider: string;
  embeddingModel: string;
  dimension: number;
  chunkCount: number;
  fileCount: number;
  git?: { branch?: string; commit?: string };
}

export interface TransportOptions {
  /** Bearer token attached to HTTP(S) requests. */
  token?: string;
  /** Request timeout in ms. Default 60s. */
  timeoutMs?: number;
}

const MANIFEST_KEY = "artifact_manifest";

function isHttpUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/** gzip src → dest (streaming; index DBs can be hundreds of MB). */
async function gzipFile(src: string, dest: string): Promise<void> {
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(dest));
}

async function gunzipFile(src: string, dest: string): Promise<void> {
  await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest));
}

/** Read the manifest out of a (plain, un-gzipped) artifact database. */
export async function readArtifactManifest(dbFile: string): Promise<IndexArtifactManifest> {
  const { loadBetterSqlite3 } = await import("./sqlite-store");
  const Database = await loadBetterSqlite3();
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(MANIFEST_KEY) as { value: string } | undefined;
    if (!row) throw new Error("Not an index artifact: no manifest found (was it produced by 'oce push-index'?)");
    return JSON.parse(row.value) as IndexArtifactManifest;
  } finally {
    db.close();
  }
}

/**
 * Package a store snapshot (produced by SqliteStore.backupTo) into a gzipped
 * artifact file. The manifest must already be stamped into the snapshot's
 * meta table — OpenContext.exportIndex does both.
 */
export async function packArtifact(snapshotDb: string, destFile: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(path.resolve(destFile)), { recursive: true });
  await gzipFile(snapshotDb, destFile);
}

/**
 * Unpack an artifact and install it as a workspace's store database.
 * Validates embedding compatibility, backs up any existing database to
 * `context.db.pre-pull`, and moves the new one into place. The store must
 * not be open while this runs.
 */
export async function installArtifact(
  artifactFile: string,
  storeDir: string,
  expected: { model: string; dimension: number },
): Promise<IndexArtifactManifest> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-artifact-"));
  const unpacked = path.join(tmp, "context.db");
  try {
    await gunzipFile(artifactFile, unpacked);
    const manifest = await readArtifactManifest(unpacked);
    if (manifest.formatVersion !== 1) {
      throw new Error(`Unsupported artifact format v${manifest.formatVersion} — upgrade open-context-engine.`);
    }
    // Embedding space must match EXACTLY or every stored vector is garbage
    // relative to local queries. Model names may differ in registry alias vs
    // fully-qualified id, so compare the tail segment case-insensitively.
    const norm = (m: string) => m.split("/").pop()!.toLowerCase();
    if (manifest.dimension !== expected.dimension || norm(manifest.embeddingModel) !== norm(expected.model)) {
      throw new Error(
        `Artifact was built with ${manifest.embeddingModel} (${manifest.dimension}d) but this workspace is configured for ${expected.model} (${expected.dimension}d). ` +
        `Align your embedding settings with the team's, or rebuild the artifact.`,
      );
    }
    await fs.promises.mkdir(storeDir, { recursive: true });
    const dbPath = path.join(storeDir, "context.db");
    if (fs.existsSync(dbPath)) {
      await fs.promises.copyFile(dbPath, dbPath + ".pre-pull");
    }
    // WAL sidecars from the previous database must not shadow the new file.
    for (const suffix of ["-wal", "-shm"]) {
      try { await fs.promises.unlink(dbPath + suffix); } catch {}
    }
    await fs.promises.copyFile(unpacked, dbPath);
    return manifest;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/** Upload/copy an artifact file to a destination (local path or HTTP(S) PUT). */
export async function pushArtifact(artifactFile: string, dest: string, opts: TransportOptions = {}): Promise<void> {
  if (!isHttpUrl(dest)) {
    await fs.promises.mkdir(path.dirname(path.resolve(dest)), { recursive: true });
    await fs.promises.copyFile(artifactFile, dest);
    return;
  }
  const body = await fs.promises.readFile(artifactFile);
  const resp = await fetch(dest, {
    method: "PUT",
    headers: {
      "Content-Type": "application/gzip",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Upload failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
}

/** Download/copy an artifact from a source (local path or HTTP(S) GET) to destFile. */
export async function pullArtifact(src: string, destFile: string, opts: TransportOptions = {}): Promise<void> {
  await fs.promises.mkdir(path.dirname(path.resolve(destFile)), { recursive: true });
  if (!isHttpUrl(src)) {
    await fs.promises.copyFile(src, destFile);
    return;
  }
  const resp = await fetch(src, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.promises.writeFile(destFile, buf);
}

export const ARTIFACT_MANIFEST_KEY = MANIFEST_KEY;
