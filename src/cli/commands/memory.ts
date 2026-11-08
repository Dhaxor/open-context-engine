import { resolveConfig } from "../config";
import { CliIo } from "../io";
import { SessionMemory, renderMarkdown } from "../../agent/session-memory";
import { defaultStorePath } from "../../core/context";

const KINDS = ["fact", "preference", "codebase_insight", "conversation_summary"] as const;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
function memoryFor(opts: any, io: CliIo): SessionMemory {
  const config = resolveConfig(opts, io, { requireCreds: false });
  const store = config.storePath || defaultStorePath(config.workspaceRoot);
  // Lexical-only on purpose: list/add/forget never touch the embedding
  // provider, so a keyword-only workspace gets no surprise network calls.
  return new SessionMemory({ storePath: store });
}

export function registerMemoryCommand(program: import("commander").Command, io: CliIo): void {
  const { text, info } = io;

  const memory = program.command("memory").description("Inspect and manage the agent's durable cross-session memory (stored beside the index).");

  memory.command("list")
    .description("List every remembered entry, newest first.")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--store-path <path>", "Custom store directory")
    .option("--kind <kind>", `Filter by kind (${KINDS.join("|")})`)
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts: any) => {
      const mem = memoryFor(opts, io);
      let entries = mem.getAll().sort((a, b) => b.createdAt - a.createdAt);
      if (opts.kind) {
        if (!KINDS.includes(opts.kind)) io.fatal(`Unknown kind '${opts.kind}' — expected one of: ${KINDS.join(", ")}`);
        entries = entries.filter(e => e.kind === opts.kind);
      }
      if (opts.json) { text(JSON.stringify(entries, null, 2)); return; }
      if (!entries.length) { info("No memories yet. They accumulate as the agent works, or add one: oce memory add \"...\""); return; }
      for (const e of entries) {
        const date = new Date(e.createdAt).toISOString().slice(0, 10);
        const flag = e.supersededBy ? "  (superseded)" : "";
        text(`[${e.kind}] ${e.content}${flag}`);
        text(`    ${e.id} · ${date}${e.source ? ` · ${e.source}` : ""}`);
      }
      info(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} · markdown twin alongside memories.json`);
    });

  memory.command("add <content>")
    .description("Add a memory explicitly (e.g. oce memory add \"the team prefers pnpm\").")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--store-path <path>", "Custom store directory")
    .option("--kind <kind>", `Memory kind (default: preference) (${KINDS.join("|")})`, "preference")
    .option("--supersedes <id>", "Id of an older memory this one replaces")
    .action(async (content: string, opts: any) => {
      if (!KINDS.includes(opts.kind)) io.fatal(`Unknown kind '${opts.kind}' — expected one of: ${KINDS.join(", ")}`);
      const mem = memoryFor(opts, io);
      const entry = mem.add({ kind: opts.kind, content, source: "cli", tags: [], ...(opts.supersedes ? { supersedes: opts.supersedes } : {}) });
      info(`Remembered ${entry.id}${entry.supersedes ? ` (supersedes ${entry.supersedes})` : ""}`);
    });

  memory.command("forget <id>")
    .description("Delete a memory by id (see oce memory list).")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--store-path <path>", "Custom store directory")
    .action(async (id: string, opts: any) => {
      const mem = memoryFor(opts, io);
      if (mem.forget(id)) info(`Forgot ${id}.`);
      else io.fatal(`No memory with id ${id}.`);
    });

  memory.command("search <query>")
    .description("Recall memories the way the agent does — hybrid lexical + semantic ranking.")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("-p, --provider <provider>", "Embedding provider")
    .option("-m, --model <model>", "Embedding model")
    .option("--api-key <key>", "API key")
    .option("--store-path <path>", "Custom store directory")
    .option("-k, --top <n>", "Max results", "5")
    .action(async (query: string, opts: any) => {
      const config = resolveConfig(opts, io, { requireCreds: true });
      const store = config.storePath || defaultStorePath(config.workspaceRoot);
      const { createEmbeddingProvider } = await import("../../core/embedder");
      const mem = new SessionMemory({ storePath: store, embedder: createEmbeddingProvider(config.embedding) });
      const hits = await mem.recall(query, Math.max(1, Math.min(20, Number(opts.top) || 5)));
      if (!hits.length) { info("No relevant memories."); return; }
      for (const e of hits) {
        const date = new Date(e.createdAt).toISOString().slice(0, 10);
        text(`[${e.kind}] ${e.content}`);
        text(`    ${e.id} · ${date}${e.source ? ` · ${e.source}` : ""}`);
      }
    });

  memory.command("export")
    .description("Print the markdown twin (memories.md) to stdout.")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--store-path <path>", "Custom store directory")
    .action(async (opts: any) => {
      const mem = memoryFor(opts, io);
      text(renderMarkdown(mem.getAll(), MAX_AGE));
    });
}
