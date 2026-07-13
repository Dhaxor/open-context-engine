import { AgentMessage } from "./types";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function messageTokens(m: AgentMessage): number {
  let t = estimateTokens(m.content);
  for (const tc of m.toolCalls ?? []) {
    t += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.arguments));
  }
  return t + 4;
}

export function totalTokens(messages: AgentMessage[]): number {
  let sum = 0;
  for (const m of messages) sum += messageTokens(m);
  return sum;
}

export function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head - 80;
  const truncated = `${content.slice(0, head)}\n\n… [truncated ${content.length - maxChars} chars] …\n\n${content.slice(content.length - tail)}`;
  return truncated;
}

export interface CompactionResult {
  messages: AgentMessage[];
  droppedCount: number;
}

/** Partition history for summarizing compaction: the first user message and a
 *  recent tail (≤ tailBudget tokens) are kept verbatim; everything between is
 *  the "middle" that gets summarized. Pure — no LLM here. */
export interface CompactionSplit {
  firstUser: AgentMessage | null;
  middle: AgentMessage[];
  tail: AgentMessage[];
}

export function splitForCompaction(messages: AgentMessage[], tailBudget: number): CompactionSplit {
  const firstUserIdx = messages.findIndex(m => m.role === "user");
  const firstUser = firstUserIdx >= 0 ? messages[firstUserIdx] : null;
  const rest = messages.filter((_, i) => i !== firstUserIdx);
  const tail: AgentMessage[] = [];
  let tailTokens = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = messageTokens(rest[i]);
    if (tailTokens + t > tailBudget && tail.length > 0) break;
    tail.unshift(rest[i]);
    tailTokens += t;
  }
  const middle = rest.slice(0, rest.length - tail.length);
  repairOrphans(tail);
  return { firstUser, middle, tail };
}

/** Render messages into a plain-text transcript for the summarizer. Tool
 *  results are clipped hard — the summary needs what was LEARNED, not the
 *  full dumps that blew the budget in the first place. */
export function renderTranscript(messages: AgentMessage[], maxToolResultChars = 600): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(`USER: ${m.content}`);
    else if (m.role === "assistant") {
      if (m.content) lines.push(`ASSISTANT: ${m.content}`);
      for (const tc of m.toolCalls ?? []) lines.push(`ASSISTANT → tool ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 300)})`);
    } else if (m.role === "tool") {
      const body = m.content.length > maxToolResultChars ? m.content.slice(0, maxToolResultChars) + "…" : m.content;
      lines.push(`TOOL ${m.toolName ?? ""}: ${body}`);
    }
  }
  return lines.join("\n");
}

export function compactHistory(messages: AgentMessage[], budget: number): CompactionResult {
  if (messages.length <= 2) return { messages, droppedCount: 0 };
  let tokens = totalTokens(messages);
  if (tokens <= budget) return { messages, droppedCount: 0 };

  const firstUserIdx = messages.findIndex(m => m.role === "user");
  const preserved = firstUserIdx >= 0 ? [messages[firstUserIdx]] : [];
  const preservedSet = new Set(preserved);

  const tail: AgentMessage[] = [];
  let tailTokens = totalTokens(preserved);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (preservedSet.has(m)) continue;
    const t = messageTokens(m);
    if (tailTokens + t > budget && tail.length > 0) break;
    tail.unshift(m);
    tailTokens += t;
  }

  const kept = preserved.concat(tail.filter(m => !preservedSet.has(m)));
  repairOrphans(kept);
  const droppedCount = messages.length - kept.length;
  return { messages: kept, droppedCount };
}

function repairOrphans(messages: AgentMessage[]): void {
  const callIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const tc of m.toolCalls ?? []) callIds.add(tc.id);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.toolCallId && !callIds.has(m.toolCallId)) messages.splice(i, 1);
  }
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const resolved = new Set<string>();
      for (const other of messages) {
        if (other.role === "tool" && other.toolCallId) resolved.add(other.toolCallId);
      }
      m.toolCalls = m.toolCalls.filter(tc => resolved.has(tc.id));
      if (!m.toolCalls.length) delete m.toolCalls;
    }
  }
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export async function withRetry<T>(op: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 8000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      if (attempt >= opts.maxRetries || !isRetryable(err)) throw err;
      const delay = Math.min(cap, base * Math.pow(2, attempt)) + Math.floor(Math.random() * 200);
      opts.onRetry?.(attempt + 1, delay, extractReason(err));
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  const status = e.status ?? e.statusCode ?? e.response?.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  const code = e.code ?? "";
  if (["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET"].includes(code)) return true;
  const msg = String(e.message ?? e ?? "").toLowerCase();
  if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("socket hang up")) return true;
  return false;
}

function extractReason(err: unknown): string {
  const e = err as any;
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status) return `HTTP ${status}`;
  if (e?.code) return String(e.code);
  return (e?.message ?? String(err)).slice(0, 100);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Aborted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("Aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
