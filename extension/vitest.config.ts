import { defineConfig } from "vitest/config";
import { tmpdir } from "os";
import { join, resolve } from "path";

export default defineConfig({
  resolve: { alias: { vscode: resolve(__dirname, "test/mocks/vscode.ts") } },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: "forks",
    // Never the developer's own ~/.open-context — it can list MCP servers a
    // TraceHost would start.
    env: { OCE_CONFIG_DIR: join(tmpdir(), "oce-vitest-no-user-config") },
  },
});
