// Pings the IndexNow API with the sitemap URLs whose content changed recently,
// so Bing (and the other IndexNow engines) queue them for a fresh crawl.
// A page's date moves only when its content does (scripts/site-dates.json,
// kept by build-site.mjs), so a nightly run no longer resubmits every URL.
// The key file lives at web/<key>.txt — public by design; IndexNow verifies
// ownership by fetching it.
//   node scripts/indexnow-ping.mjs [--dry-run] [--all] [--days N]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const all = args.includes("--all");
const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) || 2 : 2;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "web");
const sitemap = fs.readFileSync(path.join(webDir, "sitemap.xml"), "utf8");
const entries = [...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g)]
  .map(m => ({ url: m[1].trim(), lastmod: m[2]?.trim() }));

const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const urls = entries.filter(e => all || !e.lastmod || e.lastmod >= cutoff).map(e => e.url);
if (!urls.length) {
  console.log(`indexnow-ping: no page changed in the last ${days} day(s) — nothing to submit`);
  process.exit(0);
}

const keyFile = fs.readdirSync(webDir).find(f => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) {
  console.error("indexnow-ping: no <32-hex>.txt key file in web/");
  process.exit(1);
}
const key = keyFile.replace(".txt", "");

const body = JSON.stringify({
  host: "opencontextengine.com",
  key,
  keyLocation: `https://opencontextengine.com/${keyFile}`,
  urlList: urls,
});

console.log(`indexnow-ping: ${urls.length} of ${entries.length} URLs, key ${key.slice(0, 8)}…${dry ? " (dry run)" : ""}`);
if (dry) {
  console.log(urls.join("\n"));
  process.exit(0);
}

// api.indexnow.org fans out to every participating engine (Bing, Seznam, Yandex, Naver).
const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body,
});
// 200/202 = accepted; 429 = keyed back-off, safe to ignore on cron runs.
console.log(`indexnow-ping: HTTP ${res.status}`);
if (!res.ok && res.status !== 429) process.exit(1);
