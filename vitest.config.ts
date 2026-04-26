import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["node_modules", "dist", "extension"],
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: "forks",
  },
});
