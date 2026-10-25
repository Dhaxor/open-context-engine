// Build the Trace Studio bundle.
//
// Mirrors extension/build.js — esbuild, no second build system in this repo.
// Everything is bundled into two files served from dist/trace/studio, so React
// and cmdk stay devDependencies: the published package ships static assets, not
// a runtime dependency on a UI framework.
//
// The :root custom properties are generated from src/trace/tokens.ts and
// inlined into the shell at build time. That is what makes tokens.ts the single
// source for both Studio and the TUI — there is no CSS file with a second copy
// of the palette to drift.

const crypto = require("crypto");
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const minify = args.has("--minify");

const outdir = path.join(__dirname, "dist", "trace", "studio");

/** Run tokens.ts through esbuild so the build never depends on `tsc` having
 *  already emitted, and so a token change is picked up on every build. */
async function renderTokens() {
  const built = await esbuild.build({
    entryPoints: [path.join(__dirname, "src", "trace", "tokens.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });
  const module = { exports: {} };
  new Function("module", "exports", built.outputFiles[0].text)(module, module.exports);
  return module.exports.cssVariables();
}

/** Content stamp for the bundle URLs.
 *
 *  The filenames are stable across releases, so without this an upgraded `oce`
 *  can serve a new API to a Studio the browser still has cached — which shows
 *  up as mysteriously missing data rather than as an error. Stamping the query
 *  makes a new build a new URL, which no cache can confuse with the old one. */
function stamp(file) {
  const contents = fs.readFileSync(file);
  return crypto.createHash("sha256").update(contents).digest("hex").slice(0, 8);
}

function shell(css, jsStamp, cssStamp) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Trace</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" />
<style>${css}</style>
<link rel="stylesheet" href="/studio.css?v=${cssStamp}" />
</head>
<body>
<div id="root"></div>
<script src="/studio.js?v=${jsStamp}"></script>
</body>
</html>
`;
}

const options = {
  entryPoints: [path.join(__dirname, "src", "trace", "studio", "main.tsx")],
  bundle: true,
  outfile: path.join(outdir, "studio.js"),
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  sourcemap: !minify,
  minify,
  // esbuild emits the imported CSS beside the JS using the entry's name.
  loader: { ".css": "css" },
  logLevel: "info",
};

/** The shell is written AFTER the bundle so it can stamp the real output. */
async function writeShell() {
  fs.mkdirSync(outdir, { recursive: true });
  const js = path.join(outdir, "studio.js");
  const css = path.join(outdir, "studio.css");
  fs.writeFileSync(
    path.join(outdir, "index.html"),
    shell(await renderTokens(), fs.existsSync(js) ? stamp(js) : "dev", fs.existsSync(css) ? stamp(css) : "dev"),
  );
}

async function run() {
  fs.mkdirSync(outdir, { recursive: true });
  if (watch) {
    const ctx = await esbuild.context({
      ...options,
      plugins: [{
        name: "restamp-shell",
        setup(build) { build.onEnd(() => writeShell()); },
      }],
    });
    await ctx.watch();
    console.log("[watch] esbuild watching Trace Studio…");
  } else {
    await esbuild.build(options);
    await writeShell();
    console.log(`[build] wrote ${path.relative(__dirname, outdir)}/{index.html,studio.js,studio.css}`);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
