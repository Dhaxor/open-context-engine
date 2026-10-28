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
  // Additional runtime deps imported from ../src/
  "openai",
  "minimatch",
  "ignore",
  "commander",
  "zod",
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

// Each webview is a separate browser bundle (its CSS import is emitted beside
// it). The host reads dist/<name>.{js,css} and inlines them, so no
// asWebviewUri/CSP gymnastics.
const settingsWebviewOptions = {
  entryPoints: ["src/settings/webview/main.ts"],
  bundle: true,
  outfile: "dist/settings-webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: false,
  minify,
  logLevel: "info",
};

// The agent UIs are React. Both bundle Trace's shared view-model, composer and
// markdown from ../src/trace, so the sidebar, the editor tab, Studio, and the
// TUI fold the same events the same way. React resolves from the repo root's
// node_modules (it is a root devDependency), keeping one copy in each bundle.
const agentWebviewOptions = {
  entryPoints: ["src/agent-ui/main.tsx"],
  bundle: true,
  outfile: "dist/agent.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": minify ? '"production"' : '"development"' },
  sourcemap: false,
  minify,
  logLevel: "info",
};

const studioWebviewOptions = {
  ...agentWebviewOptions,
  entryPoints: ["src/agent-ui/studio-main.tsx"],
  outfile: "dist/trace-studio.js",
};

const builds = [options, settingsWebviewOptions, agentWebviewOptions, studioWebviewOptions];

async function run() {
  if (watch) {
    const contexts = await Promise.all(builds.map(b => esbuild.context(b)));
    await Promise.all(contexts.map(c => c.watch()));
    console.log("[watch] esbuild watching extension + webviews…");
  } else {
    await Promise.all(builds.map(b => esbuild.build(b)));
    console.log(`[build] wrote dist/extension.js + webview bundles (agent, trace-studio, settings) (${minify ? "minified" : "sourcemap"})`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
