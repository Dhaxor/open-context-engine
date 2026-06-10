import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Offline license gate for the commercial (Team/Enterprise) edition.
 *
 * This file is the OPEN-SOURCE *gate*: it verifies a signed license token locally and
 * decides what is unlocked. The paid *features* live in a separate private package
 * (see loadEnterpriseEdition). The signing private key is held only by the vendor
 * (see scripts/license-tool.mjs) — verification here needs only the public key, so the
 * whole flow works offline / air-gapped, which is a feature for privacy-sensitive buyers.
 *
 * Token format: `<base64url(JSON payload)>.<base64url(Ed25519 signature over segment 1)>`
 */

/** Ed25519 public key (base64 SPKI DER) that license tokens are verified against.
 *  Generate your own with `node scripts/license-tool.mjs generate-keys` and paste it here;
 *  keep the matching private key secret. */
const EMBEDDED_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEA9GbEuFu++amEVa/eDfTaC/fLZPExt5HNi+dLua5QFoQ=";

/** Days a subscription license keeps working past `exp` — absorbs renewal lag, clock skew,
 *  and brief offline gaps so a single missed day never bricks an air-gapped install. */
export const DEFAULT_GRACE_DAYS = 14;

export type Plan = "community" | "team" | "enterprise";

export type Feature = "multi-repo" | "team-index" | "policies" | "sso" | "audit-log";

/** Minimum plan that unlocks each gated feature. */
const FEATURE_MIN_PLAN: Record<Feature, Exclude<Plan, "community">> = {
  "multi-repo": "team",
  "team-index": "team",
  "policies": "team",
  "sso": "enterprise",
  "audit-log": "enterprise",
};

const PLAN_RANK: Record<Plan, number> = { community: 0, team: 1, enterprise: 2 };

export interface LicensePayload {
  /** Unique license id (for revocation lists). */
  id: string;
  /** Organization the license is issued to. */
  org: string;
  email?: string;
  plan: Exclude<Plan, "community">;
  /** Seats purchased. Offline enforcement is honor-based; the control plane can audit. */
  seats: number;
  /** Optional explicit feature grants beyond the plan default. */
  features?: string[];
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. 0 = perpetual. */
  exp: number;
}

export type LicenseReason = "missing" | "malformed" | "bad-signature" | "expired" | "ok";

export interface LicenseStatus {
  /** Present, correctly signed, and within the grace window. */
  valid: boolean;
  reason: LicenseReason;
  /** Effective plan — falls back to "community" whenever the license is not valid. */
  plan: Plan;
  payload?: LicensePayload;
  /** Past `exp` but still inside the grace window (`valid` stays true). */
  inGrace: boolean;
  /** Days until the grace window fully lapses (only set for non-perpetual licenses). */
  daysLeft?: number;
}

export interface VerifyOptions {
  /** Override the verification public key (base64 SPKI DER). Used in tests. */
  publicKey?: string;
  /** Override "now" in unix seconds (testing / determinism). */
  now?: number;
  /** Grace window in days. Defaults to DEFAULT_GRACE_DAYS. */
  graceDays?: number;
}

const community = (reason: LicenseReason, payload?: LicensePayload, daysLeft?: number): LicenseStatus =>
  ({ valid: false, reason, plan: "community", inGrace: false, payload, daysLeft });

let cachedKey: crypto.KeyObject | undefined;
function publicKeyObject(b64: string): crypto.KeyObject {
  if (b64 === EMBEDDED_PUBLIC_KEY_B64 && cachedKey) return cachedKey;
  const key = crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
  if (b64 === EMBEDDED_PUBLIC_KEY_B64) cachedKey = key;
  return key;
}

/** Encode a payload to its signing segment (base64url of the JSON). Exported so the signing
 *  tool and tests produce byte-identical input to what verification checks. */
export function serializeLicensePayload(payload: LicensePayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Verify a license token offline. Never throws — returns a community status on any failure. */
export function verifyLicenseToken(token: string | null | undefined, opts: VerifyOptions = {}): LicenseStatus {
  if (!token || typeof token !== "string") return community("missing");
  const parts = token.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return community("malformed");
  const [seg, sigB64] = parts;

  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
  } catch {
    return community("malformed");
  }
  if (!payload || typeof payload !== "object" || !payload.plan || typeof payload.exp !== "number") {
    return community("malformed");
  }

  let signatureOk = false;
  try {
    const key = publicKeyObject(opts.publicKey ?? EMBEDDED_PUBLIC_KEY_B64);
    signatureOk = crypto.verify(null, Buffer.from(seg), key, Buffer.from(sigB64, "base64url"));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return community("bad-signature");

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.exp > 0) {
    const graceSecs = (opts.graceDays ?? DEFAULT_GRACE_DAYS) * 86400;
    const daysLeft = Math.floor((payload.exp + graceSecs - now) / 86400);
    if (now > payload.exp + graceSecs) return community("expired", payload, daysLeft);
    return { valid: true, reason: "ok", plan: payload.plan, payload, inGrace: now > payload.exp, daysLeft };
  }
  return { valid: true, reason: "ok", plan: payload.plan, payload, inGrace: false };
}

/** Whether a license entitles the holder to a feature. */
export function isEntitled(status: LicenseStatus, feature: Feature): boolean {
  if (!status.valid) return false;
  if (status.payload?.features?.includes(feature)) return true;
  return PLAN_RANK[status.plan] >= PLAN_RANK[FEATURE_MIN_PLAN[feature]];
}

/** Throw a clear upgrade error unless the license entitles `feature`. Use to gate EE code paths. */
export function requireFeature(status: LicenseStatus, feature: Feature): void {
  if (isEntitled(status, feature)) return;
  const need = FEATURE_MIN_PLAN[feature];
  throw new Error(`"${feature}" requires an Open Context Engine ${need} license. Activate one with 'oce activate <key>'.`);
}

// --- License persistence (user/machine global, not per-workspace) ---

export function licenseConfigDir(): string {
  return process.env.OCE_CONFIG_DIR || path.join(os.homedir(), ".open-context");
}

export function licenseConfigPath(): string {
  return path.join(licenseConfigDir(), "license");
}

/** Resolve the active token: OCE_LICENSE_KEY, then OCE_LICENSE_FILE, then the saved file. */
export function loadLicenseToken(): string | null {
  const inline = process.env.OCE_LICENSE_KEY?.trim();
  if (inline) return inline;
  try {
    const fileEnv = process.env.OCE_LICENSE_FILE?.trim();
    if (fileEnv && fs.existsSync(fileEnv)) return fs.readFileSync(fileEnv, "utf8").trim();
    const p = licenseConfigPath();
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  } catch {}
  return null;
}

/** Persist a license token to the global config file. Returns the path written. */
export function saveLicenseToken(token: string): string {
  const dir = licenseConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = licenseConfigPath();
  fs.writeFileSync(p, token.trim() + "\n", { mode: 0o600 });
  return p;
}

/** Remove any saved license token. Returns true if a file was deleted. */
export function clearLicense(): boolean {
  try {
    const p = licenseConfigPath();
    if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  } catch {}
  return false;
}

/** Load + verify the active license in one call. Never throws. */
export function getLicense(opts: VerifyOptions = {}): LicenseStatus {
  return verifyLicenseToken(loadLicenseToken(), opts);
}

/** Private package holding the commercial edition (absent in open-source installs).
 *  Built via `.join` so the bundler/compiler treats it as a dynamic, unresolved specifier. */
const EE_PACKAGE = ["@open-context-engine", "ee"].join("/");

/** Dynamically load the commercial edition if it is installed AND the license is valid.
 *  Resolves from OCE_EE_PATH, then the published package name, then a co-located dev build
 *  (ee/dist). Returns null in open-source installs or when unlicensed — callers fall back. */
export async function loadEnterpriseEdition(status?: LicenseStatus): Promise<any | null> {
  const s = status ?? getLicense();
  if (!s.valid) return null;
  const candidates: string[] = [];
  if (process.env.OCE_EE_PATH) candidates.push(process.env.OCE_EE_PATH);
  candidates.push(EE_PACKAGE);
  candidates.push(path.resolve(__dirname, "../../ee/dist/index.js"));
  for (const spec of candidates) {
    try {
      const mod: any = await import(spec);
      if (mod && typeof mod.activate === "function") return await mod.activate(s);
    } catch {}
  }
  return null;
}
