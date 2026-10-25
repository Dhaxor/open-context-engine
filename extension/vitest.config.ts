import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: { alias: { vscode: resolve(__dirname, "test/mocks/vscode.ts") } },
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], testTimeout: 15000, hookTimeout: 15000, pool: "forks" },
});
