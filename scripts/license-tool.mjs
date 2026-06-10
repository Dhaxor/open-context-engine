#!/usr/bin/env node
/**
 * license-tool — SERVER-SIDE license key generator & signer for Open Context Engine.
 *
 * This is NOT shipped to customers. It lives here for convenience but the PRIVATE KEY
 * it generates is the secret that backs your whole licensing system. Keep it out of git
 * (business/ is gitignored) and ideally in a password manager / secrets vault.
 *
 * Token format (must match src/core/license.ts):
 *   <base64url(JSON payload)>.<base64url(Ed25519 signature over the first segment)>
 *
 * Usage:
 *   node scripts/license-tool.mjs generate-keys [--out business/keys]
 *   node scripts/license-tool.mjs sign --org "Acme Inc" --plan team --seats 10 --days 365 [--email a@b.co] [--features multi-repo,team-index]
 *   node scripts/license-tool.mjs verify --token <token> [--pub business/keys/license-public.pem]
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function cmdGenerateKeys(args) {
  const out = typeof args.out === "string" ? args.out : "business/keys";
  fs.mkdirSync(out, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" });
  const pubPem = publicKey.export({ format: "pem", type: "spki" });
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  fs.writeFileSync(path.join(out, "license-private.pem"), privPem, { mode: 0o600 });
  fs.writeFileSync(path.join(out, "license-public.pem"), pubPem);
  fs.writeFileSync(path.join(out, "license-public.b64"), pubB64 + "\n");
  console.log(`Wrote keypair to ${out}/`);
  console.log(`  - license-private.pem  (SECRET — never commit or share)`);
  console.log(`  - license-public.pem`);
  console.log(`  - license-public.b64`);
  console.log(`\nPaste this public key into src/core/license.ts as EMBEDDED_PUBLIC_KEY_B64:\n`);
  console.log(pubB64);
}

function cmdSign(args) {
  const keyPath = typeof args.key === "string" ? args.key : "business/keys/license-private.pem";
  if (!fs.existsSync(keyPath)) {
    console.error(`Private key not found at ${keyPath}. Run 'generate-keys' first or pass --key.`);
    process.exit(1);
  }
  const priv = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const now = Math.floor(Date.now() / 1000);
  const days = args.days !== undefined ? Number(args.days) : 365;
  const features = typeof args.features === "string"
    ? args.features.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const payload = {
    id: typeof args.id === "string" ? args.id : crypto.randomUUID(),
    org: typeof args.org === "string" ? args.org : "Unknown Org",
    email: typeof args.email === "string" ? args.email : undefined,
    plan: typeof args.plan === "string" ? args.plan : "team",
    seats: args.seats !== undefined ? Number(args.seats) : 1,
    features,
    iat: now,
    exp: days > 0 ? now + days * 86400 : 0,
  };
  const seg = encodePayload(payload);
  const sig = crypto.sign(null, Buffer.from(seg), priv).toString("base64url");
  const token = `${seg}.${sig}`;
  console.error(`Issued ${payload.plan} license for "${payload.org}" (${payload.seats} seats, ` +
    `${payload.exp ? "expires " + new Date(payload.exp * 1000).toISOString().slice(0, 10) : "perpetual"}):`);
  console.log(token);
}

function cmdVerify(args) {
  const token = typeof args.token === "string" ? args.token : "";
  const pubArg = typeof args.pub === "string" ? args.pub : "business/keys/license-public.pem";
  const pub = fs.existsSync(pubArg)
    ? crypto.createPublicKey(fs.readFileSync(pubArg))
    : crypto.createPublicKey({ key: Buffer.from(pubArg, "base64"), format: "der", type: "spki" });
  const [seg, sig] = token.split(".");
  if (!seg || !sig) { console.error("Malformed token."); process.exit(1); }
  const ok = crypto.verify(null, Buffer.from(seg), pub, Buffer.from(sig, "base64url"));
  console.log(ok ? "VALID" : "INVALID");
  if (ok) console.log(JSON.parse(Buffer.from(seg, "base64url").toString("utf8")));
  else process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === "generate-keys") cmdGenerateKeys(args);
else if (cmd === "sign") cmdSign(args);
else if (cmd === "verify") cmdVerify(args);
else {
  console.error("Usage: node scripts/license-tool.mjs <generate-keys|sign|verify> [options]");
  process.exit(1);
}
