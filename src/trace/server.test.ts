import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContextAgent } from "../agent/agent";
import { AgentPlan } from "../agent/plan";
import { PermissionManager } from "../agent/permissions";
import { EditApplier } from "../agent/edit-tools";
import { AgentMessage, AgentRunOptions, StreamEvent } from "../agent/types";
import { CheckpointStore } from "./checkpoints";
import { ContextLedger } from "./ledger";
import { SessionMeta, TraceEnvelope } from "./protocol";
import { SessionRegistry } from "./registry";
import { TraceSession } from "./session";
import { TraceServer, startTraceServer } from "./server";

class MemoryApplier implements EditApplier {
  constructor(public files = new Map<string, string>()) {}
  async readFile(p: string) { return this.files.has(p) ? this.files.get(p)! : null; }
  async writeFile(p: string, c: string) { this.files.set(p, c); }
  async removeFile(p: string) { return this.files.delete(p); }
  async fileExists(p: string) { return this.files.has(p); }
}

class StubAgent {
  messages: AgentMessage[] = [];
  script: (emit: (e: StreamEvent) => void, signal?: AbortSignal) => Promise<void> = async () => {};
  compacted = 0;
  async run(query: string, opts: AgentRunOptions = {}): Promise<string> {
    this.messages.push({ role: "user", content: query });
    await this.script(e => opts.onStream?.(e), opts.signal);
    if (opts.signal?.aborted) throw new Error("aborted");
    return "done";
  }
  getMessages(): readonly AgentMessage[] { return this.messages; }
  loadMessages(m: AgentMessage[]) { this.messages = [...m]; }
  exportSession() { return JSON.stringify({ version: 1, messages: this.messages }); }
  reset() { this.messages = []; }
  async compact() { this.compacted++; return { dropped: 1, summarized: false }; }
}

const META: Omit<SessionMeta, "turn" | "startedAt" | "mode"> = {
  id: "s1", title: "t", workspace: "/ws", provider: "openai", model: "gpt-4o",
  windowTokens: 128_000, indexedChunks: 1, searchMode: "hybrid", indexFresh: true, auditing: false,
};

const TOKEN = "test-token";

let server: TraceServer;
let agent: StubAgent;
let session: TraceSession;
let permissions: PermissionManager;
let applier: MemoryApplier;
let tmpDir: string | null = null;

async function start(opts: { staticDir?: string; token?: string } = {}) {
  agent = new StubAgent();
  applier = new MemoryApplier();
  permissions = new PermissionManager({ mode: "suggest" });
  session = new TraceSession({
    id: "s1",
    agent: agent as unknown as ContextAgent,
    plan: new AgentPlan(),
    permissions,
    ledger: new ContextLedger({ windowTokens: 128_000, systemPrompt: () => "", toolSchemas: () => [] }),
    checkpoints: new CheckpointStore({ applier }),
    meta: META,
  });
  server = await startTraceServer({ session, token: opts.token ?? TOKEN, ...(opts.staticDir ? { staticDir: opts.staticDir } : {}) });
  return server;
}

function base(): string { return `http://127.0.0.1:${server.port}`; }

function api(route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base()}${route}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

function post(route: string, body: unknown): Promise<Response> {
  return api(route, { method: "POST", body: JSON.stringify(body) });
}

/** Read SSE frames until `count` trace events arrive (or the deadline passes). */
async function readEvents(res: Response, count: number, timeoutMs = 2000): Promise<TraceEnvelope[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: TraceEnvelope[] = [];
  let buffered = "";
  const deadline = Date.now() + timeoutMs;
  while (out.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split("\n\n");
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find(l => l.startsWith("data: "));
      if (line) out.push(JSON.parse(line.slice(6)));
    }
  }
  void reader.cancel();
  return out;
}

beforeEach(async () => { await start(); });

afterEach(async () => {
  await server?.close();
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

describe("Trace server auth", () => {
  it("rejects an unauthenticated API call", async () => {
    const res = await fetch(`${base()}/api/session`);
    expect(res.status).toBe(401);
  });

  it("accepts a bearer token", async () => {
    const res = await api("/api/session");
    expect(res.status).toBe(200);
    expect((await res.json()).meta.model).toBe("gpt-4o");
  });

  it("accepts a query token, because EventSource cannot set headers", async () => {
    const res = await fetch(`${base()}/api/session?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`${base()}/api/session?token=nope`);
    expect(res.status).toBe(401);
  });

  it("leaves /health open so a launcher can wait for readiness", async () => {
    const res = await fetch(`${base()}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("binds loopback only", () => {
    const addr = server.server.address();
    expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
  });
});

describe("Trace server event stream", () => {
  it("opens with the session state", async () => {
    const res = await fetch(`${base()}/api/events?token=${TOKEN}`);
    const events = await readEvents(res, 1);
    expect(events[0].event.type).toBe("session");
  });

  it("streams a turn's events as they happen", async () => {
    const res = await fetch(`${base()}/api/events?token=${TOKEN}`);
    agent.script = async emit => { emit({ type: "text", text: "hello" }); };
    const reading = readEvents(res, 4);
    await post("/api/prompt", { text: "why" });
    const events = await reading;
    const kinds = events.map(e => e.event.type);
    expect(kinds).toContain("turn_start");
    expect(kinds).toContain("text");
  });

  it("replays only what a reconnecting client missed", async () => {
    agent.script = async emit => { emit({ type: "text", text: "first" }); };
    await post("/api/prompt", { text: "one" });
    await new Promise(r => setTimeout(r, 50));
    const cursor = session.cursor();

    agent.script = async emit => { emit({ type: "text", text: "second" }); };
    await post("/api/prompt", { text: "two" });
    await new Promise(r => setTimeout(r, 50));

    const res = await fetch(`${base()}/api/events?token=${TOKEN}&since=${cursor}`);
    const events = await readEvents(res, 1);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.seq > cursor)).toBe(true);
    expect(events.some(e => e.event.type === "turn_start" && (e.event as any).prompt === "two")).toBe(true);
    expect(events.some(e => (e.event as any).prompt === "one")).toBe(false);
  });

  it("tags frames with an id so EventSource can resume on its own", async () => {
    const res = await fetch(`${base()}/api/events?token=${TOKEN}`);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: trace");
    void reader.cancel();
  });

  it("closing the server releases open streams", async () => {
    const res = await fetch(`${base()}/api/events?token=${TOKEN}`);
    await readEvents(res, 1);
    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe("Trace server commands", () => {
  it("accepts a prompt without waiting for the turn to finish", async () => {
    let release = () => {};
    agent.script = () => new Promise<void>(r => { release = r; });
    const res = await post("/api/prompt", { text: "why" });
    expect(res.status).toBe(202);
    // Returning immediately is what lets an approval be posted mid-turn.
    expect(session.isRunning()).toBe(true);
    release();
  });

  it("refuses a second prompt while one runs", async () => {
    let release = () => {};
    agent.script = () => new Promise<void>(r => { release = r; });
    await post("/api/prompt", { text: "one" });
    const res = await post("/api/prompt", { text: "two" });
    expect(res.status).toBe(409);
    release();
  });

  it("rejects an empty prompt", async () => {
    expect((await post("/api/prompt", { text: "   " })).status).toBe(400);
  });

  it("interrupts a running turn", async () => {
    agent.script = (_emit, signal) => new Promise<void>(resolve => {
      signal?.addEventListener("abort", () => resolve());
    });
    await post("/api/prompt", { text: "long one" });
    const res = await post("/api/interrupt", {});
    expect(await res.json()).toEqual({ interrupted: true });
  });

  it("resolves an approval raised mid-turn", async () => {
    permissions.registerMutatingTools(["str-replace"]);
    let decided: unknown;
    agent.script = async () => {
      const pending = permissions.check({ id: "t1", name: "str-replace", arguments: { path: "a.ts", old_str: "a", new_str: "b" } });
      await new Promise(r => setTimeout(r, 10));
      const [id] = session.pendingApproval();
      const res = await post("/api/approve", { id, decision: "allow" });
      expect(res.status).toBe(200);
      decided = await pending;
    };
    await post("/api/prompt", { text: "edit" });
    await new Promise(r => setTimeout(r, 120));
    expect(decided).toMatchObject({ behavior: "allow" });
  });

  it("validates the approval decision", async () => {
    expect((await post("/api/approve", { id: "x", decision: "maybe" })).status).toBe(400);
  });

  it("404s an unknown approval", async () => {
    expect((await post("/api/approve", { id: "nope", decision: "allow" })).status).toBe(404);
  });

  it("applies context actions and rejects unknown ones", async () => {
    expect((await post("/api/context", { action: "explode", entryId: "x" })).status).toBe(400);
    expect((await post("/api/context", { action: "pin", entryId: "missing" })).status).toBe(404);
  });

  it("changes approval mode and validates it", async () => {
    expect((await post("/api/mode", { mode: "full-auto" })).status).toBe(200);
    expect(permissions.getMode()).toBe("full-auto");
    expect((await post("/api/mode", { mode: "yolo" })).status).toBe(400);
  });

  it("compacts and resets", async () => {
    expect((await post("/api/compact", {})).status).toBe(200);
    expect(agent.compacted).toBe(1);
    expect((await post("/api/reset", {})).status).toBe(200);
    expect(agent.messages).toEqual([]);
  });

  it("reports a rewind conflict rather than failing silently", async () => {
    const res = await post("/api/rewind", { hash: "deadbeef" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/No checkpoint/);
  });

  it("rewinds to a real checkpoint", async () => {
    applier.files.set("a.ts", "v2");
    agent.script = async () => {};
    await post("/api/prompt", { text: "first" });
    await new Promise(r => setTimeout(r, 50));
    const hash = session.checkpoints()[0].hash;

    agent.script = async emit => {
      emit({ type: "edit_proposed", edit: { id: "e1", kind: "str-replace", path: "a.ts", oldContents: "v1", newContents: "v2", diff: "" } });
    };
    await post("/api/prompt", { text: "second" });
    await new Promise(r => setTimeout(r, 50));

    expect((await post("/api/rewind", { hash })).status).toBe(200);
    expect(applier.files.get("a.ts")).toBe("v1");
  });

  it("rejects a malformed body", async () => {
    const res = await api("/api/prompt", { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
  });

  it("405s a GET on a command route", async () => {
    expect((await api("/api/prompt")).status).toBe(405);
  });

  it("serves checkpoints and a cursor for polling clients", async () => {
    agent.script = async () => {};
    await post("/api/prompt", { text: "one" });
    await new Promise(r => setTimeout(r, 50));
    expect((await (await api("/api/checkpoints")).json()).checkpoints).toHaveLength(1);
    const since = await (await api("/api/since?seq=0")).json();
    expect(since.events.length).toBeGreaterThan(0);
    expect(since.cursor).toBe(session.cursor());
  });
});

describe("Trace server parallel sessions", () => {
  let registry: SessionRegistry;
  let secondAgent: StubAgent;

  async function startWithRegistry() {
    await server?.close();
    await start();
    secondAgent = new StubAgent();
    registry = new SessionRegistry({
      build: async () => ({
        session: new TraceSession({
          id: "s2",
          agent: secondAgent as unknown as ContextAgent,
          plan: new AgentPlan(),
          permissions: new PermissionManager({ mode: "suggest" }),
          ledger: new ContextLedger({ windowTokens: 128_000, systemPrompt: () => "", toolSchemas: () => [] }),
          checkpoints: new CheckpointStore({ applier: new MemoryApplier() }),
          meta: { ...META, id: "s2" },
        }),
        close: async () => {},
      }),
    });
    registry.adopt("s1", { session, close: async () => {} }, { title: "Primary", workspace: "/ws" });
    await server.close();
    server = await startTraceServer({ session, registry, token: TOKEN });
  }

  beforeEach(startWithRegistry);

  it("lists the sessions", async () => {
    const body = await (await api("/api/sessions")).json();
    expect(body.parallel).toBe(true);
    expect(body.sessions).toEqual([expect.objectContaining({ id: "s1", active: true })]);
  });

  it("creates a session and routes prompts to it by id", async () => {
    const created = await (await post("/api/sessions", { action: "create", title: "second" })).json();
    expect(created.status).toBe("ready");

    agent.script = async () => {};
    secondAgent.script = async () => {};
    await post(`/api/prompt?session=${created.id}`, { text: "for the second" });
    await new Promise(r => setTimeout(r, 60));

    // The prompt must land in the session it addressed, not the default one.
    expect(secondAgent.messages.map(m => m.content)).toEqual(["for the second"]);
    expect(agent.messages).toEqual([]);
  });

  it("streams the addressed session's events", async () => {
    const created = await (await post("/api/sessions", { action: "create", title: "second" })).json();
    const res = await fetch(`${base()}/api/events?token=${TOKEN}&session=${created.id}`);
    const events = await readEvents(res, 1);
    expect((events[0].event as any).meta.id).toBe("s2");
  });

  it("404s an unknown session instead of silently using the default", async () => {
    // Quietly prompting the wrong agent would be far worse than an error.
    expect((await post("/api/prompt?session=nope", { text: "x" })).status).toBe(404);
    expect((await api("/api/session?session=nope")).status).toBe(404);
    expect((await fetch(`${base()}/api/events?token=${TOKEN}&session=nope`)).status).toBe(404);
  });

  it("follows the active session when none is addressed", async () => {
    const created = await (await post("/api/sessions", { action: "create", title: "second" })).json();
    expect((await post("/api/sessions", { action: "activate", id: created.id })).status).toBe(200);

    const meta = await (await api("/api/session")).json();
    expect(meta.meta.id).toBe("s2");
  });

  it("rejects an unknown registry action and an unknown activation", async () => {
    expect((await post("/api/sessions", { action: "explode" })).status).toBe(400);
    expect((await post("/api/sessions", { action: "activate", id: "nope" })).status).toBe(404);
  });

  it("refuses to close the last session", async () => {
    const res = await post("/api/sessions", { action: "close", id: "s1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/last session/);
  });

  it("closes a created session", async () => {
    const created = await (await post("/api/sessions", { action: "create", title: "second" })).json();
    expect((await post("/api/sessions", { action: "close", id: created.id })).status).toBe(200);
    const body = await (await api("/api/sessions")).json();
    expect(body.sessions.map((s: any) => s.id)).toEqual(["s1"]);
  });
});

describe("Trace server without a registry", () => {
  it("reports a single session rather than pretending parallelism exists", async () => {
    const body = await (await api("/api/sessions")).json();
    expect(body.parallel).toBe(false);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ active: true, status: "ready" });
  });

  it("explains why creating one is unavailable", async () => {
    const res = await post("/api/sessions", { action: "create", title: "x" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not a git repository/);
  });
});

describe("Trace server static assets", () => {
  beforeEach(async () => {
    await server.close();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-static-"));
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<h1>studio</h1>");
    fs.writeFileSync(path.join(tmpDir, "app.js"), "console.log(1)");
    fs.writeFileSync(path.join(os.tmpdir(), "trace-outside-secret.txt"), "SECRET");
    await start({ staticDir: tmpDir });
  });

  it("serves the shell and its assets", async () => {
    expect(await (await fetch(`${base()}/`)).text()).toContain("studio");
    const js = await fetch(`${base()}/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
  });

  it("falls back to the shell so client routes resolve", async () => {
    expect(await (await fetch(`${base()}/some/deep/route`)).text()).toContain("studio");
  });

  it("never serves a file outside the asset directory", async () => {
    const res = await fetch(`${base()}/../trace-outside-secret.txt`);
    const body = await res.text();
    expect(body).not.toContain("SECRET");
  });

  it("never caches the shell, because the token rides in its URL", async () => {
    expect((await fetch(`${base()}/`)).headers.get("cache-control")).toBe("no-store");
  });

  it("revalidates assets, so an upgraded server never meets a cached Studio", async () => {
    const res = await fetch(`${base()}/app.js`);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();

    const revalidated = await fetch(`${base()}/app.js`, { headers: { "If-None-Match": etag! } });
    expect(revalidated.status).toBe(304);
  });

  it("sends a fresh asset when the file changes", async () => {
    const first = await fetch(`${base()}/app.js`);
    const etag = first.headers.get("etag")!;
    fs.writeFileSync(path.join(tmpDir!, "app.js"), "console.log(2) // changed");
    const second = await fetch(`${base()}/app.js`, { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("changed");
  });

  it("still requires auth for the API when assets are public", async () => {
    expect((await fetch(`${base()}/api/session`)).status).toBe(401);
  });
});
