import { defineConfig } from "vitest/config";
import { tmpdir } from "os";
import { join } from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["node_modules", "dist", "extension"],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: "forks",
    // No test reads the developer's own ~/.open-context (config, license,
    // policy, and the MCP servers an agent session would start). Tests that
    // need one point OCE_CONFIG_DIR at their own temp dir.
    env: { OCE_CONFIG_DIR: join(tmpdir(), "oce-vitest-no-user-config") },
  },
});
