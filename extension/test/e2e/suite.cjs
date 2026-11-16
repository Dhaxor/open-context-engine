// Runs INSIDE the VS Code extension host launched by run.mjs.
// Plain CommonJS and node:assert: nothing to compile, no test framework to ship.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(what, fn, ms = 60_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`Timed out after ${ms}ms waiting for ${what}`);
    await sleep(100);
  }
}

async function within(what, promise, ms = 60_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${what}`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

exports.run = async function run() {
  const root = process.env.OCE_E2E_WORKSPACE;
  const steps = [];
  const step = (name, fn) => steps.push({ name, fn });

  let handles;
  let session;
  const events = [];
  const turnsEnded = () => events.filter(e => e.type === "turn_end").length;

  step("activates, native SQLite binding included", async () => {
    const ext = vscode.extensions.getExtension("open-context.open-context-engine");
    assert.ok(ext, "the extension under test is installed");
    handles = await ext.activate();
    assert.ok(handles && handles.traceHost, "activate() returned the e2e handles — an inert activation means the native binding failed to load");
  });

  step("the sidebar webview boots under its CSP and greets the host", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.openContext");
    await within("the agent webview's ready message", handles.agentView.whenLoaded, 30_000);
  });

  step("a turn creates a file through VS Code's edit path", async () => {
    session = await handles.traceHost.sessionForTurn(null);
    session.subscribe(env => events.push(env.event));
    await within("the create turn", session.prompt("E2E-CREATE: add hello.txt with a greeting"));
    const file = path.join(root, "hello.txt");
    await waitFor("hello.txt on disk", () => fs.existsSync(file));
    assert.equal(fs.readFileSync(file, "utf8"), "hello from the agent\n");
    const kinds = events.map(e => e.type);
    for (const kind of ["turn_start", "tool_call", "edit", "tool_result", "text", "turn_end", "checkpoint"]) {
      assert.ok(kinds.includes(kind), `the turn emitted ${kind} (got: ${[...new Set(kinds)].join(", ")})`);
    }
  });

  step("a shell command waits for approval in auto-edit, then runs", async () => {
    const before = events.length;
    const turn = session.prompt("E2E-SHELL: run a command");
    const ask = await waitFor("an approval request", () => events.slice(before).find(e => e.type === "approval_request"));
    assert.equal(ask.request.kind, "shell");
    assert.match(ask.request.preview, /echo e2e-shell/);
    assert.ok(session.approve(ask.request.id, "allow"));
    await within("the shell turn", turn);
    const result = events.slice(before).find(e => e.type === "tool_result" && e.name === "run-command");
    assert.ok(result && result.ok, "the approved command ran");
  });

  step("Review changes runs a labelled review turn over the edit", async () => {
    const edit = events.find(e => e.type === "edit");
    const done = turnsEnded();
    const { files } = await handles.traceHost.reviewChanges(null, { kind: "edits", ids: [edit.edit.id] });
    assert.equal(files, 1);
    await waitFor("the review turn to finish", () => turnsEnded() > done);
    const start = events.filter(e => e.type === "turn_start").at(-1);
    assert.equal(start.prompt, "Review this turn's changes (1 file)");
    const texts = events.filter(e => e.type === "text").map(e => e.text).join("");
    assert.match(texts, /Looks correct/);
  });

  step("rewinding to the first checkpoint drops the later turns", async () => {
    const first = session.checkpoints()[0];
    assert.ok(first, "the first turn left a checkpoint");
    await session.rewind(first.hash);
    const rewound = events.find(e => e.type === "rewound");
    assert.ok(rewound, "a rewound event");
    assert.equal(rewound.turnsDropped, 2);
    assert.ok(fs.existsSync(path.join(root, "hello.txt")), "the first turn's file survives a rewind to its own checkpoint");
  });

  const attention = [];
  step("checkpoints and their edits survive a settings rebuild", async () => {
    // A settings change rebuilds the session. It used to carry only the
    // messages, so Rewind and the changes tray silently disappeared. The
    // change made here — a user-level MCP server — is what the next step uses.
    const before = session.checkpoints().map(c => c.hash);
    assert.ok(before.length >= 1, "a checkpoint to carry over");
    const reset = new Promise(resolve => { const d = handles.traceHost.onDidReset(r => { d.dispose(); resolve(r); }); });
    handles.traceHost.onDidNeedAttention(a => attention.push(a));
    await vscode.workspace.getConfiguration("openContext").update("agent.mcpServers", {
      echo: { command: process.env.OCE_E2E_NODE, args: [process.env.OCE_E2E_MCP_FIXTURE] },
    }, vscode.ConfigurationTarget.Global);
    await within("the rebuild the settings change triggers", reset, 60_000);

    session = await handles.traceHost.sessionForTurn(null);
    events.length = 0;
    session.subscribe(env => events.push(env.event)); // snapshot + the retold transcript
    assert.deepEqual(session.checkpoints().map(c => c.hash), before);
    assert.ok(events.some(e => e.type === "edit" && e.edit.path === "hello.txt"), "the changes tray came back");
    assert.ok(events.some(e => e.type === "checkpoint" && e.checkpoint.hash === before[0]), "the checkpoint came back");
  });

  step("the agent uses the user's MCP server: a read-only tool runs, a mutating one asks", async () => {
    const state = await handles.traceHost.state();
    assert.deepEqual((state.mcp || []).map(s => [s.name, s.state, s.tools]), [["echo", "connected", 3]], `MCP status: ${JSON.stringify(state.mcp)}`);

    const before = events.length;
    await within("the MCP echo turn", session.prompt("E2E-MCP-ECHO: use the echo tool"));
    const mine = events.slice(before);
    const texts = mine.filter(e => e.type === "text").map(e => e.text).join("");
    const ran = mine.find(e => e.type === "tool_result" && e.name === "mcp__echo__echo");
    assert.ok(ran && ran.ok, `the MCP tool ran (the model said: ${texts})`);
    assert.ok(!mine.some(e => e.type === "approval_request"), "a read-only MCP tool runs without asking");
    assert.match(texts, /MCP said: echo: from vscode/);
    assert.ok(attention.some(a => a.kind === "finished" && a.sessionId === session.meta().id), "the finished turn was reported for notification");

    const mark = events.length;
    const turn = session.prompt("E2E-MCP-TICKET: file a ticket");
    const ask = await waitFor("an approval for the mutating MCP tool", () => events.slice(mark).find(e => e.type === "approval_request"));
    assert.equal(ask.request.title, "echo · create_ticket");
    assert.ok(session.approve(ask.request.id, "allow"));
    await within("the ticket turn", turn);
    assert.ok(events.slice(mark).some(e => e.type === "tool_result" && e.name === "mcp__echo__create_ticket" && e.ok), "the approved MCP tool ran");
  });

  step("Fix with agent: the quick fix on a diagnostic starts a labelled turn", async () => {
    const file = path.join(root, "broken.ts");
    fs.writeFileSync(file, "const n: number = \"one\";\nexport default n;\n");
    const uri = vscode.Uri.file(file);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const range = new vscode.Range(0, 6, 0, 7);
    const problem = new vscode.Diagnostic(range, "Type 'string' is not assignable to type 'number'.", vscode.DiagnosticSeverity.Error);
    problem.source = "ts";
    const diagnostics = vscode.languages.createDiagnosticCollection("oce-e2e");
    diagnostics.set(uri, [problem]);
    try {
      const fix = await waitFor("the Fix with agent code action", async () => {
        const all = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", uri, range);
        return (all || []).find(a => a.title === "Fix with Open Context agent");
      }, 15_000);
      const done = turnsEnded();
      await vscode.commands.executeCommand(fix.command.command, ...(fix.command.arguments || []));
      await waitFor("the fix turn to finish", () => turnsEnded() > done);
      const start = events.filter(e => e.type === "turn_start").at(-1);
      assert.equal(start.prompt, "Fix: Type 'string' is not assignable to type 'number'. (broken.ts:1)");
      assert.match(events.filter(e => e.type === "text").map(e => e.text).join(""), /Fixed: `broken\.ts:1`/);
    } finally {
      diagnostics.dispose();
    }
  });

  for (const { name, fn } of steps) {
    const started = Date.now();
    try {
      await fn();
      console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
    } catch (err) {
      console.error(`  ✗ ${name}\n    ${err && err.stack ? err.stack : err}`);
      throw err;
    }
  }
};
