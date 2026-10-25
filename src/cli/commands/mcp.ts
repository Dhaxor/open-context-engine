import { resolveConfig, withStoreOptions } from "../config";
import { CliIo } from "../io";
import { AuditLogger, defaultAuditDir } from "../../core/audit";
import { loadPolicy, policyRequiresAudit } from "../../core/policy";

export function registerMcpCommand(program: import("commander").Command, io: CliIo): void {
  withStoreOptions(program.command("mcp").description("Run MCP server (stdio by default; --http for a shared Streamable HTTP endpoint). Indexes on startup and watches for changes.")
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
    .action(async (opts) => {
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
}
