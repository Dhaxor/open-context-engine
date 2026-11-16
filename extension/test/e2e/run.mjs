#!/usr/bin/env node
// End-to-end: the real extension in a real VS Code, against a scripted model.
//
//   node build.js && node test/e2e/run.mjs        (Linux CI: wrap in xvfb-run -a)
//
// The model is a local OpenAI-compatible server that answers by script, so a
// run needs no API key and is deterministic. The extension reaches it through
// the "ollama" provider pointed at its URL (Ollama speaks the OpenAI API and
// needs no key), and indexes the fixture keyword-only (a hosted embedding
// provider with no key falls back to BM25), so nothing leaves the machine.
//
// What it proves that unit tests cannot: activation with the native SQLite
// binding inside VS Code's Electron, the sidebar webview booting under its CSP,
// and a full agent turn — edit, approval, review, rewind — through TraceHost.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, "..", "..");

/** The script: what the "model" says, given the conversation so far and the
 *  tools it was offered. */
function reply(messages, tools = []) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUser = i; break; }
  const userText = String(lastUser >= 0 ? messages[lastUser].content ?? "" : "");
  const toolAnswered = messages.slice(lastUser + 1).some(m => m.role === "tool");
  const lastTool = messages.slice(lastUser + 1).filter(m => m.role === "tool").at(-1);
  const offered = name => tools.some(t => t.function?.name === name);

  if (/Review these pull-request changes/.test(userText)) {
    return { text: "## hello.txt\nLooks correct: `hello.txt:1` adds the greeting the request asked for." };
  }
  // The user's MCP server (test/e2e: the SDK fixture), reached through the
  // bundled MCP client. Echo the tool's output back so the round trip shows.
  if (/E2E-MCP-ECHO/.test(userText)) {
    if (toolAnswered) return { text: `MCP said: ${lastTool?.content ?? ""}` };
    return offered("mcp__echo__echo")
      ? { tool: { id: "call_mcp_echo", name: "mcp__echo__echo", args: { text: "from vscode" } } }
      : { text: `NO-MCP-TOOL among ${tools.map(t => t.function?.name).join(",")}` };
  }
  if (!toolAnswered && /E2E-MCP-TICKET/.test(userText)) {
    return { tool: { id: "call_mcp_ticket", name: "mcp__echo__create_ticket", args: { title: "e2e" } } };
  }
  if (/^Fix this error at `broken\.ts/.test(userText)) {
    return { text: "Fixed: `broken.ts:1` assigned a string to a number." };
  }
  if (!toolAnswered && /E2E-CREATE/.test(userText)) {
    return { tool: { id: "call_create", name: "create-file", args: { path: "hello.txt", contents: "hello from the agent\n" } } };
  }
  if (!toolAnswered && /E2E-SHELL/.test(userText)) {
    return { tool: { id: "call_shell", name: "run-command", args: { command: "echo e2e-shell" } } };
  }
  return { text: toolAnswered ? "Done." : "Nothing to do." };
}

function serveModel() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      const answer = reply(request.messages ?? [], request.tools ?? []);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const base = { id: "chatcmpl-e2e", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: request.model };
      const send = chunk => res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
      if (answer.tool) {
        send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: answer.tool.id, type: "function", function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ choices: [{ index: 0, delta: { role: "assistant", content: answer.text }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const server = await serveModel();
const port = server.address().port;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "oce-e2e-ws-"));
fs.mkdirSync(path.join(workspace, ".vscode"));
fs.writeFileSync(path.join(workspace, "README.md"), "# e2e fixture\n\nA workspace for the Open Context end-to-end suite.\n");
fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
  "openContext.llm.provider": "ollama",
  "openContext.llm.baseUrl": `http://127.0.0.1:${port}/v1`,
  "openContext.llm.model": "scripted",
  "openContext.embedding.provider": "voyage",
  "openContext.agent.approvalMode": "auto-edit",
  "openContext.agent.memory.enabled": false,
  "openContext.agent.webSearch.enabled": false,
}, null, 2));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oce-e2e-user-"));

let failed = false;
try {
  await runTests({
    version: process.env.VSCODE_VERSION || "stable",
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: path.join(here, "suite.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userData}`],
    extensionTestsEnv: {
      OCE_E2E: "1",
      OCE_E2E_WORKSPACE: workspace,
      // The suite turns on a user-level MCP server mid-run: the SDK fixture,
      // run by this Node (the extension host's own binary is Electron).
      OCE_E2E_NODE: process.execPath,
      OCE_E2E_MCP_FIXTURE: path.resolve(extensionRoot, "..", "src", "agent", "__fixtures__", "mcp-echo-server.cjs"),
      // A clean CLI config dir, so a developer's own ~/.open-context servers stay out.
      OCE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "oce-e2e-cfg-")),
      // Keyword-only indexing must not be upgraded by a developer's own key.
      VOYAGE_API_KEY: "",
      OPENAI_API_KEY: "",
    },
  });
} catch (err) {
  failed = true;
  console.error(`e2e failed: ${err?.message ?? err}`);
} finally {
  server.close();
}
process.exit(failed ? 1 : 0);
