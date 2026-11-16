import * as path from "path";
import { execFileSync } from "child_process";
import type { Command } from "commander";
import { resolveConfig, withStoreOptions } from "../config";
import { CliIo } from "../io";
import { AuditLogger, defaultAuditDir } from "../../core/audit";
import { loadPolicy, policyRequiresAudit } from "../../core/policy";
import { MCP_CLIENTS, applyInstall, clientSpec, onPath, planInstall, serverCommand, snippet, type McpClient, type McpScope } from "../mcp-install";

export function registerMcpCommand(program: import("commander").Command, io: CliIo): void {
  const mcp = withStoreOptions(program.command("mcp").description("Run MCP server (stdio by default; --http for a shared Streamable HTTP endpoint). Indexes on startup and watches for changes. `oce mcp install <client>` adds it to Claude Code, Cursor, VS Code, Windsurf, or Claude Desktop.")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("-p, --provider <provider>", "Provider")
    .option("-m, --model <model>", "Model")
    .option("--api-key <key>", "API key"))
    .option("--no-watch", "Do not keep the index live (no file watching)")
    .option("--http", "Serve over Streamable HTTP instead of stdio")
    .option("--port <n>", "HTTP port (with --http)", "8940")
    .option("--host <host>", "HTTP bind host (with --http; default loopback-only)", "127.0.0.1")
    .option("--auth-token <token>", "Require 'Authorization: Bearer <token>' on HTTP requests (or set OCE_MCP_AUTH_TOKEN)")
    .option("--audit", "Append every MCP tool invocation to the workspace audit log")
    .option("--no-embed-cache", "Disable the shared embedding cache")
    .action(async (opts: any) => {
      const { runMCPServer } = await import("../../mcp/server");
      const config = resolveConfig(opts, io);
      let audit: AuditLogger | undefined;
      const policy = loadPolicy(config.workspaceRoot);
      if (opts.audit || policyRequiresAudit(policy)) {
        audit = new AuditLogger({ dir: defaultAuditDir(config.workspaceRoot, config.storePath) });
      }
      await runMCPServer(config, {
        watch: opts.watch,
        audit,
        ...(opts.http ? { http: { port: Number(opts.port), host: opts.host, authToken: opts.authToken || process.env.OCE_MCP_AUTH_TOKEN || undefined } } : {}),
      });
    });

  // `oce mcp install <client>`: `mcp` keeps its own action (run the server),
  // and its -w/--workspace is read from the parent — commander hands options
  // the parent knows to the parent wherever they appear.
  mcp.command("install [client]")
    .description(`Add Open Context to an MCP client's config (${MCP_CLIENTS.map(c => c.id).join(", ")}). No client lists them.`)
    .option("-s, --scope <scope>", "project (this repo — commit it to share) or user (every project)")
    .option("--name <name>", "Server name in the client's config", "open-context")
    .option("--npx", "Start the server with `npx -y @dhaxor/open-context` even if `oce` is installed")
    .option("--print", "Show what would change; write nothing")
    .option("--remove", "Take Open Context out of that client's config")
    .action(function (this: Command, client: string | undefined, opts: { scope?: string; name: string; npx?: boolean; print?: boolean; remove?: boolean }) {
      const workspace = path.resolve(this.parent?.opts().workspace ?? process.cwd());
      if (!client) {
        io.text("Add Open Context to an MCP client:\n");
        for (const c of MCP_CLIENTS) io.text(`  oce mcp install ${c.id.padEnd(15)} ${c.label} — ${c.scopes.join(" or ")} (default ${c.defaultScope})`);
        io.text("\nOptions: --scope project|user, --print to preview, --remove to undo. Run it in the project you want indexed.");
        return;
      }
      const spec = clientSpec(client);
      if (!spec) io.fatal(`Unknown client "${client}". Use one of: ${MCP_CLIENTS.map(c => c.id).join(", ")}.`);
      if (opts.scope && opts.scope !== "project" && opts.scope !== "user") io.fatal(`--scope is "project" or "user", not "${opts.scope}".`);
      const installed = !opts.npx && onPath("oce");
      let plan;
      try {
        plan = planInstall({
          client: client as McpClient, workspace, name: opts.name,
          ...(opts.scope ? { scope: opts.scope as McpScope } : {}),
          server: serverCommand(installed),
        });
      } catch (err: any) {
        return io.fatal(String(err?.message ?? err));
      }

      if (plan.shell) {
        // Registered through the client's own CLI (it owns where that lives).
        const [bin] = plan.shell.split(" ");
        if (opts.remove) {
          io.text(bin === "claude" ? `claude mcp remove --scope user ${plan.name}` : `Remove "${plan.name}" with VS Code's "MCP: List Servers" command.`);
          return;
        }
        if (opts.print || !onPath(bin)) {
          if (!opts.print) io.warn(`\`${bin}\` is not on PATH — run this yourself:`);
          io.text(plan.shell);
          return;
        }
        try {
          execFileSync(bin === "code" && process.platform === "win32" ? "code.cmd" : bin, splitShell(plan.shell).slice(1), { stdio: "inherit" });
          io.info(`Added "${plan.name}" to ${plan.label} (${plan.scope}).`);
        } catch (err: any) {
          io.fail(`\`${plan.shell}\` failed: ${err?.message ?? err}`);
        }
        return;
      }

      if (opts.print) {
        io.text(`${opts.remove ? "Would remove" : "Would write"} "${plan.name}" ${opts.remove ? "from" : "in"} ${plan.file}:\n`);
        io.text(snippet(plan));
        return;
      }
      try {
        const { status, file } = applyInstall(plan, { remove: !!opts.remove });
        const verb = { added: "Added", updated: "Updated", unchanged: "Already set up:", removed: "Removed", absent: "Not there:" }[status];
        io.info(`${verb} "${plan.name}" in ${file}`);
        if (status === "added" || status === "updated") {
          if (!installed) io.text("It starts the server with npx (no `oce` on PATH). Install it once to start faster: npm i -g @dhaxor/open-context");
          if (plan.pinned) io.text(`This config is global, so it indexes ${workspace}. For another project, run this there with --name.`);
          io.text(`Restart ${plan.label} (or reload its MCP servers) to pick it up.`);
        }
      } catch (err: any) {
        io.fatal(String(err?.message ?? err));
      }
    });
}

/** Split the commands planInstall prints (single-quoted JSON at most). */
function splitShell(command: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]);
  return out;
}
