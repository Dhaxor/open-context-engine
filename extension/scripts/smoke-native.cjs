#!/usr/bin/env node
// smoke-native — prove the native layer works in THIS runtime: load
// better-sqlite3 and sqlite-vec from an extension tree, then do what the engine
// does with them (a WAL store on disk, vec0 KNN, FTS5).
//
//   node scripts/smoke-native.cjs [extensionRoot]
//   ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-native.cjs [extensionRoot]
//
// verify-vsix.mjs runs it under plain Node against the unpacked VSIX — the
// runtime of remote extension hosts (SSH, WSL, Codespaces). CI also runs it
// under Electron — the runtime of desktop VS Code. better-sqlite3 13 is
// Node-API, so the one binary has to pass under both.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");

// realpath: module resolution returns real paths, and on macOS the temp dir
// (/var/...) is a symlink to /private/var/..., which garbles relative labels.
const root = fs.realpathSync(path.resolve(process.argv[2] || path.join(__dirname, "..")));
const runtime = process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.versions.node}`;
const where = `${runtime}, ABI ${process.versions.modules}, ${process.platform}-${process.arch}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-smoke-"));

let db;
try {
  const req = createRequire(path.join(root, "noop.js"));
  const Database = req("better-sqlite3");
  const sqliteVec = req("sqlite-vec");
  // Its loader takes prebuilds/<platform>-<arch>.node when present (the
  // package's exports hide lib/binding, so check the file directly).
  const prebuild = path.join(path.dirname(req.resolve("better-sqlite3/package.json")), "prebuilds", `${process.platform}-${process.arch}.node`);
  const binding = fs.existsSync(prebuild) ? path.relative(root, prebuild) : "a source build (no prebuild for this host)";

  db = new Database(path.join(dir, "index.db"));
  const journal = db.pragma("journal_mode = WAL", { simple: true });
  sqliteVec.load(db);
  const { sqlite, vec } = db.prepare("select sqlite_version() sqlite, vec_version() vec").get();

  db.exec("create virtual table vecs using vec0(embedding float[4])");
  const insert = db.prepare("insert into vecs(rowid, embedding) values (?, ?)");
  db.transaction(() => {
    insert.run(1n, new Float32Array([1, 0, 0, 0]));
    insert.run(2n, new Float32Array([0, 1, 0, 0]));
    insert.run(3n, new Float32Array([0.9, 0.1, 0, 0]));
  })();
  const knn = db
    .prepare("select rowid from vecs where embedding match ? order by distance limit 2")
    .all(new Float32Array([1, 0, 0, 0]))
    .map(r => Number(r.rowid));

  db.exec("create virtual table docs using fts5(body)");
  db.prepare("insert into docs(body) values (?)").run("retryWithBackoff wraps a promise");
  const fts = db.prepare("select count(*) n from docs where docs match ?").get("retryWithBackoff").n;

  const problems = [];
  if (journal !== "wal") problems.push(`journal_mode is ${journal}, expected wal`);
  if (knn.join(",") !== "1,3") problems.push(`KNN returned [${knn}], expected [1,3]`);
  if (fts !== 1) problems.push(`FTS5 matched ${fts} rows, expected 1`);
  if (problems.length) throw new Error(problems.join("; "));

  console.log(`OK    native smoke (${where}): SQLite ${sqlite}, sqlite-vec ${vec}, WAL + KNN + FTS5 via ${binding}`);
} catch (err) {
  console.error(`FAIL  native smoke (${where}): ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
} finally {
  try { db && db.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
