import * as path from "path";
import { spawn } from "child_process";
import { ToolDefinition } from "./types";

export interface ShellToolOptions {
  workspaceRoot: string;
  enabled?: boolean;
  allowlist?: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface WebSearchOptions {
  enabled?: boolean;
  apiKey?: string;
  maxResults?: number;
}

const DEFAULT_SHELL_TIMEOUT = 60_000;
const DEFAULT_SHELL_OUTPUT = 8_000;
const DEFAULT_WEB_RESULTS = 5;

export function shellTool(opts: ShellToolOptions): ToolDefinition {
  const enabled = opts.enabled ?? true;
  const allow = (opts.allowlist ?? []).map(s => s.trim()).filter(Boolean);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHELL_TIMEOUT;
  const maxOutput = opts.maxOutputChars ?? DEFAULT_SHELL_OUTPUT;
  return {
    name: "run-command",
    description:
      "Run a non-interactive shell command in the workspace root. Use for build/test/lint/git commands, reading runtime state, or running scripts. Commands run with stdin closed and a hard timeout; interactive prompts hang. Prefer single-line pipelines. Output is truncated to " +
      maxOutput +
      " chars.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run, e.g. 'npm test -- --reporter=dot'." },
        cwd: { type: "string", description: "Optional sub-directory relative to the workspace root." },
        timeout_ms: { type: "number", description: "Optional override, 1000..300000 ms. Default " + timeoutMs },
      },
      required: ["command"],
    },
    handler: async (args) => {
      if (!enabled) return "Shell execution is disabled. Enable openContext.agent.shell.enabled to use this tool.";
      const cmd = String(args.command ?? "").trim();
      if (!cmd) return "No command given.";
      if (allow.length) {
        const head = (cmd.match(/^[^\s|&;><]+/) || [""])[0];
        const base = head.split("/").pop() || head;
        if (!allow.includes(head) && !allow.includes(base)) {
          return `Command '${base}' is not in the allowlist [${allow.join(", ")}]. Update openContext.agent.shell.allowlist to permit it.`;
        }
      }
      const cwd = args.cwd ? path.resolve(opts.workspaceRoot, String(args.cwd)) : opts.workspaceRoot;
      const to = clamp(Number(args.timeout_ms ?? timeoutMs), 1000, 300_000);
      return runShell(cmd, cwd, to, maxOutput);
    },
  };
}

export function webSearchTool(opts: WebSearchOptions): ToolDefinition {
  const enabled = opts.enabled ?? true;
  const defaultResults = opts.maxResults ?? DEFAULT_WEB_RESULTS;
  return {
    name: "web-search",
    description:
      "Search the public web via Tavily. Returns ranked results with title, URL, and extracted content. Use for docs, library references, error messages, or facts not in the codebase. Requires a Tavily API key in settings.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        max_results: { type: "number", description: `1..10, default ${defaultResults}.` },
      },
      required: ["query"],
    },
    handler: async (args) => {
      if (!enabled) return "Web search is disabled. Enable openContext.agent.webSearch.enabled to use this tool.";
      const key = opts.apiKey;
      if (!key) return "Web search is unavailable: no Tavily API key set. Open the chat settings drawer and add one, or set TAVILY_API_KEY.";
      const query = String(args.query ?? "").trim();
      if (!query) return "No query given.";
      const n = clamp(Number(args.max_results ?? defaultResults), 1, 10);
      return tavilySearch(query, n, key);
    },
  };
}

async function runShell(cmd: string, cwd: string, timeoutMs: number, maxOutput: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    let err = "";
    let killed = false;
    const append = (buf: string, acc: "out" | "err") => {
      const cap = maxOutput;
      if (acc === "out") out = (out + buf).slice(0, cap * 2);
      else err = (err + buf).slice(0, cap * 2);
    };
    child.stdout.on("data", (b) => append(b.toString("utf8"), "out"));
    child.stderr.on("data", (b) => append(b.toString("utf8"), "err"));
    const timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const parts: string[] = [];
      parts.push(`$ ${cmd}`);
      parts.push(`cwd: ${cwd}`);
      parts.push(`exit: ${killed ? `killed (timeout ${timeoutMs}ms)` : code}`);
      if (out) parts.push(`--- stdout ---\n${truncate(out, maxOutput)}`);
      if (err) parts.push(`--- stderr ---\n${truncate(err, maxOutput)}`);
      if (!out && !err) parts.push("(no output)");
      resolve(parts.join("\n"));
    });
    child.on("error", (e) => { clearTimeout(timer); resolve(`Command failed to start: ${e.message}`); });
  });
}

async function tavilySearch(query: string, max: number, key: string): Promise<string> {
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: "basic", include_answer: true }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return `Tavily error ${resp.status}: ${t.slice(0, 300)}`;
    }
    const data: any = await resp.json();
    const answer = typeof data.answer === "string" && data.answer.trim() ? `Answer: ${data.answer.trim()}\n\n` : "";
    const results: any[] = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return `${answer}No results for: ${query}`;
    const rendered = results.map((r, i) => {
      const content = String(r.content ?? "").replace(/\s+/g, " ").trim();
      const trimmed = content.length > 600 ? content.slice(0, 600) + "…" : content;
      return `[${i + 1}] ${r.title || "(untitled)"}\n    ${r.url || ""}\n    ${trimmed}`;
    }).join("\n\n");
    return `${answer}${rendered}`;
  } catch (e: any) {
    return `Tavily request failed: ${e?.message ?? String(e)}`;
  }
}

function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, isFinite(n) ? n : lo)); }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + `\n… (truncated, ${s.length - n} chars dropped)` : s; }
