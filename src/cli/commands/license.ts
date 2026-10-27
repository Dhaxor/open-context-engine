import { resolveActivationEmail } from "../config";
import { CliIo } from "../io";
import { getLicense, verifyLicenseToken, saveLicenseToken, clearLicense, checkOrgDomainBinding } from "../../core/license";
import { loadPolicy, describePolicy } from "../../core/policy";
import { defaultAuditDir, readAuditEvents, verifyAuditChain } from "../../core/audit";
import { DEFAULT_MODEL_FOR_PROVIDER } from "../../core/types";

/** Where Polar license keys are exchanged for signed tokens. Overridable for
 *  tests/self-hosting; the default is the vendor's Worker. */
export const DEFAULT_LICENSE_SERVER = process.env.OCE_LICENSE_SERVER || "https://open-context-engine.emperorduke5.workers.dev";

/** A Polar license key (from the order email) is exchanged online for a signed
 *  offline token. A full signed token (`xxx.yyy`) passes through untouched —
 *  activation itself stays offline. */
export async function maybeExchangePolarKey(key: string, io: CliIo): Promise<string> {
  if (!/^polar_lk_/i.test(key.trim())) return key;
  const email = resolveActivationEmail();
  if (!email) {
    io.fatal(
      "Activating a Polar license needs your email for org binding. Set it with `git config user.email you@company.com` or OCE_ACTIVATION_EMAIL, then re-run.",
    );
  }
  io.progress("Exchanging Polar license key…\n");
  let token: string | undefined;
  let failure: string | undefined;
  try {
    const res = await fetch(`${DEFAULT_LICENSE_SERVER}/api/license/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ licenseKey: key.trim(), email }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.token) {
      failure = body?.error || `license server returned ${res.status}`;
    } else {
      token = String(body.token);
    }
  } catch {
    failure = `could not reach the license server (${DEFAULT_LICENSE_SERVER}) — check your connection, or use the full signed token from support for offline activation`;
  }
  if (!token) io.fatal(`Activation failed: ${failure}.`);
  return token;
}

export function registerMiscCommands(program: import("commander").Command, io: CliIo): void {
  const { text, json, error } = io;

  program.command("setup").description("Get a working model — shows the free options and writes the config")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("-p, --provider <name>", "Configure this provider directly instead of listing options")
    .option("--llm-model <model>", "Model to record (default: the provider's)")
    .option("--embeddings <provider>", "Record the embedding provider for semantic search: ollama | voyage | openai | local | none")
    .option("--json", "Emit the detected state as JSON")
    .action(async (opts: any) => {
      const { PROVIDER_PRESETS, findPreset, freePresets, keyFor, probeOllama } = await import("../../agent/presets");
      const fsMod = await import("fs");
      const pathMod = await import("path");

      if (opts.embeddings) {
        const choice = String(opts.embeddings).toLowerCase();
        const allowed = ["ollama", "voyage", "openai", "local", "none"];
        if (!allowed.includes(choice)) {
          error(`Unknown embedding provider '${choice}'. Use one of: ${allowed.join(", ")}`);
          process.exitCode = 1;
          return;
        }
        const dir = pathMod.join(opts.workspace || process.cwd(), ".open-context");
        const file = pathMod.join(dir, "config.json");
        let existing: any = {};
        try { existing = JSON.parse(fsMod.readFileSync(file, "utf8")); } catch {}
        const next = { ...existing, embedding: { provider: choice, model: DEFAULT_MODEL_FOR_PROVIDER[choice as keyof typeof DEFAULT_MODEL_FOR_PROVIDER] } };
        fsMod.mkdirSync(dir, { recursive: true });
        fsMod.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
        text(`Wrote ${file}`);
        text(`  embeddings · ${choice}${choice === "none" ? " (keyword search)" : ` · ${next.embedding.model}`}`);
        // Switching providers changes the embedding space, so the index rebuilds.
        if (choice !== "none") text(`\nNext: oce index   (rebuilds the index with ${choice} embeddings)`);
        if (!opts.provider) return;
      }

      const ollama = await probeOllama();
      const detected = PROVIDER_PRESETS
        .map(p => ({ preset: p, key: keyFor(p) }))
        .filter(d => d.key || (d.preset.id === "ollama" && ollama.up));

      if (opts.json) {
        json({
          ollama,
          ready: detected.map(d => d.preset.id),
          presets: PROVIDER_PRESETS.map(p => ({ id: p.id, label: p.label, cost: p.cost, model: p.model })),
        });
        return;
      }

      // Writing the choice is the whole point: the next `oce trace` should just work.
      const write = (id: string): void => {
        const preset = findPreset(id);
        if (!preset) { error(`Unknown provider '${id}'. Try one of: ${PROVIDER_PRESETS.map(p => p.id).join(", ")}`); process.exitCode = 1; return; }
        const dir = pathMod.join(opts.workspace || process.cwd(), ".open-context");
        const file = pathMod.join(dir, "config.json");
        let existing: any = {};
        try { existing = JSON.parse(fsMod.readFileSync(file, "utf8")); } catch {}
        const next = {
          ...existing,
          llm: {
            provider: preset.provider,
            model: opts.llmModel || preset.model,
            ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
          },
        };
        fsMod.mkdirSync(dir, { recursive: true });
        fsMod.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
        text(`Wrote ${file}`);
        text(`  ${preset.label} · ${next.llm.model}`);
        const key = keyFor(preset);
        if (!key && preset.keyEnv.length) {
          text(`\nStill needed: ${preset.setup}`);
          text(`Then: export ${preset.keyEnv[0]}=...`);
        } else {
          text(`\nReady. Try:  oce trace`);
        }
      };

      if (opts.provider) return write(opts.provider);

      text("Open Context Engine — pick a model\n");
      if (ollama.up) {
        text(`✓ Ollama is running locally${ollama.models.length ? ` (${ollama.models.slice(0, 3).join(", ")})` : " — no models pulled yet"}`);
        text("  Free, offline, no key. Best default if you have the RAM.\n");
      }
      for (const d of detected.filter(d => d.key)) {
        text(`✓ ${d.preset.label} — key found in the environment`);
      }
      if (detected.length) text("");

      text("Free options:");
      for (const preset of freePresets()) {
        const ready = preset.id === "ollama" ? ollama.up : !!keyFor(preset);
        text(`  ${ready ? "✓" : " "} ${preset.id.padEnd(11)} ${preset.label}`);
        text(`      ${preset.note}`);
        if (!ready) text(`      ${preset.setup}`);
      }
      text("\nPaid:");
      for (const preset of PROVIDER_PRESETS.filter(p => p.cost === "paid")) {
        text(`  ${keyFor(preset) ? "✓" : " "} ${preset.id.padEnd(11)} ${preset.label}`);
      }

      // Retrieval has its own provider, separate from the chat model. Without
      // one the engine runs keyword search, which works — this is how to get
      // semantic ranking on top.
      const hasEmbedModel = ollama.models.some(m => m.startsWith("nomic-embed-text"));
      text("\nSemantic search (embeddings — separate from the chat model):");
      text(`  ${ollama.up && hasEmbedModel ? "✓" : " "} ollama      free, local — ollama pull nomic-embed-text`);
      text(`  ${process.env.VOYAGE_API_KEY ? "✓" : " "} voyage      best code retrieval — key at https://dash.voyageai.com`);
      text(`  ${process.env.OPENAI_API_KEY ? "✓" : " "} openai      text-embedding-3-small — uses OPENAI_API_KEY`);
      text(`    none        keyword search only (what runs when nothing is set)`);

      text(`\nChoose a chat model:   oce setup -p <name>`);
      text(`Choose embeddings:     oce setup --embeddings <name>`);
      text(`Or just run:           oce trace -p <name>`);
    });

  program.command("audit").description("Inspect the tamper-evident audit log")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--store-path <path>", "Custom store directory (default: .open-context/)")
    .option("--type <type>", "Only events of this type (run-start, tool-call, run-end, mcp, …)")
    .option("--since <date>", "Only events at/after this ISO date/time")
    .option("--limit <n>", "Show only the last N matching events", "50")
    .option("--verify", "Verify the hash chain and report tampering")
    .option("--json", "Print raw JSONL events")
    .action((opts: any) => {
      const dir = defaultAuditDir(opts.workspace, opts.storePath);
      const all = readAuditEvents(dir);
      if (!all.length) { if (opts.json) json([]); else text(`No audit events found in ${dir}.`); return; }
      if (opts.verify) {
        const v = verifyAuditChain(all);
        if (v.ok) text(`✓ chain intact — ${v.checked} events verified.`);
        else { error(`✗ TAMPERED at seq ${v.brokenAtSeq}: ${v.reason} (${v.checked} events verified before the break)`); process.exitCode = 1; }
        return;
      }
      const events = readAuditEvents(dir, {
        type: opts.type,
        since: opts.since ? new Date(opts.since) : undefined,
        limit: Math.max(1, Number(opts.limit)),
      });
      if (opts.json) { json(events); return; }
      for (const e of events) {
        const detail = Object.entries(e.data).map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 120) : JSON.stringify(v)}`).join(" ");
        text(`${e.ts}  #${e.seq}  ${e.type.padEnd(10)} ${detail}`);
      }
      text(`\n${events.length} of ${all.length} events shown (${dir}). Use --verify to check integrity.`);
    });

  program.command("policy").description("Show the effective policy for a workspace (user + workspace + org lock)")
    .option("-w, --workspace <path>", "Workspace", process.cwd())
    .option("--json", "Print the effective policy as JSON")
    .action((opts: any) => {
      const p = loadPolicy(opts.workspace);
      if (opts.json) { json(p); return; }
      text(describePolicy(p));
      if (p.sources.length) text(`Sources:\n${p.sources.map(s => `  - ${s}`).join("\n")}`);
      for (const w of p.warnings) text(`⚠ ${w}`);
    });

  program.command("activate <key>").description("Activate a Team/Enterprise license (a Polar license key from your order email, or a full signed token)").action(async (key: string) => {
    // Opportunistic revocation refresh (only when a URL is configured — the
    // engine never phones home unprompted). Best-effort: offline still works.
    try { const { refreshRevocations } = await import("../../core/license"); await refreshRevocations(); } catch {}
    const token = await maybeExchangePolarKey(key, io);
    const status = verifyLicenseToken(token);
    if (!status.valid) {
      const why = status.reason === "expired" ? "this license has expired"
        : status.reason === "bad-signature" ? "invalid signature (is the key correct and complete?)"
        : "malformed license key";
      io.fatal(`Activation failed: ${why}.`);
    }
    {
      const { loadCachedRevocations } = await import("../../core/license");
      if (status.payload?.id && loadCachedRevocations()?.revoked.includes(status.payload.id)) {
        io.fatal("Activation failed: this license has been revoked.");
      }
    }
    // SSO-lite: a domain-bound license only activates for a matching identity.
    const domainCheck = checkOrgDomainBinding(status.payload, resolveActivationEmail());
    if (domainCheck === "mismatch") {
      io.fatal(`Activation failed: this license is bound to @${status.payload?.orgDomain} email addresses, but your identity (git config user.email / OCE_ACTIVATION_EMAIL) does not match.`);
    }
    if (domainCheck === "unverifiable") {
      error(`⚠ License is bound to @${status.payload?.orgDomain} but no local email identity was found — proceeding. Set OCE_ACTIVATION_EMAIL or git config user.email to silence this.`);
    }
    const p = saveLicenseToken(token);
    const exp = status.payload?.exp ? new Date(status.payload.exp * 1000).toISOString().slice(0, 10) : "perpetual";
    text(`Activated ${status.plan} license for ${status.payload?.org} — ${status.payload?.seats} seat(s), expires ${exp}.`);
    text(`Saved to ${p}`);
  });

  program.command("license").description("Show the current license status")
    .option("--refresh [url]", "Fetch the signed revocation list (from the given URL or OCE_REVOCATION_URL) before checking")
    .action(async (opts: any) => {
    if (opts.refresh) {
      const { refreshRevocations } = await import("../../core/license");
      const list = await refreshRevocations(typeof opts.refresh === "string" ? opts.refresh : undefined);
      if (list) text(`Revocation list refreshed (${list.revoked.length} entries, updated ${new Date(list.updatedAt * 1000).toISOString().slice(0, 10)}).`);
      else text("Revocation list not refreshed (no URL configured, or fetch/verify failed) — continuing with the cached list.");
    }
    const s = getLicense();
    if (!s.valid) {
      if (s.reason === "expired") text(`License expired (was ${s.payload?.plan} for ${s.payload?.org}). Running as Community (free) edition.`);
      else if (s.reason === "revoked") text(`License ${s.payload?.id} for ${s.payload?.org} has been REVOKED. Running as Community (free) edition — contact support if this is unexpected.`);
      else text("No active license — running as Community (free) edition. Activate with 'oce activate <key>'.");
      return;
    }
    const exp = s.payload?.exp ? new Date(s.payload.exp * 1000).toISOString().slice(0, 10) : "perpetual";
    text(`Plan:    ${s.plan}`);
    text(`Org:     ${s.payload?.org}`);
    text(`Seats:   ${s.payload?.seats}`);
    text(`Expires: ${exp}`);
    if (s.inGrace) text(`\n⚠ In grace period — ${s.daysLeft} day(s) left. Please renew to avoid interruption.`);
  });

  program.command("deactivate").description("Remove the saved license key").action(() => {
    text(clearLicense() ? "License removed — now running as Community edition." : "No license was active.");
  });
}
