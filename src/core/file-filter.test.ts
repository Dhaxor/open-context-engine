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

async function write(root: string, rel: string, contents = "x\n"): Promise<void> {
  const full = path.join(root, rel);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, contents);
}

describe("FileFilter gitignore handling", () => {
  it("honors nested .gitignore files", async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-gi-"));
    await write(tmp, "pkg/.gitignore", "generated/\n");
    await write(tmp, "pkg/src/keep.ts");
    await write(tmp, "pkg/generated/skip.ts");
    await write(tmp, "root.ts");
    const files = await new FileFilter().collectFiles(tmp);
    const paths = files.map(f => f.path).sort();
    expect(paths).toContain("pkg/src/keep.ts");
    expect(paths).toContain("root.ts");
    expect(paths).not.toContain("pkg/generated/skip.ts");
  });

  it("applies a root .gitignore dir pattern at any depth", async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-gi-"));
    await write(tmp, ".gitignore", "build/\n");
    await write(tmp, "build/out.js");
    await write(tmp, "a/build/out.js");
    await write(tmp, "a/keep.ts");
    const paths = (await new FileFilter().collectFiles(tmp)).map(f => f.path);
    expect(paths).toContain("a/keep.ts");
    expect(paths).not.toContain("build/out.js");
    expect(paths).not.toContain("a/build/out.js");
  });

  it("honors .git/info/exclude", async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-gi-"));
    await write(tmp, ".git/info/exclude", "notes.txt\n");
    await write(tmp, "notes.txt");
    await write(tmp, "keep.ts");
    const paths = (await new FileFilter().collectFiles(tmp)).map(f => f.path);
    expect(paths).toContain("keep.ts");
    expect(paths).not.toContain("notes.txt");
  });

  it("lets a deeper .gitignore re-include via negation", async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "oce-gi-"));
    await write(tmp, ".gitignore", "*.log\n");
    await write(tmp, "pkg/.gitignore", "!keep.log\n");
    await write(tmp, "pkg/keep.log");
    await write(tmp, "pkg/drop.log");
    await write(tmp, "top.log");
    const paths = (await new FileFilter().collectFiles(tmp)).map(f => f.path);
    expect(paths).toContain("pkg/keep.log");
    expect(paths).not.toContain("pkg/drop.log");
    expect(paths).not.toContain("top.log");
  });
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
