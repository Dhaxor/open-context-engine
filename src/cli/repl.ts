import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { ContextAgent } from "../agent/agent";
import { EditProposal, StreamEvent } from "../agent/types";
import { AgentPlan } from "../agent/plan";
import { ApprovalDecision, ApprovalRequest, PermissionManager } from "../agent/permissions";
import { SessionStore } from "../agent/session-store";
import {
  BannerInfo, HELP_TEXT, MarkdownStreamRenderer, Spinner,
  colorizeDiff, formatPlan, formatStats, formatToolCall, formatToolResult,
  makeColors, parseSlashCommand, renderBanner, renderBox, supportsColor,
} from "./ui";

/**
 * The interactive agent REPL — the front door of the CLI. Design follows the
 * conventions the leading coding CLIs converged on: streamed styled output,
 * live tool-call lines, inline diff previews with y/a/n approvals, slash
 * commands, session resume, and Ctrl+C that interrupts the run (not the app).
 */

export interface ReplOptions {
  agent: ContextAgent;
  plan: AgentPlan;
  permissions: PermissionManager;
  sessionStore: SessionStore;
  sessionId: string;
  banner: BannerInfo;
  /** Edits made this session (index.ts wires onEdit to push here). */
  editLog: EditProposal[];
  output?: NodeJS.WriteStream;
  input?: NodeJS.ReadableStream;
  historyFile?: string;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const out = opts.output ?? process.stdout;
  const c = makeColors(supportsColor(out as NodeJS.WriteStream));
  const spinner = new Spinner(out as NodeJS.WriteStream, c);
  const historyFile = opts.historyFile ?? path.join(os.homedir(), ".open-context", "cli-history");

  out.write("\n" + renderBanner(opts.banner, c) + "\n");

  const rl = readline.createInterface({
    input: opts.input ?? process.stdin,
    output: out,
    prompt: c.cyan("› "),
    historySize: 500,
  });
  loadHistory(rl, historyFile);

  // Approvals arrive mid-run while the spinner owns the line: freeze it,
  // show the preview box, ask, and let the run loop restart the spinner.
  opts.permissions.setAsk(async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    spinner.stopWith();
    out.write(renderBox(req.title, req.preview.includes("---") || req.preview.includes("+++")
      ? colorizeDiff(req.preview, c)
      : req.preview, c) + "\n");
    const answer = await question(rl, c.yellow("approve? ") + c.dim("[y]es · [a]lways for this tool · [n]o: "));
    const ch = answer.trim().toLowerCase();
    return ch === "y" || ch === "yes" ? "allow" : ch === "a" || ch === "always" ? "always" : "deny";
  });

  let running: AbortController | null = null;
  let lastSigint = 0;
  let turns = 0;
  let sessionTitle = "";

  rl.on("SIGINT", () => {
    if (running) {
      running.abort();
      spinner.stopWith(c.yellow("■ interrupted"));
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 2_000) { rl.close(); return; }
    lastSigint = now;
    out.write("\n" + c.dim("(press Ctrl+C again to quit, or /exit)") + "\n");
    rl.prompt();
  });

  const closed = new Promise<void>(resolve => rl.on("close", () => {
    saveHistory(rl, historyFile);
    out.write("\n" + c.dim("bye") + "\n");
    resolve();
  }));

  rl.on("line", (line) => void handleLine(line));
  rl.prompt();

  async function handleLine(line: string): Promise<void> {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    const slash = parseSlashCommand(input);
    if (slash) {
      await handleSlash(slash.name, slash.args);
      rl.prompt();
      return;
    }
    await runTurn(input);
    rl.prompt();
  }

  async function runTurn(query: string): Promise<void> {
    running = new AbortController();
    const md = new MarkdownStreamRenderer(c);
    const toolStart = new Map<string, number>();
    let printedText = false;

    const onStream = (ev: StreamEvent): void => {
      switch (ev.type) {
        case "text":
          if (ev.text) {
            spinner.stopWith();
            out.write(md.feed(ev.text));
            printedText = true;
          }
          break;
        case "model_selected":
          out.write(c.dim(`↪ routed to ${ev.tier?.model}`) + "\n");
          break;
        case "tool_call": {
          spinner.stopWith();
          const flushed = md.flush();
          if (flushed) out.write(flushed + "\n");
          toolStart.set(ev.toolCall!.id, Date.now());
          spinner.start(formatToolCall(ev.toolCall!.name, ev.toolCall!.arguments, c));
          break;
        }
        case "tool_result": {
          const started = toolStart.get(ev.toolResult!.id);
          spinner.stopWith("  " + formatToolResult(
            ev.toolResult!.name,
            !ev.toolResult!.error,
            started !== undefined ? Date.now() - started : undefined,
            ev.toolResult!.result.length,
            c,
          ));
          if (ev.toolResult!.name === "update-plan" && !opts.plan.isEmpty()) {
            out.write(formatPlan(opts.plan.getSteps(), c) + "\n");
          }
          spinner.start(c.dim("thinking…"));
          break;
        }
        case "retry":
          spinner.update(c.yellow(`retrying (${ev.retryReason}) in ${((ev.retryDelayMs ?? 0) / 1000).toFixed(1)}s…`));
          break;
        case "history_compacted":
          out.write(c.dim(`✂ compacted ${ev.droppedMessages} message${ev.droppedMessages === 1 ? "" : "s"}${ev.summarized ? " into a context note" : ""}`) + "\n");
          break;
        case "run_end":
          if (ev.stats) {
            spinner.stopWith();
            const tail = md.flush();
            if (tail) out.write(tail + "\n");
            out.write((printedText ? "\n" : "") + formatStats(ev.stats, c) + "\n");
          }
          break;
      }
    };

    spinner.start(c.dim("thinking…"));
    try {
      await opts.agent.run(query, { onStream, signal: running.signal });
      turns++;
      if (!sessionTitle) sessionTitle = query;
      try { opts.sessionStore.save(opts.sessionId, sessionTitle, opts.agent.exportSession(), turns); } catch {}
    } catch (e: any) {
      spinner.stopWith();
      const msg = String(e?.message ?? e);
      out.write((/abort/i.test(msg) ? c.yellow("■ run interrupted") : c.red(`error: ${msg}`)) + "\n");
    } finally {
      spinner.stopWith();
      running = null;
    }
  }

  async function handleSlash(name: string, args: string): Promise<void> {
    switch (name) {
      case "help": out.write(HELP_TEXT + "\n"); break;
      case "exit": case "quit": rl.close(); break;
      case "reset":
        opts.agent.reset();
        opts.plan.clear();
        opts.editLog.length = 0;
        out.write(c.dim("conversation cleared") + "\n");
        break;
      case "compact": {
        spinner.start(c.dim("compacting…"));
        try {
          const r = await opts.agent.compact();
          spinner.stopWith(c.dim(`✂ ${r.summarized ? `summarized ${r.dropped} messages into a context note` : `dropped ${r.dropped} old messages`}`));
        } catch (e: any) {
          spinner.stopWith(c.red(`compact failed: ${e?.message ?? e}`));
        }
        break;
      }
      case "plan": out.write(formatPlan(opts.plan.getSteps(), c) + "\n"); break;
      case "diff": {
        if (!opts.editLog.length) { out.write(c.dim("(no edits this session)") + "\n"); break; }
        for (const e of opts.editLog) out.write(colorizeDiff(e.diff, c) + "\n");
        break;
      }
      case "usage": {
        const total = opts.agent.getTotalUsage();
        const last = opts.agent.getLastRunStats();
        out.write(`session: ${c.bold(total.inputTokens.toLocaleString())} in · ${c.bold(total.outputTokens.toLocaleString())} out tokens\n`);
        if (last) out.write(`last turn: ${formatStats(last, c)}\n`);
        break;
      }
      case "tools": out.write(opts.agent.getToolNames().map(t => `- ${t}`).join("\n") + "\n"); break;
      case "mode": {
        if (!args) { out.write(`approval mode: ${c.bold(opts.permissions.getMode())}\n`); break; }
        if (args === "suggest" || args === "auto-edit" || args === "full-auto") {
          opts.permissions.setMode(args);
          out.write(c.dim(`approval mode → ${args}`) + "\n");
        } else {
          out.write(c.red("usage: /mode suggest | auto-edit | full-auto") + "\n");
        }
        break;
      }
      case "sessions": {
        const sessions = opts.sessionStore.list().slice(0, 10);
        if (!sessions.length) { out.write(c.dim("(no saved sessions)") + "\n"); break; }
        for (const s of sessions) {
          const current = s.id === opts.sessionId ? c.green(" ← current") : "";
          out.write(`${c.cyan(s.id)}  ${c.dim(s.updatedAt.slice(0, 16))}  ${s.title}${current}\n`);
        }
        break;
      }
      case "resume": {
        if (!args) { out.write(c.red("usage: /resume <id>   (see /sessions)") + "\n"); break; }
        const saved = opts.sessionStore.load(args);
        if (!saved) { out.write(c.red(`no session '${args}'`) + "\n"); break; }
        try {
          opts.agent.importSession(saved.session);
          opts.sessionId = saved.id;
          sessionTitle = saved.title;
          turns = saved.turns;
          out.write(c.dim(`resumed '${saved.title}' (${saved.turns} turns)`) + "\n");
        } catch (e: any) {
          out.write(c.red(`resume failed: ${e?.message ?? e}`) + "\n");
        }
        break;
      }
      default:
        out.write(c.red(`unknown command /${name} — try /help`) + "\n");
    }
  }

  await closed;
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function loadHistory(rl: readline.Interface, file: string): void {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    // readline keeps newest-first in .history
    (rl as any).history = lines.slice(-500).reverse();
  } catch {}
}

function saveHistory(rl: readline.Interface, file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const history: string[] = ((rl as any).history ?? []).slice(0, 500);
    fs.writeFileSync(file, [...history].reverse().join("\n") + "\n");
  } catch {}
}
