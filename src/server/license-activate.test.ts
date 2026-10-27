import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "crypto";
import { buildPayload, handleActivate, handleRequest, signToken } from "./license-activate";
import { verifyLicenseToken } from "../core/license";

/** The server module signs with a private key; the shipped verifier checks
 *  against the matching public half — round-trip both in-test. */
function testKeyPair(): { privPem: string; pubB64: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pubB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

const KEYS = testKeyPair();
const ENV = {
  POLAR_ACCESS_TOKEN: "pat_test",
  LICENSE_SIGNING_KEY: KEYS.privPem,
  POLAR_TEAM_BENEFIT_ID: "benefit_team",
  POLAR_ENTERPRISE_BENEFIT_ID: "benefit_ent",
};

function polarKeyFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  const key = { id: "pk_123", status: "granted", benefit: "benefit_team", ...overrides };
  return vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/activations") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "act_1" }), { status: 201 });
    }
    return new Response(JSON.stringify(key), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => { vi.stubGlobal("fetch", polarKeyFetch()); });
afterEach(() => { vi.unstubAllGlobals(); });

function activateRequest(body: unknown): Request {
  return new Request("https://site.example/api/license/activate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("handleActivate", () => {
  it("exchanges a valid Polar key for a token the offline verifier accepts", async () => {
    const res = await handleActivate(activateRequest({ licenseKey: "polar_lk_abc123def", email: "dev@acme.com" }), ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toBe("team");
    const status = verifyLicenseToken(body.token, { publicKey: KEYS.pubB64, now: body.exp ? undefined : undefined });
    expect(status.valid).toBe(true);
    expect(status.payload?.orgDomain).toBe("acme.com");
    expect(status.payload?.email).toBe("dev@acme.com");
  });

  it("does not bind consumer mail domains as org domains", async () => {
    const res = await handleActivate(activateRequest({ licenseKey: "polar_lk_abc123def", email: "someone@gmail.com" }), ENV);
    const body = await res.json();
    const status = verifyLicenseToken(body.token, { publicKey: KEYS.pubB64 });
    expect(status.valid).toBe(true);
    expect(status.payload?.orgDomain).toBeUndefined();
    expect(status.payload?.org).toBe("gmail.com");
  });

  it("maps the enterprise benefit to the enterprise plan", async () => {
    vi.stubGlobal("fetch", polarKeyFetch({ benefit: "benefit_ent" }));
    const res = await handleActivate(activateRequest({ licenseKey: "polar_lk_abc123def", email: "dev@acme.com" }), ENV);
    const body = await res.json();
    expect(body.plan).toBe("enterprise");
  });

  it("rejects a revoked Polar key with 403", async () => {
    vi.stubGlobal("fetch", polarKeyFetch({ status: "revoked" }));
    const res = await handleActivate(activateRequest({ licenseKey: "polar_lk_abc123def", email: "dev@acme.com" }), ENV);
    expect(res.status).toBe(403);
  });

  it("rejects an unknown Polar key with 400, not 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch);
    const res = await handleActivate(activateRequest({ licenseKey: "polar_lk_abc123def", email: "dev@acme.com" }), ENV);
    expect(res.status).toBe(400);
  });

  it("rejects malformed input before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const noKey = await handleActivate(activateRequest({ email: "dev@acme.com" }), ENV);
    const badEmail = await handleActivate(activateRequest({ licenseKey: "polar_lk_abc123def", email: "not-an-email" }), ENV);
    expect(noKey.status).toBe(400);
    expect(badEmail.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("503s with an actionable message when the server is unconfigured", async () => {
    const res = await handleActivate(activateRequest({ licenseKey: "polar_lk_abc123def", email: "dev@acme.com" }), {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toMatch(/not configured/);
  });
});

describe("handleRequest routing", () => {
  const assets = { fetch: async (r: Request) => new Response("asset:" + new URL(r.url).pathname, { status: 200 }) };
  const env = { ...ENV, ASSETS: assets };

  it("routes /api/license/activate to the handler", async () => {
    const res = await handleRequest(activateRequest({ licenseKey: "polar_lk_abc123def", email: "dev@acme.com" }), env as any);
    expect(res.status).toBe(200);
  });

  it("404s unknown API paths instead of leaking into assets", async () => {
    const res = await handleRequest(new Request("https://site.example/api/nope"), env as any);
    expect(res.status).toBe(404);
  });

  it("serves everything else from the static assets binding", async () => {
    const res = await handleRequest(new Request("https://site.example/pricing.html"), env as any);
    expect(await res.text()).toBe("asset:/pricing.html");
  });

  it("accepts only POST on the activate endpoint", async () => {
    const res = await handleRequest(new Request("https://site.example/api/license/activate"), env as any);
    expect(res.status).toBe(405);
  });
});

describe("buildPayload details", () => {
  it("carries seat metadata from Polar when present", () => {
    const p = buildPayload({ id: "pk_1", status: "granted", benefit: "b", metadata: { seats: 7 } }, { licenseKey: "k", email: "a@acme.com" }, ENV);
    expect(p.seats).toBe(7);
  });

  it("derives a stable id when Polar omits one", () => {
    const p1 = buildPayload({ status: "granted" }, { licenseKey: "same-key", email: "a@acme.com" }, ENV);
    const p2 = buildPayload({ status: "granted" }, { licenseKey: "same-key", email: "b@acme.com" }, ENV);
    expect(p1.id).toBe(p2.id);
    expect(p1.id.startsWith("pol_")).toBe(true);
  });

  it("signToken output is exactly two base64url segments", () => {
    const token = signToken({ id: "x", org: "o", plan: "team", seats: 1, iat: 1, exp: 2 }, KEYS.privPem);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[\w-]+$/);
    expect(parts[1]).toMatch(/^[\w-]+$/);
  });
});
