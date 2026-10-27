#!/usr/bin/env node
/**
 * Minimal mock language server for tests. Speaks real LSP framing so the
 * client under test exercises the actual wire path. Self-contained (no imports).
 *
 *   node mock-lsp.mjs [--delay <ms>] [--fail <method>]
 *
 * Behavior: answers initialize, echoes canned results for
 * textDocument/definition (one location in the requested file) and
 * textDocument/references (two locations: one workspace file, one outside),
 * --delay sleeps before every response (timeout tests), --fail makes the
 * named method return a JSON-RPC error.
 */

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
// Delay applies to everything EXCEPT initialize, so a test can give the
// handshake a generous timeout while exercising per-request timeouts.
const delay = Number(flag("delay") ?? 0);
const failMethod = flag("fail");

// Inline frame reader — buffer chunks, split on Content-Length framing.
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headEnd = buffer.indexOf("\r\n\r\n");
    if (headEnd === -1) return;
    const header = buffer.slice(0, headEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buffer = buffer.slice(headEnd + 4); continue; }
    const bodyStart = headEnd + 4;
    const len = Number(m[1]);
    if (buffer.length < bodyStart + len) return;
    const body = buffer.slice(bodyStart, bodyStart + len).toString("utf8");
    buffer = buffer.slice(bodyStart + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
const uriFor = (p) => "file://" + (p.startsWith("/") ? p : "/" + p);

async function handle(msg) {
  if (msg.id === undefined) return;
  if (delay && msg.method !== "initialize") await new Promise((r) => setTimeout(r, delay));
  if (failMethod && msg.method === failMethod) { replyError(msg.id, `mock failure for ${failMethod}`); return; }
  switch (msg.method) {
    case "initialize":
      reply(msg.id, { capabilities: { textDocument: { definition: {}, references: {} } } });
      break;
    case "textDocument/definition": {
      const file = decodeURIComponent(String(msg.params.textDocument.uri)).replace(/^file:\/\//, "");
      reply(msg.id, { uri: uriFor(file), range: { start: { line: 11, character: 6 }, end: { line: 11, character: 20 } } });
      break;
    }
    case "textDocument/references": {
      // One reference inside the requested document's workspace, one outside
      // it — lets the finder test prove it keeps the first and drops the second.
      const base = String(msg.params.textDocument.uri).replace(/\/[^/]*$/, "");
      reply(msg.id, [
        { uri: base + "/inside.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 16 } } },
        { uri: "file:///outside-the-workspace/other.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
      ]);
      break;
    }
    case "shutdown":
      reply(msg.id, null);
      break;
    default:
      replyError(msg.id, `method not found: ${msg.method}`);
  }
}
