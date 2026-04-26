import * as fs from "fs";
import * as path from "path";
import ignore, { Ignore } from "ignore";
import { MAX_FILE_SIZE, File } from "./types";
import { isBinaryBuffer, isKeyishPath } from "./utils";

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".hg", ".svn", "dist", "build", ".next", ".nuxt", "target", "bin", "obj", ".cache", ".parcel-cache", ".turbo", ".vercel", ".terraform", ".open-context"]);

export interface FilterDecision { include: boolean; reason?: string; }

export class FileFilter {
  private gitignore: Ignore | null = null;
  private contextignore: Ignore | null = null;
  private maxFileSize: number;

  constructor(maxFileSize: number = MAX_FILE_SIZE) { this.maxFileSize = maxFileSize; }

  async loadIgnorePatterns(rootDir: string): Promise<void> {
    this.gitignore = await this.loadFile(path.join(rootDir, ".gitignore"));
    this.contextignore = await this.loadFile(path.join(rootDir, ".contextignore"));
  }

  private async loadFile(p: string): Promise<Ignore | null> {
    try { return ignore().add(await fs.promises.readFile(p, "utf8")); } catch { return null; }
  }

  shouldIncludePath(filePath: string): FilterDecision {
    if (filePath.includes("..")) return { include: false, reason: "path_traversal" };
    if (this.contextignore?.test(filePath).ignored) return { include: false, reason: "contextignore" };
    if (isKeyishPath(filePath)) return { include: false, reason: "keyish" };
    if (this.gitignore?.test(filePath).ignored) return { include: false, reason: "gitignore" };
    return { include: true };
  }

  shouldIncludeBuffer(filePath: string, buf: Buffer): FilterDecision {
    const pathDecision = this.shouldIncludePath(filePath);
    if (!pathDecision.include) return pathDecision;
    if (buf.length > this.maxFileSize) return { include: false, reason: "too_large" };
    if (isBinaryBuffer(buf)) return { include: false, reason: "binary" };
    return { include: true };
  }

  async collectFiles(rootDir: string, onProgress?: (n: number) => void): Promise<File[]> {
    await this.loadIgnorePatterns(rootDir);
    const files: File[] = [];
    let count = 0;
    const walk = async (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue;
          await walk(full);
          continue;
        }
        if (!e.isFile()) continue;
        const rp = path.relative(rootDir, full).replace(/\\/g, "/");
        if (!this.shouldIncludePath(rp).include) continue;
        try {
          const buf = await fs.promises.readFile(full);
          const decision = this.shouldIncludeBuffer(rp, buf);
          if (!decision.include) continue;
          files.push({ path: rp, contents: buf.toString("utf8") });
          onProgress?.(++count);
        } catch {
          // unreadable; skip
        }
      }
    };
    await walk(rootDir);
    return files;
  }
}
