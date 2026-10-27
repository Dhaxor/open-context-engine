/**
 * Server-side license activation: exchange a Polar license key for a signed
 * OCE license token.
 *
 * Runs on the Cloudflare Worker that also serves the marketing site (see
 * worker.ts). Polar emails the customer a license key automatically on
 * purchase ("License Key" benefit); `oce activate <polar_lk_...>` posts it
 * here. This service validates the key against Polar's API (entitlement truth
 * stays with the payment processor), then issues an offline-verifiable token
 * in exactly the format src/core/license.ts verifies — the customer's machine
 * never needs the network again.
 *
 * Secrets (Worker env):
 *   LICENSE_SIGNING_KEY  PKCS8 PEM of the Ed25519 key whose public half is
 *                        EMBEDDED_PUBLIC_KEY_B64 in src/core/license.ts.
 *   POLAR_ACCESS_TOKEN   Polar API token with license-key read/activate scope.
 * Optional:
 *   POLAR_TEAM_BENEFIT_ID / POLAR_ENTERPRISE_BENEFIT_ID  plan mapping
 *   DEFAULT_SEATS (default 1), LICENSE_DAYS (default 365)
 */
import * as crypto from "crypto";
import { LicensePayload } from "../core/license-types";

export interface ActivateEnv {
  POLAR_ACCESS_TOKEN?: string;
  LICENSE_SIGNING_KEY?: string;
  POLAR_API?: string;
  POLAR_TEAM_BENEFIT_ID?: string;
  POLAR_ENTERPRISE_BENEFIT_ID?: string;
  DEFAULT_SEATS?: string;
  LICENSE_DAYS?: string;
}

/** Consumer mail domains that must not become org bindings — a gmail address
 *  is not an org identity, and binding to it would lock the license to a
 *  personal mailbox forever (which is the buyer's choice to make later). */
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);

export interface ActivationInput {
  licenseKey: string;
  email: string;
  org?: string;
}

const POLAR_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@([^\s@.]+\.)+[^\s@.]+$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** POST /api/license/activate { licenseKey, email, org? } → { token, … } */
export async function handleActivate(request: Request, env: ActivateEnv): Promise<Response> {
  if (!env.LICENSE_SIGNING_KEY || !env.POLAR_ACCESS_TOKEN) {
    return json(503, { error: "license server not configured" });
  }
  let input: ActivationInput;
  try {
    const body = await request.json();
    input = {
      licenseKey: String(body?.licenseKey ?? ""),
      email: String(body?.email ?? "").trim().toLowerCase(),
      org: body?.org ? String(body.org).slice(0, 120) : undefined,
    };
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  if (!POLAR_KEY_PATTERN.test(input.licenseKey)) {
    return json(400, { error: "licenseKey must be the Polar license key from your order email" });
  }
  if (!EMAIL_PATTERN.test(input.email)) {
    return json(400, { error: "email is required to bind the license (used for org-domain binding)" });
  }

  // Entitlement check against Polar — the only network dependency.
  const api = env.POLAR_API || "https://api.polar.sh";
  let polar: any;
  try {
    const res = await fetch(`${api}/v1/license-keys/${encodeURIComponent(input.licenseKey)}`, {
      headers: { authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      // 404 and 422 both mean "this key can't be looked up" — 422 is what the
      // API returns for a key that matches no record (verified live 2026-10-27).
      return json(res.status === 404 || res.status === 422 ? 400 : 502, {
        error: res.status === 404 || res.status === 422
          ? "license key not recognized — check the key from your order email"
          : "could not verify the license key (Polar unavailable), try again shortly",
      });
    }
    polar = await res.json();
  } catch {
    return json(502, { error: "could not reach Polar to verify the license key" });
  }
  const status = String(polar?.status ?? "");
  if (status === "revoked" || status === "disabled") {
    return json(403, { error: `this license key is ${status} — contact support` });
  }

  // Record the activation with Polar (best-effort; seat-limit enforcement
  // lives there, and a failure here must not block a legitimate activation).
  try {
    await fetch(`${api}/v1/license-keys/activations`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ license_key: input.licenseKey, identifier: input.email }),
    });
  } catch { /* best-effort */ }

  const payload = buildPayload(polar, input, env);
  const token = signToken(payload, env.LICENSE_SIGNING_KEY);
  return json(200, {
    token,
    plan: payload.plan,
    org: payload.org,
    seats: payload.seats,
    expires: payload.exp ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : "perpetual",
  });
}

export function buildPayload(polar: any, input: ActivationInput, env: ActivateEnv): LicensePayload {
  const domain = input.email.split("@")[1] ?? "";
  const bindDomain = !FREE_MAIL_DOMAINS.has(domain) ? domain : undefined;
  const benefit = String(polar?.benefit ?? polar?.benefit_id ?? "");
  const plan: LicensePayload["plan"] =
    env.POLAR_ENTERPRISE_BENEFIT_ID && benefit === env.POLAR_ENTERPRISE_BENEFIT_ID ? "enterprise" : "team";
  const days = Math.max(1, Number(env.LICENSE_DAYS ?? 365) || 365);
  const metadataSeats = Number(polar?.metadata?.seats ?? polar?.benefit?.metadata?.seats);
  return {
    id: `pol_${String(polar?.id ?? crypto.createHash("sha256").update(input.licenseKey).digest("hex").slice(0, 16))}`,
    org: input.org || bindDomain || domain || "Polar customer",
    email: input.email,
    orgDomain: bindDomain,
    plan,
    seats: Number.isFinite(metadataSeats) && metadataSeats > 0 ? Math.floor(metadataSeats) : Math.max(1, Number(env.DEFAULT_SEATS ?? 1) || 1),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + days * 86400,
  };
}

/** Same wire format as scripts/license-tool.mjs:
 *  `<base64url(JSON payload)>.<base64url(Ed25519 signature over segment 1)>` */
export function signToken(payload: LicensePayload, privateKeyPem: string): string {
  const seg = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.sign(null, Buffer.from(seg, "utf8"), crypto.createPrivateKey(privateKeyPem));
  return `${seg}.${signature.toString("base64url")}`;
}

/** The Worker's request router: API under /api/, everything else is the
 *  static site (Workers with assets — the script sees every request). */
export async function handleRequest(request: Request, env: ActivateEnv & { ASSETS: { fetch: (r: Request) => Promise<Response> } }): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/license/activate") {
    if (request.method !== "POST") return json(405, { error: "POST only" });
    return handleActivate(request, env);
  }
  if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
  return env.ASSETS.fetch(request);
}
