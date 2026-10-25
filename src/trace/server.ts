/**
 * The Trace server — one local HTTP endpoint that every Trace surface talks to.
 *
 * Studio (browser), the desktop shell, and any future client subscribe to the
 * same SSE stream and post the same commands. Built on Node's own `http` with
 * no framework: the MCP transport here already proves the pattern
 * (mcp/server.ts), and a local-first tool has no business pulling a web stack
 * into its dependency tree.
 *
 * Two decisions matter more than the routing:
 *
 *   Replay. `GET /api/events?since=<seq>` resumes exactly where a dropped
 *   connection left off. Sessions that quietly lose their state when a socket
 *   blinks are the loudest complaint about comparable harnesses; the cursor is
 *   the whole fix and it costs one query parameter.
 *
 *   Loopback plus a per-launch token. The server can drive the agent — edit
 *   files, run shell commands — so it binds 127.0.0.1 only and mints a fresh
 *   bearer token each start. The token travels in the URL the CLI opens, so
 *   nothing on the machine can drive your agent by guessing a port.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { ApprovalDecision, ApprovalMode } from "../agent/permissions";
import { SessionRegistry } from "./registry";
import { TraceSession } from "./session";
import { TraceEnvelope } from "./protocol";

export interface TraceServerOptions {
  /** The primary session. Also the default when no `session` is addressed. */
  session: TraceSession;
  /** Present when parallel sessions are available. Absent = single-session. */
  registry?: SessionRegistry;
  /** 0 picks a free port — the CLI reads the real one back from `address()`. */
  port?: number;
  host?: string;
  /** Omit to mint one. Pass "" to disable auth (tests only). */
  token?: string;
  /** Directory of built Studio assets. Absent = API only. */
  staticDir?: string;
  onLog?: (message: string) => void;
}

export interface TraceServer {
  url: string;
  port: number;
  token: string;
  server: http.Server;
  close: () => Promise<void>;
}

/** POST-only routes, so a GET against one answers 405 rather than 404. */
const COMMAND_ROUTES = new Set([
  "/api/prompt", "/api/interrupt", "/api/approve", "/api/context",
  "/api/rewind", "/api/mode", "/api/compact", "/api/reset",
  "/api/shell", "/api/mention",
  // /api/sessions answers GET too, so it is deliberately absent here.
]);

const APPROVAL_DECISIONS = new Set<ApprovalDecision>(["allow", "always", "deny"]);
const APPROVAL_MODES = new Set<ApprovalMode>(["suggest", "auto-edit", "full-auto"]);
/** Comfortably under the 30s most proxies idle out at, and cheap. */
const HEARTBEAT_MS = 15_000;

export async function startTraceServer(opts: TraceServerOptions): Promise<TraceServer> {
  const { session } = opts;
  const token = opts.token ?? crypto.randomBytes(24).toString("base64url");

  /**
   * Which session a request addresses. `?session=<id>` selects one explicitly;
   * otherwise the registry's active session, falling back to the primary. An
   * unknown id is an error rather than a silent fall-through to the default —
   * quietly prompting the wrong agent would be much worse than a 404.
   */
  const resolveSession = (url: URL): { session?: TraceSession; error?: string } => {
    const id = url.searchParams.get("session");
    if (!id) return { session: opts.registry?.active() ?? session };
    const found = opts.registry?.get(id);
    return found ? { session: found } : { error: `No session ${id}` };
  };
  const host = opts.host ?? "127.0.0.1";
  const log = opts.onLog ?? (() => {});
  const openStreams = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(err => {
      const message = failureMessage(err);
      log(`trace server error: ${message}`);
      // The real reason, not "Internal error". This endpoint is loopback-only
      // and token-gated, so there is nobody to leak it to — and an opaque 500
      // turns a one-line diagnosis into an expedition.
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = url.pathname;

    if (route === "/health") return sendJson(res, 200, { ok: true });

    if (route.startsWith("/api/")) {
      // EventSource cannot set headers, so the stream accepts the token as a
      // query parameter. It never leaves the loopback interface.
      if (!authorized(req, url, token)) return sendJson(res, 401, { error: "Unauthorized" });
      return route === "/api/events" && req.method === "GET"
        ? streamEvents(req, res, url)
        : handleApi(req, res, url, route);
    }

    if (opts.staticDir) return serveStatic(res, opts.staticDir, route, req.headers["if-none-match"]);
    return sendJson(res, 404, { error: "Not found" });
  }

  function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const target = resolveSession(url);
    if (!target.session) return sendJson(res, 404, { error: target.error });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Node buffers small writes; SSE needs them out immediately.
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const raw = url.searchParams.get("since");
    const since = raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    const unsubscribe = target.session.subscribe(env => writeEvent(res, env), since);

    const heartbeat = setInterval(() => {
      // A comment frame keeps the connection warm without entering the event
      // stream, so clients never see a synthetic message.
      try { res.write(": ping\n\n"); } catch {}
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    openStreams.add(res);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      openStreams.delete(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, route: string): Promise<void> {
    if (req.method === "GET") {
      // The session list is about the registry, not about any one session.
      if (route === "/api/sessions") {
        if (!opts.registry) {
          return sendJson(res, 200, { sessions: [{ ...soloSummary(session) }], parallel: false });
        }
        await opts.registry.refreshChanges();
        return sendJson(res, 200, { sessions: opts.registry.list(), parallel: true });
      }

      const target = resolveSession(url);
      if (!target.session) return sendJson(res, 404, { error: target.error });
      const s = target.session;
      switch (route) {
        case "/api/session":
          return sendJson(res, 200, { meta: s.meta(), phase: s.getPhase(), cursor: s.cursor() });
        case "/api/checkpoints":
          return sendJson(res, 200, { checkpoints: s.checkpoints() });
        case "/api/since": {
          const seq = Number(url.searchParams.get("seq") ?? 0);
          return sendJson(res, 200, { events: s.since(Number.isFinite(seq) ? seq : 0), cursor: s.cursor() });
        }
        case "/api/files":
          // Answers per keystroke for the composer's `@` menu, so it stays a
          // ranked lookup over already-indexed paths — never a disk walk.
          return sendJson(res, 200, { files: s.files(url.searchParams.get("q") ?? "") });
        default:
          // A command route reached with the wrong verb is a client bug worth
          // naming, not a missing endpoint.
          return COMMAND_ROUTES.has(route)
            ? sendMethodNotAllowed(res)
            : sendJson(res, 404, { error: "Not found" });
      }
    }
    if (req.method !== "POST") return sendMethodNotAllowed(res);

    let body: any;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { error: "Malformed JSON body" });
    }

    if (route === "/api/sessions") return handleRegistry(res, body);

    const target = resolveSession(url);
    if (!target.session) return sendJson(res, 404, { error: target.error });
    const s = target.session;

    switch (route) {
      case "/api/prompt": {
        const text = String(body?.text ?? "").trim();
        if (!text) return sendJson(res, 400, { error: "text is required" });
        if (s.isRunning()) return sendJson(res, 409, { error: "A turn is already running" });
        // Answer immediately: the turn's progress is the event stream's job, and
        // holding the request open would stall a client that also needs to POST
        // an approval to let that same turn finish.
        void s.prompt(text).catch(err => log(`turn failed: ${err?.message ?? err}`));
        return sendJson(res, 202, { accepted: true, cursor: s.cursor() });
      }
      case "/api/interrupt":
        return sendJson(res, 200, { interrupted: s.interrupt() });
      case "/api/approve": {
        const id = String(body?.id ?? "");
        const decision = String(body?.decision ?? "") as ApprovalDecision;
        if (!APPROVAL_DECISIONS.has(decision)) {
          return sendJson(res, 400, { error: "decision must be allow, always, or deny" });
        }
        const ok = s.approve(id, decision);
        return sendJson(res, ok ? 200 : 404, ok ? { resolved: true } : { error: "No such pending approval" });
      }
      case "/api/context": {
        const action = String(body?.action ?? "");
        const entryId = String(body?.entryId ?? "");
        const apply = { pin: s.pin, unpin: s.unpin, evict: s.evict, restore: s.restore } as const;
        const fn = apply[action as keyof typeof apply];
        if (!fn) return sendJson(res, 400, { error: "action must be pin, unpin, evict, or restore" });
        const ok = fn.call(s, entryId);
        return sendJson(res, ok ? 200 : 404, ok ? { applied: true } : { error: "No such context entry" });
      }
      case "/api/rewind": {
        const hash = String(body?.hash ?? "");
        try {
          await s.rewind(hash);
          return sendJson(res, 200, { rewound: true });
        } catch (err) {
          return sendJson(res, 409, { error: failureMessage(err) });
        }
      }
      case "/api/mode": {
        const mode = String(body?.mode ?? "") as ApprovalMode;
        if (!APPROVAL_MODES.has(mode)) {
          return sendJson(res, 400, { error: "mode must be suggest, auto-edit, or full-auto" });
        }
        s.setMode(mode);
        return sendJson(res, 200, { mode });
      }
      case "/api/compact":
        try {
          await s.compact();
          return sendJson(res, 200, { compacted: true });
        } catch (err) {
          return sendJson(res, 500, { error: failureMessage(err) });
        }
      case "/api/shell": {
        const command = String(body?.command ?? "").trim();
        if (!command) return sendJson(res, 400, { error: "command is required" });
        // Like /api/prompt: answer immediately. The command may raise an
        // approval, and holding the request open would deadlock the client
        // that has to answer it.
        void s.runShell(command).catch(err => log(`shell failed: ${err?.message ?? err}`));
        return sendJson(res, 202, { accepted: true });
      }
      case "/api/mention": {
        const paths = Array.isArray(body?.paths) ? body.paths.map(String) : [];
        if (!paths.length) return sendJson(res, 400, { error: "paths is required" });
        return sendJson(res, 200, await s.mention(paths));
      }
      case "/api/reset":
        s.reset();
        return sendJson(res, 200, { reset: true });
      default:
        return sendJson(res, 404, { error: "Not found" });
    }
  }

  /**
   * Create, switch, and close sessions. One route with an `action` rather than
   * four: the set is small, and the client already posts JSON everywhere else.
   */
  async function handleRegistry(res: http.ServerResponse, body: any): Promise<void> {
    const registry = opts.registry;
    if (!registry) return sendJson(res, 409, { error: "This workspace is not a git repository, so parallel sessions are unavailable." });

    const action = String(body?.action ?? "");
    switch (action) {
      case "create": {
        const title = String(body?.title ?? "").trim() || "Untitled session";
        try {
          const entry = await registry.create(title);
          // 202 even on a failed start: the entry exists and carries the reason,
          // which is more useful to render than a bare error.
          return sendJson(res, 202, { id: entry.id, status: entry.status, error: entry.error });
        } catch (err) {
          return sendJson(res, 409, { error: failureMessage(err) });
        }
      }
      case "review": {
        const result = await registry.review(String(body?.id ?? ""));
        return "error" in result ? sendJson(res, 404, result) : sendJson(res, 200, result);
      }
      case "land": {
        const result = await registry.land(String(body?.id ?? ""), {
          ...(body?.target ? { target: String(body.target) } : {}),
          ...(body?.message ? { message: String(body.message) } : {}),
        });
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      case "activate": {
        const ok = registry.setActive(String(body?.id ?? ""));
        return sendJson(res, ok ? 200 : 404, ok ? { active: body.id } : { error: "No such session" });
      }
      case "close": {
        const result = await registry.close(String(body?.id ?? ""), { discardChanges: !!body?.discardChanges });
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      default:
        return sendJson(res, 400, { error: "action must be create, activate, review, land, or close" });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  const url = `http://${host}:${port}${token ? `/#token=${token}` : "/"}`;
  log(`Trace listening on http://${host}:${port}`);

  return {
    url,
    port,
    token,
    server,
    close: async () => {
      // Open SSE responses keep the server alive forever otherwise.
      for (const res of openStreams) { try { res.end(); } catch {} }
      openStreams.clear();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}

export function writeEvent(res: http.ServerResponse, env: TraceEnvelope): void {
  try {
    // `id:` lets a browser EventSource resume via Last-Event-ID; `since` covers
    // clients that reconnect deliberately.
    res.write(`id: ${env.seq}\nevent: trace\ndata: ${JSON.stringify(env)}\n\n`);
  } catch {}
}

/** The single-session shape, so a client can render one switcher either way. */
function soloSummary(session: TraceSession) {
  const meta = session.meta();
  return {
    id: meta.id,
    title: meta.title || "Session",
    status: "ready" as const,
    workspace: meta.workspace,
    createdAt: meta.startedAt,
    changedFiles: 0,
    running: session.isRunning(),
    turn: meta.turn,
    active: true,
  };
}

/**
 * What a client is told about a failure: an Error's message and nothing else.
 * Never the stack, and never a thrown non-Error, which can carry anything.
 */
function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

function sendMethodNotAllowed(res: http.ServerResponse): void {
  res.setHeader("Allow", "POST");
  sendJson(res, 405, { error: "Method not allowed" });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    // The API drives file edits and shell commands; nothing should cache it.
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Serve the Studio bundle, falling back to index.html so client-side routes
 * resolve. Paths are resolved and then checked against the root, so a crafted
 * `../` cannot read outside the asset directory.
 */
function serveStatic(res: http.ServerResponse, root: string, route: string, ifNoneMatch?: string): void {
  const rel = route === "/" ? "index.html" : route.replace(/^\/+/, "");
  const resolved = path.resolve(root, rel);
  const withinRoot = resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep);
  const target = withinRoot && isFile(resolved) ? resolved : path.resolve(root, "index.html");

  if (!isFile(target)) {
    return sendJson(res, 404, { error: "Studio assets are not built. Run `npm run build:studio`." });
  }
  const ext = path.extname(target).toLowerCase();
  try {
    const stat = fs.statSync(target);
    // Revalidate every load. The bundle filename is stable across releases, so
    // any positive max-age lets an upgraded `oce` serve a new API to a Studio
    // the browser cached from the previous version — a mismatch that presents
    // as baffling missing data rather than as an error. An ETag keeps the cost
    // of that correctness at one 304 on localhost.
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
      res.end();
      return;
    }
    const body = fs.readFileSync(target);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": body.length,
      ETag: etag,
      // The token lives in the URL fragment; never let the shell be stored.
      "Cache-Control": ext === ".html" ? "no-store" : "no-cache",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
