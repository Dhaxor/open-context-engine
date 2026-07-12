import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadPolicy, mergePolicies, verifySignedPolicy, describePolicy,
  policyAllowsEdits, policyAllowsShell, policyAllowsWebSearch, policyShellAllowlist,
  checkEmbeddingPolicy, policyRequiresAudit, emptyPolicy,
  PolicyRules, SignedPolicyPayload, EffectivePolicy,
} from "./policy";

// Ephemeral keypair so tests never depend on the embedded production key.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const NOW = 1_700_000_000;

function mintLock(policy: PolicyRules, over: Partial<SignedPolicyPayload> = {}): string {
  const payload: SignedPolicyPayload = { org: "Acme", iat: NOW - 100, exp: NOW + 86400, policy, ...over };
  const seg = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign(null, Buffer.from(seg), privateKey).toString("base64url");
  return `${seg}.${sig}`;
}

let ws: string;
let userDir: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "oce-policy-ws-"));
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-policy-user-"));
  fs.mkdirSync(path.join(ws, ".open-context"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
  delete process.env.OCE_POLICY_LOCK;
});

function writeWorkspacePolicy(rules: PolicyRules): void {
  fs.writeFileSync(path.join(ws, ".open-context", "policy.json"), JSON.stringify(rules));
}

function writeUserPolicy(rules: PolicyRules): void {
  fs.writeFileSync(path.join(userDir, "policy.json"), JSON.stringify(rules));
}

describe("mergePolicies", () => {
  it("most-restrictive-wins for booleans", () => {
    const merged = mergePolicies(
      { agent: { shell: { enabled: true }, edits: { enabled: false } } },
      { agent: { shell: { enabled: false }, edits: { enabled: true } } },
    );
    expect(merged.agent?.shell?.enabled).toBe(false);
    expect(merged.agent?.edits?.enabled).toBe(false);
  });

  it("intersects allowlists and unions ignore patterns", () => {
    const merged = mergePolicies(
      { agent: { shell: { allowlist: ["git", "npm", "ls"] } }, ignore: ["secrets/**"] },
      { agent: { shell: { allowlist: ["npm", "git"] } }, ignore: ["*.pem"] },
    );
    expect(merged.agent?.shell?.allowlist).toEqual(["git", "npm"]);
    expect(merged.ignore?.sort()).toEqual(["*.pem", "secrets/**"]);
  });

  it("keeps localOnly and audit.required sticky-true", () => {
    const merged = mergePolicies({ embedding: { localOnly: true } }, { audit: { required: true } });
    expect(merged.embedding?.localOnly).toBe(true);
    expect(merged.audit?.required).toBe(true);
  });

  it("takes the minimum shell timeout", () => {
    const merged = mergePolicies(
      { agent: { shell: { maxTimeoutMs: 30_000 } } },
      { agent: { shell: { maxTimeoutMs: 10_000 } } },
    );
    expect(merged.agent?.shell?.maxTimeoutMs).toBe(10_000);
  });
});

describe("loadPolicy", () => {
  it("returns an all-permissive policy when no files exist", () => {
    const p = loadPolicy(ws, { userDir });
    expect(p.sources).toEqual([]);
    expect(p.locked).toBe(false);
    expect(policyAllowsEdits(p)).toBe(true);
    expect(policyAllowsShell(p)).toBe(true);
    expect(policyAllowsWebSearch(p)).toBe(true);
  });

  it("merges user then workspace policy, most restrictive wins", () => {
    writeUserPolicy({ agent: { shell: { enabled: true, allowlist: ["git", "npm"] } } });
    writeWorkspacePolicy({ agent: { shell: { allowlist: ["npm", "cargo"] }, edits: { enabled: false } } });
    const p = loadPolicy(ws, { userDir });
    expect(p.sources).toHaveLength(2);
    expect(p.agent?.shell?.allowlist).toEqual(["npm"]);
    expect(policyAllowsEdits(p)).toBe(false);
  });

  it("collects a warning (not a crash) on malformed JSON", () => {
    fs.writeFileSync(path.join(ws, ".open-context", "policy.json"), "{nope");
    const p = loadPolicy(ws, { userDir });
    expect(p.warnings.length).toBe(1);
    expect(p.sources).toEqual([]);
  });

  it("applies a validly signed policy.lock and marks the policy locked", () => {
    fs.writeFileSync(path.join(ws, ".open-context", "policy.lock"), mintLock({ agent: { shell: { enabled: false } }, audit: { required: true } }));
    const p = loadPolicy(ws, { userDir, verify: { publicKey: PUB, now: NOW } });
    expect(p.locked).toBe(true);
    expect(p.lockedBy).toBe("Acme");
    expect(policyAllowsShell(p)).toBe(false);
    expect(policyRequiresAudit(p)).toBe(true);
  });

  it("a local policy cannot loosen the org lock", () => {
    writeWorkspacePolicy({ agent: { shell: { enabled: true } } });
    fs.writeFileSync(path.join(ws, ".open-context", "policy.lock"), mintLock({ agent: { shell: { enabled: false } } }));
    const p = loadPolicy(ws, { userDir, verify: { publicKey: PUB, now: NOW } });
    expect(policyAllowsShell(p)).toBe(false);
  });

  it("ignores a tampered policy.lock with a warning", () => {
    const token = mintLock({ agent: { shell: { enabled: false } } });
    const [seg, sig] = token.split(".");
    const forged = JSON.parse(Buffer.from(seg, "base64url").toString());
    forged.policy.agent.shell.enabled = true;
    fs.writeFileSync(path.join(ws, ".open-context", "policy.lock"), `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`);
    const p = loadPolicy(ws, { userDir, verify: { publicKey: PUB, now: NOW } });
    expect(p.locked).toBe(false);
    expect(p.warnings.some(w => w.includes("invalid signature"))).toBe(true);
    expect(policyAllowsShell(p)).toBe(true); // lock ignored, no other files
  });

  it("ignores an expired policy.lock with a warning", () => {
    fs.writeFileSync(path.join(ws, ".open-context", "policy.lock"), mintLock({ agent: { shell: { enabled: false } } }, { exp: NOW - 10 }));
    const p = loadPolicy(ws, { userDir, verify: { publicKey: PUB, now: NOW } });
    expect(p.locked).toBe(false);
    expect(p.warnings.some(w => w.includes("expired"))).toBe(true);
  });

  it("honors OCE_POLICY_LOCK as the lock path", () => {
    const lockPath = path.join(userDir, "org.lock");
    fs.writeFileSync(lockPath, mintLock({ embedding: { localOnly: true } }));
    process.env.OCE_POLICY_LOCK = lockPath;
    const p = loadPolicy(ws, { userDir, verify: { publicKey: PUB, now: NOW } });
    expect(p.locked).toBe(true);
    expect(p.embedding?.localOnly).toBe(true);
  });
});

describe("enforcement helpers", () => {
  const restrictive: EffectivePolicy = {
    ...emptyPolicy(),
    agent: { shell: { enabled: true, allowlist: ["git", "npm"] } },
    embedding: { localOnly: true },
    sources: ["test"],
  };

  it("policyShellAllowlist intersects requested with pinned", () => {
    expect(policyShellAllowlist(restrictive, [])).toEqual(["git", "npm"]);
    expect(policyShellAllowlist(restrictive, ["npm", "cargo"])).toEqual(["npm"]);
    expect(policyShellAllowlist(undefined, ["cargo"])).toEqual(["cargo"]);
  });

  it("checkEmbeddingPolicy blocks non-local providers under localOnly", () => {
    expect(checkEmbeddingPolicy(restrictive, "voyage")).toMatch(/local-only/);
    expect(checkEmbeddingPolicy(restrictive, "ollama")).toBeNull();
    expect(checkEmbeddingPolicy(restrictive, "local")).toBeNull();
    expect(checkEmbeddingPolicy(undefined, "voyage")).toBeNull();
  });

  it("checkEmbeddingPolicy enforces allowedProviders", () => {
    const p: EffectivePolicy = { ...emptyPolicy(), embedding: { allowedProviders: ["voyage"] }, sources: ["t"] };
    expect(checkEmbeddingPolicy(p, "openai")).toMatch(/blocked by policy/);
    expect(checkEmbeddingPolicy(p, "voyage")).toBeNull();
  });

  it("describePolicy summarizes restrictions", () => {
    const s = describePolicy(restrictive);
    expect(s).toContain("shell allowlist");
    expect(s).toContain("local-only");
  });
});

describe("verifySignedPolicy edge cases", () => {
  it("rejects malformed tokens without throwing", () => {
    const warnings: string[] = [];
    expect(verifySignedPolicy("garbage", warnings, { publicKey: PUB })).toBeNull();
    expect(verifySignedPolicy("a.b.c", warnings, { publicKey: PUB })).toBeNull();
    expect(warnings.length).toBe(2);
  });
});
