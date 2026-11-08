// Pings the IndexNow API with every URL in web/sitemap.xml so Bing (and the
// other IndexNow engines) queue them for immediate crawl after a deploy.
// The key file lives at web/<key>.txt — it is public by design; IndexNow
// verifies ownership by fetching it.
//   node scripts/indexnow-ping.mjs [--dry-run]
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const dry = process.argv.includes("--dry-run");
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const sitemap = fs.readFileSync(path.join(webDir, "sitemap.xml"), "utf8");
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());

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

console.log(`indexnow-ping: ${urls.length} URLs, key ${key.slice(0, 8)}…${dry ? " (dry run)" : ""}`);
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
