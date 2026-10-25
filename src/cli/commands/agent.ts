import { buildSession } from "../session";
import { runRepl } from "../repl";
import { resolveConfig, withStoreOptions } from "../config";
import { CliIo } from "../io";
import { Diagnostics } from "../../core/diagnostics";

export function registerAgentCommands(program: import("commander").Command, io: CliIo): void {
  const { text, progress } = io;

  withStoreOptions(program.command("agent", { isDefault: true }).description("Interactive coding agent (default command — bare `oce` starts it)")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("-p, --provider <provider>", "LLM provider: openai | anthropic | google | ollama | custom")
    .option("--llm-model <model>", "LLM model (default: provider-appropriate)")
    .option("--llm-base-url <url>", "LLM endpoint override (custom/ollama — e.g. an LM Studio or remote Ollama URL)")
    .option("--embedding-provider <provider>", "Embedding provider (defaults to config file / voyage — separate from the LLM provider)")
    .option("--embedding-model <model>", "Embedding model")
    .option("--api-key <key>", "LLM API key"))
    .option("--print <query>", "Non-interactive: answer one query and exit")
    .option("--json", "With --print: emit {answer, stats, toolCalls} as JSON")
    .option("--allow-edits", "(--print only) enable file-edit tools; interactive sessions have them behind approvals")
    .option("--allow-shell", "(--print only) enable the run-command tool; interactive sessions have it behind approvals")
    .option("--auto-edit", "Approval mode: file edits run without asking, shell still asks")
    .option("--full-auto", "Approval mode: nothing asks (containers/CI)")
    .option("--continue", "Resume the most recent session in this workspace")
    .option("--resume <id>", "Resume a specific saved session (see /sessions)")
    .option("--no-plan", "Disable the agent's update-plan tool")
    .option("--no-delegate", "Disable the sub-agent delegate tool")
    .option("--no-env", "Do not inject platform/git/index facts into the system prompt")
    .option("--no-index", "Skip the startup index (use the existing index as-is)")
    .option("--watch", "Keep the index live as files change during the session")
    .option("--route", "Route each query to a cost-appropriate model tier (fast/standard/reasoning)")
    .option("--memory", "Remember codebase insights across sessions (.open-context/memories.json)")
    .option("--audit", "Append runs and tool calls to the tamper-evident audit log (.open-context/audit/)")
    .option("--no-embed-cache", "Disable the shared embedding cache")
    .option("--classic", "Use the line-printer REPL instead of the full-screen Trace interface")
    .action(async (opts) => {
    const interactive = !opts.print;
    const diag = io.diagnosticsFor(opts);
    // The full-screen interface needs a real terminal and the retrieval
    // telemetry; --print, a pipe, or a dumb terminal falls back to the REPL,
    // which stays a first class path rather than a legacy one.
    const useTui = interactive && !opts.classic && !!process.stdout.isTTY && process.env.TERM !== "dumb";
    const built = await buildSession({
      opts, diag, interactive, traced: useTui,
      resolveConfig: (o) => resolveConfig(o, io),
      fatal: io.fatal,
    });
    const { ctx, config, agent, plan, permissions, sessionStore, sessionId, editLog, audit, memory, model, provider, close } = built;

    if (opts.print) {
      const toolCallLog: { name: string; ok: boolean }[] = [];
      const stream = (ev: any) => {
        if (opts.json) {
          if (ev.type === "tool_result") toolCallLog.push({ name: ev.toolResult.name, ok: !ev.toolResult.error });
          return; // JSON mode: stdout carries exactly one JSON document
        }
        if (ev.type === "text") process.stdout.write(ev.text);
        else if (ev.type === "model_selected") progress(`[routed: ${ev.tier.name} → ${ev.tier.model}]\n`);
        else if (ev.type === "tool_call") progress(`[tool ${ev.toolCall.name}] ${JSON.stringify(ev.toolCall.arguments)}\n`);
        else if (ev.type === "tool_result") progress(`[tool ${ev.toolResult.name} result: ${ev.toolResult.result.length} chars]\n`);
        else if (ev.type === "retry") progress(`[retry attempt ${ev.retryAttempt} in ${ev.retryDelayMs}ms: ${ev.retryReason}]\n`);
        else if (ev.type === "history_compacted") progress(`[compacted ${ev.droppedMessages} messages]\n`);
        else if (ev.type === "run_end" && ev.stats) {
          const s = ev.stats;
          const tokens = s.usage.inputTokens || s.usage.outputTokens ? `, ${s.usage.inputTokens} in / ${s.usage.outputTokens} out tokens` : "";
          progress(`\n[${s.steps} step${s.steps === 1 ? "" : "s"}, ${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}${s.toolErrors ? ` (${s.toolErrors} errored)` : ""}${tokens}, ${(s.durationMs / 1000).toFixed(1)}s]\n`);
        }
      };
      const answer = await agent.run(opts.print, { onStream: stream });
      if (opts.json) {
        io.json({ answer, stats: agent.getLastRunStats(), toolCalls: toolCallLog });
      } else {
        process.stdout.write("\n");
      }
      try { sessionStore.save(sessionId, opts.print, agent.exportSession(), 1); } catch {}
      await close();
      return;
    }

    if (useTui && built.trace) {
      // Lazy: `oce index`, `search`, and `mcp` never load the renderer.
      const { runTui } = await import("../../trace/tui");
      await runTui({ session: built.trace });
      await close();
      return;
    }

    await runRepl({
      agent,
      plan,
      permissions,
      sessionStore,
      sessionId,
      editLog,
      banner: {
        model,
        provider,
        workspace: config.workspaceRoot,
        index: `${ctx.getChunkCount().toLocaleString()} chunks · ${ctx.getStatus().searchMode}`,
        mode: permissions.getMode(),
        extras: [
          ...(opts.route ? ["model routing on"] : []),
          ...(memory ? [`memory on (${memory.getAll().length} entries)`] : []),
          ...(audit ? ["audit on"] : []),
        ],
      },
    });
    await close();
  });

  withStoreOptions(program.command("trace").description("Open Trace — the agent workspace: watch retrieval, inspect the context window, review and rewind")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("-p, --provider <provider>", "LLM provider: openai | anthropic | google | ollama | custom")
    .option("--llm-model <model>", "LLM model (default: provider-appropriate)")
    .option("--llm-base-url <url>", "LLM endpoint override (custom/ollama)")
    .option("--embedding-provider <provider>", "Embedding provider (separate from the LLM provider)")
    .option("--embedding-model <model>", "Embedding model")
    .option("--api-key <key>", "LLM API key"))
    .option("--port <n>", "Port to listen on (default: an open one)")
    .option("--host <host>", "Interface to bind (default 127.0.0.1 — loopback only)")
    .option("--no-open", "Do not open a browser")
    .option("--headless", "Serve the API only; do not serve Studio or open a browser")
    .option("--no-parallel", "Single session only; do not offer git-worktree-isolated parallel sessions")
    .option("--auto-edit", "Approval mode: file edits run without asking, shell still asks")
    .option("--full-auto", "Approval mode: nothing asks (containers/CI)")
    .option("--continue", "Resume the most recent session in this workspace")
    .option("--resume <id>", "Resume a specific saved session")
    .option("--no-plan", "Disable the agent's update-plan tool")
    .option("--no-delegate", "Disable the sub-agent delegate tool")
    .option("--no-env", "Do not inject platform/git/index facts into the system prompt")
    .option("--no-index", "Skip the startup index (use the existing index as-is)")
    .option("--watch", "Keep the index live as files change during the session")
    .option("--route", "Route each query to a cost-appropriate model tier")
    .option("--memory", "Remember codebase insights across sessions")
    .option("--audit", "Append runs and tool calls to the tamper-evident audit log")
    .option("--no-embed-cache", "Disable the shared embedding cache")
    .action(async (opts) => {
    const diag = io.diagnosticsFor(opts);

    // Resolve the branch BEFORE building, so the primary session reports which
    // checkout it is on. Once siblings exist, "which one am I looking at" is the
    // first question, and an unlabelled main session is the confusing one.
    const { WorktreeManager } = await import("../../trace/worktree");
    const worktrees = new WorktreeManager({ repoRoot: opts.workspace || process.cwd() });
    const parallel = opts.parallel !== false && await worktrees.isRepo();
    const mainBranch = parallel ? (await worktrees.list()).find(w => w.main)?.branch : undefined;

    const built = await buildSession({
      opts: { ...opts, branch: mainBranch },
      diag, interactive: true, traced: true,
      resolveConfig: (o) => resolveConfig(o, io),
      fatal: io.fatal,
    });
    if (!built.trace) io.fatal("Trace session could not be built.");

    const { startTraceServer } = await import("../../trace/server");
    const pathMod = await import("path");

    // Parallel sessions need git worktrees for isolation: two agents editing one
    // checkout see each other's half-finished edits. Without a repository the
    // harness runs one session, which is the pre-existing behaviour.
    const { SessionRegistry } = await import("../../trace/registry");
    if (!parallel && opts.parallel !== false) {
      diag.progress("Not a git repository — running a single session.\n");
    }

    const registry = new SessionRegistry({
      ...(parallel ? { worktrees } : {}),
      build: async ({ workspace, title, branch }) => {
        // A sibling session is the same stack rooted at its own worktree.
        const child = await buildSession({
          opts: { ...opts, workspace: workspace || opts.workspace, branch, index: opts.index },
          diag, interactive: true, traced: true,
          resolveConfig: (o) => resolveConfig(o, io),
          fatal: (message) => { throw new Error(message); },
        });
        if (!child.trace) throw new Error(`Could not start a session for ${title}.`);
        return { session: child.trace, close: child.close };
      },
    });
    registry.adopt(built.sessionId, { session: built.trace, close: built.close }, {
      title: mainBranch ?? "main",
      workspace: built.config.workspaceRoot,
      branch: mainBranch,
    });

    // Assets sit beside the compiled server (dist/trace/studio). Absent until
    // `npm run build:studio` has run — the API still serves, and the static
    // handler says so rather than 404ing blankly.
    const staticDir = pathMod.join(__dirname, "..", "..", "trace", "studio");
    const server = await startTraceServer({
      session: built.trace,
      ...(parallel ? { registry } : {}),
      port: opts.port ? Number(opts.port) : 0,
      host: opts.host,
      ...(opts.headless ? {} : { staticDir }),
      onLog: (m) => diag.progress(m + "\n"),
    });

    text(`\n  Trace  ${server.url}\n  ${built.provider}/${built.model} · ${built.ctx.getChunkCount().toLocaleString()} chunks · ${built.permissions.getMode()}\n  Ctrl+C to stop.\n`);
    if (opts.open !== false && !opts.headless) await openBrowser(server.url, diag);

    // The server owns the process from here; Ctrl+C unwinds both it and the index.
    await new Promise<void>(resolve => {
      const stop = () => { process.off("SIGINT", stop); resolve(); };
      process.on("SIGINT", stop);
    });
    await server.close();
    await registry.closeAll();
  });
}

/** Best-effort browser launch. A failure is a hint, not an error — the URL is
 *  already on screen and remains usable. */
async function openBrowser(url: string, diag: Diagnostics): Promise<void> {
  const { spawn } = await import("child_process");
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    diag.progress("Could not open a browser — copy the URL above.\n");
  }
}
