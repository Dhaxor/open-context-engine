import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  serializeLicensePayload, verifyLicenseToken, isEntitled, requireFeature,
  saveLicenseToken, loadLicenseToken, clearLicense, getLicense, licenseConfigPath,
  LicensePayload,
} from "./license";

// Ephemeral keypair so tests never depend on the embedded production key.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const NOW = 1_700_000_000; // fixed "now" in unix seconds

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return { id: "lic_1", org: "Acme", plan: "team", seats: 5, iat: NOW - 86400, exp: NOW + 86400 * 30, ...over };
}

function mint(p: LicensePayload): string {
  const seg = serializeLicensePayload(p);
  const sig = crypto.sign(null, Buffer.from(seg), privateKey).toString("base64url");
  return `${seg}.${sig}`;
}

describe("verifyLicenseToken", () => {
  it("accepts a correctly signed, unexpired token", () => {
    const s = verifyLicenseToken(mint(payload()), { publicKey: PUB, now: NOW });
    expect(s).toMatchObject({ valid: true, reason: "ok", plan: "team", inGrace: false });
    expect(s.payload?.org).toBe("Acme");
  });

  it("reports missing for empty input", () => {
    expect(verifyLicenseToken("", { publicKey: PUB }).reason).toBe("missing");
    expect(verifyLicenseToken(null, { publicKey: PUB }).reason).toBe("missing");
  });

  it("reports malformed for garbage", () => {
    expect(verifyLicenseToken("not-a-token", { publicKey: PUB }).reason).toBe("malformed");
    expect(verifyLicenseToken("a.b.c", { publicKey: PUB }).reason).toBe("malformed");
  });

  it("rejects a tampered payload", () => {
    const token = mint(payload({ seats: 5 }));
    const [seg, sig] = token.split(".");
    const forged = JSON.parse(Buffer.from(seg, "base64url").toString());
    forged.seats = 9999;
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    expect(verifyLicenseToken(tampered, { publicKey: PUB, now: NOW }).reason).toBe("bad-signature");
  });

  it("rejects a token signed by a different key (defaults to embedded key)", () => {
    // Signed with our ephemeral key but verified against the real embedded key.
    expect(verifyLicenseToken(mint(payload()), { now: NOW }).reason).toBe("bad-signature");
  });

  it("treats a perpetual license (exp 0) as valid", () => {
    const s = verifyLicenseToken(mint(payload({ exp: 0 })), { publicKey: PUB, now: NOW });
    expect(s.valid).toBe(true);
    expect(s.inGrace).toBe(false);
    expect(s.daysLeft).toBeUndefined();
  });

  it("keeps an expired license valid inside the grace window, flagged inGrace", () => {
    const s = verifyLicenseToken(mint(payload({ exp: NOW - 86400 })), { publicKey: PUB, now: NOW, graceDays: 14 });
    expect(s.valid).toBe(true);
    expect(s.inGrace).toBe(true);
    expect(s.daysLeft).toBe(13);
  });

  it("rejects a license past the grace window", () => {
    const s = verifyLicenseToken(mint(payload({ exp: NOW - 86400 * 30 })), { publicKey: PUB, now: NOW, graceDays: 14 });
    expect(s.valid).toBe(false);
    expect(s.reason).toBe("expired");
    expect(s.plan).toBe("community");
  });
});

describe("entitlement", () => {
  const team = verifyLicenseToken(mint(payload({ plan: "team" })), { publicKey: PUB, now: NOW });
  const enterprise = verifyLicenseToken(mint(payload({ plan: "enterprise" })), { publicKey: PUB, now: NOW });
  const community = verifyLicenseToken("", { publicKey: PUB });

  it("grants team features to team and enterprise, not community", () => {
    expect(isEntitled(team, "multi-repo")).toBe(true);
    expect(isEntitled(enterprise, "multi-repo")).toBe(true);
    expect(isEntitled(community, "multi-repo")).toBe(false);
  });

  it("reserves enterprise features for enterprise", () => {
    expect(isEntitled(team, "sso")).toBe(false);
    expect(isEntitled(enterprise, "sso")).toBe(true);
  });

  it("honors explicit feature grants beyond the plan", () => {
    const teamPlusSso = verifyLicenseToken(mint(payload({ plan: "team", features: ["sso"] })), { publicKey: PUB, now: NOW });
    expect(isEntitled(teamPlusSso, "sso")).toBe(true);
  });

  it("requireFeature throws only when unentitled", () => {
    expect(() => requireFeature(team, "multi-repo")).not.toThrow();
    expect(() => requireFeature(team, "sso")).toThrow(/enterprise license/i);
  });
});

describe("persistence", () => {
  let tmp: string;
  const savedEnv = { dir: process.env.OCE_CONFIG_DIR, key: process.env.OCE_LICENSE_KEY, file: process.env.OCE_LICENSE_FILE };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oce-lic-"));
    process.env.OCE_CONFIG_DIR = tmp;
    delete process.env.OCE_LICENSE_KEY;
    delete process.env.OCE_LICENSE_FILE;
  });

  afterEach(() => {
    if (savedEnv.dir === undefined) delete process.env.OCE_CONFIG_DIR; else process.env.OCE_CONFIG_DIR = savedEnv.dir;
    if (savedEnv.key === undefined) delete process.env.OCE_LICENSE_KEY; else process.env.OCE_LICENSE_KEY = savedEnv.key;
    if (savedEnv.file === undefined) delete process.env.OCE_LICENSE_FILE; else process.env.OCE_LICENSE_FILE = savedEnv.file;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("saves, loads, and clears a token round-trip", () => {
    const token = mint(payload());
    const p = saveLicenseToken(token);
    expect(p).toBe(licenseConfigPath());
    expect(loadLicenseToken()).toBe(token);
    expect(getLicense({ publicKey: PUB, now: NOW }).valid).toBe(true);
    expect(clearLicense()).toBe(true);
    expect(loadLicenseToken()).toBeNull();
    expect(clearLicense()).toBe(false);
  });

  it("prefers OCE_LICENSE_KEY over the saved file", () => {
    saveLicenseToken(mint(payload({ org: "Saved" })));
    process.env.OCE_LICENSE_KEY = mint(payload({ org: "FromEnv" }));
    expect(getLicense({ publicKey: PUB, now: NOW }).payload?.org).toBe("FromEnv");
  });
});
