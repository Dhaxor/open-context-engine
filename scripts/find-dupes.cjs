// Reproduce duplicate chunk ids across the repo's own source.
const path = require("path");
const { AstChunker } = require("../dist/core/ast-chunker.js");
const { CodeChunker } = require("../dist/core/chunker.js");
const fs = require("fs");

(async () => {
  const chunker = new AstChunker({ maxChunkChars: 80000, fallback: new CodeChunker(80, 15, 80000) });
  const root = process.cwd();
  const dupes = [];
  const jobs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".ts") && !e.name.endsWith(".tsx")) continue;
      const rel = path.relative(process.cwd(), full).replace(/\\/g, "/");
      const contents = fs.readFileSync(full, "utf8");
      jobs.push(chunker.chunkFile({ path: rel, contents }).then(chunks => {
        const seen = new Map();
        for (const c of chunks) {
          if (seen.has(c.id)) dupes.push(c.id + "  in  " + c.path);
          seen.set(c.id, c);
        }
      }));
    }
  };
  walk(root);
  await Promise.all(jobs);
  console.log("duplicate ids:", dupes.length);
  for (const d of dupes.slice(0, 8)) console.log("  " + d);
  process.exit(0);
})();
