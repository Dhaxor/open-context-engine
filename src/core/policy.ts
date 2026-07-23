import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { licenseConfigDir } from "./license";

/**
 * Policy controls: pin what the engine and agent are allowed to do.
 *
 * Three layers, most-restrictive-wins:
 *   1. User policy      — `~/.open-context/policy.json` (or $OCE_CONFIG_DIR)
 *   2. Workspace policy — `<workspace>/.open-context/policy.json` (commit it)
 *   3. Org-locked policy — `<workspace>/.open-context/policy.lock` or
 *      $OCE_POLICY_LOCK: an Ed25519-signed token issued to the org (Team+
 *      licensing includes issuance). A valid lock is enforced regardless of
 *      local settings or CLI flags and cannot be overridden — that is its
 *      entire point. Deleting the license file does not escape it.
 *
 * Merge semantics: a `false` beats `true`/unset for booleans, allowlists
 * intersect, ignore patterns union, `localOnly`/`required` are sticky-true.
 * An unset field means "no opinion" — community installs with no policy files
 * get an all-permissive effective policy, so nothing changes for them.
 */

export interface PolicyRules {
  version?: 1;
  agent?: {
    /** Allow file-editing tools (str-replace / create-file / remove-file). */
    edits?: { enabled?: boolean };
    /** Allow the run-command shell tool; optionally pin an allowlist. */
    shell?: { enabled?: boolean; allowlist?: string[]; maxTimeoutMs?: number };
    /** Allow the web-search tool. */
    webSearch?: { enabled?: boolean };
  };
  embedding?: {
    /** Only these embedding providers may be used (e.g. ["ollama","local"]). */
    allowedProviders?: string[];
    /** Shorthand: only local providers (ollama/local) — no code leaves the machine. */
    localOnly?: boolean;
  };
  /** Extra ignore patterns (gitignore syntax) always excluded from indexing. */
  ignore?: string[];
  audit?: {
    /** Force audit logging on for agent runs in this workspace. */
    required?: boolean;
  };
}

export interface EffectivePolicy extends PolicyRules {
  /** Paths/labels of the sources that contributed rules, in merge order. */
  sources: string[];
  /** True when an org-signed policy.lock is active (rules cannot be loosened locally). */
  locked: boolean;
  /** Org the lock was issued to (from the signed payload). */
  lockedBy?: string;
  /** Non-fatal problems found while loading (malformed file, bad signature…). */
  warnings: string[];
}

export interface SignedPolicyPayload {
  /** Organization the policy is issued to (informational, shown in `oce policy`). */
  org: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. 0 = no expiry. Expired locks are ignored with a warning. */
  exp: number;
  policy: PolicyRules;
}

/** Local providers that never send code off the machine. */
export const LOCAL_EMBEDDING_PROVIDERS = ["ollama", "local"];

const LOCAL_ONLY_PROVIDERS = new Set(LOCAL_EMBEDDING_PROVIDERS);

export function emptyPolicy(): EffectivePolicy {
  return { sources: [], locked: false, warnings: [] };
}

function intersect(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  const set = new Set(b);
  return a.filter(x => set.has(x));
}

function mergeBoolRestrictive(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (a === false || b === false) return false;
  if (a === undefined && b === undefined) return undefined;
  return a ?? b;
}

/** Merge `next` into `base`, most-restrictive-wins. Exported for tests. */
export function mergePolicies(base: PolicyRules, next: PolicyRules): PolicyRules {
  const out: PolicyRules = { version: 1 };
  const agent: NonNullable<PolicyRules["agent"]> = {};
  const editsEnabled = mergeBoolRestrictive(base.agent?.edits?.enabled, next.agent?.edits?.enabled);
  if (editsEnabled !== undefined) agent.edits = { enabled: editsEnabled };
  const shellEnabled = mergeBoolRestrictive(base.agent?.shell?.enabled, next.agent?.shell?.enabled);
  const shellAllow = intersect(base.agent?.shell?.allowlist, next.agent?.shell?.allowlist);
  const maxTimeouts = [base.agent?.shell?.maxTimeoutMs, next.agent?.shell?.maxTimeoutMs].filter((n): n is number => typeof n === "number");
  if (shellEnabled !== undefined || shellAllow !== undefined || maxTimeouts.length) {
    agent.shell = {
      ...(shellEnabled !== undefined ? { enabled: shellEnabled } : {}),
      ...(shellAllow !== undefined ? { allowlist: shellAllow } : {}),
      ...(maxTimeouts.length ? { maxTimeoutMs: Math.min(...maxTimeouts) } : {}),
    };
  }
  const webEnabled = mergeBoolRestrictive(base.agent?.webSearch?.enabled, next.agent?.webSearch?.enabled);
  if (webEnabled !== undefined) agent.webSearch = { enabled: webEnabled };
  if (Object.keys(agent).length) out.agent = agent;

  const allowedProviders = intersect(base.embedding?.allowedProviders, next.embedding?.allowedProviders);
  const localOnly = base.embedding?.localOnly || next.embedding?.localOnly || undefined;
  if (allowedProviders !== undefined || localOnly !== undefined) {
    out.embedding = {
      ...(allowedProviders !== undefined ? { allowedProviders } : {}),
      ...(localOnly !== undefined ? { localOnly } : {}),
    };
  }

  const ignore = [...new Set([...(base.ignore ?? []), ...(next.ignore ?? [])])];
  if (ignore.length) out.ignore = ignore;

  const auditRequired = base.audit?.required || next.audit?.required || undefined;
  if (auditRequired !== undefined) out.audit = { required: auditRequired };
  return out;
}

function parsePolicyFile(file: string, warnings: string[]): PolicyRules | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`${file}: not a JSON object — ignored`);
      return null;
    }
    return parsed as PolicyRules;
  } catch (e: any) {
    warnings.push(`${file}: invalid JSON (${e?.message ?? e}) — ignored`);
    return null;
  }
}

export interface VerifySignedPolicyOptions {
  /** Override verification public key (base64 SPKI DER) — tests. */
  publicKey?: string;
  /** Override "now" in unix seconds — tests. */
  now?: number;
}

/** Same embedded key the license gate uses — the vendor signs org policy locks
 *  at issuance time, exactly like license tokens. Kept in sync with license.ts. */
const EMBEDDED_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEANybrLf3Rpvaxc78/z6W/BbTZHtJV0ys12BTMPp5lggw=";

/** Verify a signed policy token (`base64url(json).base64url(sig)`). Returns
 *  the payload, or null (with a reason pushed to warnings) on any failure. */
export function verifySignedPolicy(token: string, warnings: string[], opts: VerifySignedPolicyOptions = {}): SignedPolicyPayload | null {
  const parts = token.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    warnings.push("policy.lock: malformed token — ignored");
    return null;
  }
  const [seg, sigB64] = parts;
  let payload: SignedPolicyPayload;
  try {
    payload = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
  } catch {
    warnings.push("policy.lock: malformed payload — ignored");
    return null;
  }
  if (!payload || typeof payload !== "object" || !payload.policy || typeof payload.policy !== "object") {
    warnings.push("policy.lock: missing policy body — ignored");
    return null;
  }
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(opts.publicKey ?? EMBEDDED_PUBLIC_KEY_B64, "base64"), format: "der", type: "spki" });
    ok = crypto.verify(null, Buffer.from(seg), key, Buffer.from(sigB64, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) {
    warnings.push("policy.lock: invalid signature — ignored (was the file edited?)");
    return null;
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp > 0 && now > payload.exp) {
    warnings.push(`policy.lock: expired ${new Date(payload.exp * 1000).toISOString().slice(0, 10)} — ignored`);
    return null;
  }
  return payload;
}

export interface LoadPolicyOptions {
  /** Override the user-level config dir (default: licenseConfigDir()). */
  userDir?: string;
  /** Signed-policy verification overrides — tests. */
  verify?: VerifySignedPolicyOptions;
}

/** Load and merge all policy layers for a workspace. Never throws. */
export function loadPolicy(workspaceRoot: string, opts: LoadPolicyOptions = {}): EffectivePolicy {
  const warnings: string[] = [];
  const sources: string[] = [];
  let rules: PolicyRules = {};

  const userFile = path.join(opts.userDir ?? licenseConfigDir(), "policy.json");
  const userRules = parsePolicyFile(userFile, warnings);
  if (userRules) { rules = mergePolicies(rules, userRules); sources.push(userFile); }

  const wsFile = path.join(workspaceRoot, ".open-context", "policy.json");
  const wsRules = parsePolicyFile(wsFile, warnings);
  if (wsRules) { rules = mergePolicies(rules, wsRules); sources.push(wsFile); }

  let locked = false;
  let lockedBy: string | undefined;
  const lockFile = process.env.OCE_POLICY_LOCK || path.join(workspaceRoot, ".open-context", "policy.lock");
  try {
    if (fs.existsSync(lockFile)) {
      const token = fs.readFileSync(lockFile, "utf8");
      const payload = verifySignedPolicy(token, warnings, opts.verify);
      if (payload) {
        rules = mergePolicies(rules, payload.policy);
        sources.push(lockFile);
        locked = true;
        lockedBy = payload.org;
      }
    }
  } catch (e: any) {
    warnings.push(`${lockFile}: ${e?.message ?? e} — ignored`);
  }

  return { ...rules, sources, locked, ...(lockedBy ? { lockedBy } : {}), warnings };
}

// --- Enforcement helpers (pure; surfaces call these) ---

export function policyAllowsEdits(p: EffectivePolicy | undefined): boolean {
  return p?.agent?.edits?.enabled !== false;
}

export function policyAllowsShell(p: EffectivePolicy | undefined): boolean {
  return p?.agent?.shell?.enabled !== false;
}

export function policyAllowsWebSearch(p: EffectivePolicy | undefined): boolean {
  return p?.agent?.webSearch?.enabled !== false;
}

/** Effective shell allowlist: intersection of the policy's and the requested
 *  one. An empty REQUESTED list means "anything" and yields the policy list;
 *  an empty RESULT with a non-empty policy list means "nothing overlaps". */
export function policyShellAllowlist(p: EffectivePolicy | undefined, requested: string[]): string[] {
  const pinned = p?.agent?.shell?.allowlist;
  if (!pinned) return requested;
  if (!requested.length) return [...pinned];
  const set = new Set(pinned);
  return requested.filter(c => set.has(c));
}

/** Returns an error message when `provider` violates the embedding policy, else null. */
export function checkEmbeddingPolicy(p: EffectivePolicy | undefined, provider: string): string | null {
  if (!p) return null;
  if (p.embedding?.localOnly && !LOCAL_ONLY_PROVIDERS.has(provider)) {
    return `Embedding provider "${provider}" is blocked: policy requires local-only embeddings (${LOCAL_EMBEDDING_PROVIDERS.join("/")}). Sources: ${p.sources.join(", ") || "(none)"}`;
  }
  const allowed = p.embedding?.allowedProviders;
  if (allowed && !allowed.includes(provider)) {
    return `Embedding provider "${provider}" is blocked by policy (allowed: ${allowed.join(", ") || "none"}). Sources: ${p.sources.join(", ") || "(none)"}`;
  }
  return null;
}

/** True when the effective policy forces audit logging on. */
export function policyRequiresAudit(p: EffectivePolicy | undefined): boolean {
  return p?.audit?.required === true;
}

/** One-line human summary for CLIs/UI. */
export function describePolicy(p: EffectivePolicy): string {
  if (!p.sources.length) return "no policy files found — all capabilities allowed";
  const parts: string[] = [];
  if (p.agent?.edits?.enabled === false) parts.push("edits: blocked");
  if (p.agent?.shell?.enabled === false) parts.push("shell: blocked");
  else if (p.agent?.shell?.allowlist) parts.push(`shell allowlist: [${p.agent.shell.allowlist.join(", ")}]`);
  if (p.agent?.webSearch?.enabled === false) parts.push("web-search: blocked");
  if (p.embedding?.localOnly) parts.push("embeddings: local-only");
  else if (p.embedding?.allowedProviders) parts.push(`embedding providers: [${p.embedding.allowedProviders.join(", ")}]`);
  if (p.ignore?.length) parts.push(`${p.ignore.length} pinned ignore pattern(s)`);
  if (p.audit?.required) parts.push("audit: required");
  const lock = p.locked ? ` [LOCKED by ${p.lockedBy ?? "org"} — signed policy]` : "";
  return (parts.length ? parts.join("; ") : "no restrictions") + lock;
}
