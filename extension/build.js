// Build script for the VS Code extension.
// Native and WASM modules must be loaded from extension/node_modules at runtime,
// so they are marked external and resolved by Node's require() at runtime.
const esbuild = require("esbuild");

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const minify = args.has("--minify");

const external = [
  "vscode",
  // Native bindings — cannot be bundled
  "better-sqlite3",
  "chokidar",
  "fsevents",
  // sqlite-vec uses createRequire(__filename) to resolve prebuilt native extensions
  "sqlite-vec",
  "sqlite-vec-linux-x64",
  "sqlite-vec-linux-arm64",
  "sqlite-vec-darwin-x64",
  "sqlite-vec-darwin-arm64",
  "sqlite-vec-windows-x64",
  // Tree-sitter WASM runtime needs access to its own assets
  "web-tree-sitter",
  "tree-sitter-wasms",
  // Optional providers (only required if user opts in)
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  "@ai-sdk/openai",
];

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: !minify,
  minify,
  external,
  logLevel: "info",
};

async function run() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[watch] esbuild watching for changes…");
  } else {
    await esbuild.build(options);
    console.log(`[build] wrote ${options.outfile} (${minify ? "minified" : "sourcemap"})`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
