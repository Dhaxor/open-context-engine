import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { FileFilter } from "./file-filter";

let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("FileFilter.collectStats", () => {
  it("counts included and skipped files by reason", async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-filter-"));
    await fs.promises.writeFile(path.join(tmp, ".contextignore"), "ignored.txt\n");
    await fs.promises.writeFile(path.join(tmp, "ok.ts"), "export const ok = true;\n");
    await fs.promises.writeFile(path.join(tmp, "ignored.txt"), "ignored\n");
    await fs.promises.writeFile(path.join(tmp, "huge.txt"), "1234567890123456789012345678901");
    await fs.promises.writeFile(path.join(tmp, "secret.pem"), "key\n");

    const stats = await new FileFilter(30).collectStats(tmp);

    expect(stats.scannedFiles).toBe(5);
    expect(stats.includedFiles).toBeGreaterThanOrEqual(1);
    expect(stats.skippedByReason.contextignore).toBe(1);
    expect(stats.skippedByReason.too_large).toBe(1);
    expect(stats.skippedByReason.keyish).toBe(1);
    expect(stats.examplesByReason.too_large).toContain("huge.txt");
  });
});
