const path = require("path");
const { AstChunker } = require("../dist/core/ast-chunker.js");
const { CodeChunker } = require("../dist/core/chunker.js");
const fs = require("fs");
(async () => {
  const chunker = new AstChunker({ maxChunkChars: 80000, fallback: new CodeChunker(80, 15, 80000) });
  for (const rel of process.argv.slice(2)) {
    const contents = fs.readFileSync(rel, "utf8");
    const chunks = await chunker.chunkFile({ path: rel, contents });
    const seen = new Map();
    for (const c of chunks) {
      if (seen.has(c.id)) {
        const prev = seen.get(c.id);
        console.log("DUP in", rel);
        console.log("  A:", prev.startLine + "-" + prev.endLine, "sym=" + prev.symbolName, JSON.stringify(prev.contents.slice(0, 70)));
        console.log("  B:", c.startLine + "-" + c.endLine, "sym=" + c.symbolName, JSON.stringify(c.contents.slice(0, 70)));
      }
      seen.set(c.id, c);
    }
  }
  process.exit(0);
})();
