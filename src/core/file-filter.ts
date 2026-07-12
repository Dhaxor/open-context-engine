import * as fs from "fs";
import * as path from "path";
import ignore, { Ignore } from "ignore";
import { MAX_FILE_SIZE, File } from "./types";
import { isBinaryBuffer, isKeyishPath } from "./utils";

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".hg", ".svn", "dist", "build", ".next", ".nuxt", "target", "bin", "obj", ".cache", ".parcel-cache", ".turbo", ".vercel", ".terraform", ".open-context"]);

export interface FilterDecision { include: boolean; reason?: string; }
export interface FilterStats {
  scannedFiles: number;
  includedFiles: number;
  skippedFiles: number;
  skippedByReason: Record<string, number>;
  examplesByReason: Record<string, string[]>;
  unreadableFiles: string[];
}

export class FileFilter {
  private contextignore: Ignore | null = null;
  private policyIgnore: Ignore | null = null;
  private maxFileSize: number;
  private root = "";
  // Per-directory .gitignore matchers, keyed by directory path relative to root
  // ("" = root, which also folds in .git/info/exclude). Loaded lazily, cached.
  private gitMatchers = new Map<string, Ignore | null>();

  constructor(maxFileSize: number = MAX_FILE_SIZE, policyIgnorePatterns?: string[]) {
    this.maxFileSize = maxFileSize;
    if (policyIgnorePatterns?.length) this.policyIgnore = ignore().add(policyIgnorePatterns.join("\n"));
  }

  async loadIgnorePatterns(rootDir: string): Promise<void> {
    this.root = rootDir;
    this.gitMatchers.clear();
    this.contextignore = await this.loadFile(path.join(rootDir, ".contextignore"));
  }

  private async loadFile(p: string): Promise<Ignore | null> {
    try { return ignore().add(await fs.promises.readFile(p, "utf8")); } catch { return null; }
  }

  private getGitMatcher(dirRel: string): Ignore | null {
    const cached = this.gitMatchers.get(dirRel);
    if (cached !== undefined) return cached;
    const sources: string[] = [];
    try { sources.push(fs.readFileSync(path.join(this.root, dirRel, ".gitignore"), "utf8")); } catch {}
    if (dirRel === "") {
      try { sources.push(fs.readFileSync(path.join(this.root, ".git", "info", "exclude"), "utf8")); } catch {}
    }
    const matcher = sources.length ? ignore().add(sources.join("\n")) : null;
    this.gitMatchers.set(dirRel, matcher);
    return matcher;
  }

  private ancestorDirs(relPath: string): string[] {
    const dirs = [""];
    const segments = relPath.split("/");
    let acc = "";
    for (let i = 0; i < segments.length - 1; i++) {
      acc = acc ? `${acc}/${segments[i]}` : segments[i];
      dirs.push(acc);
    }
    return dirs;
  }

  // Apply every applicable .gitignore from root down to the path's directory,
  // with deeper files overriding shallower ones (matching git's precedence,
  // including negation re-includes).
  private gitIgnored(relPath: string): boolean {
    let ignored = false;
    for (const dir of this.ancestorDirs(relPath)) {
      const matcher = this.getGitMatcher(dir);
      if (!matcher) continue;
      const sub = dir === "" ? relPath : relPath.slice(dir.length + 1);
      if (!sub) continue;
      const t = matcher.test(sub);
      if (t.ignored) ignored = true;
      else if (t.unignored) ignored = false;
    }
    return ignored;
  }

  shouldIncludePath(filePath: string): FilterDecision {
    if (filePath.includes("..")) return { include: false, reason: "path_traversal" };
    if (this.policyIgnore?.test(filePath).ignored) return { include: false, reason: "policy" };
    if (this.contextignore?.test(filePath).ignored) return { include: false, reason: "contextignore" };
    if (isKeyishPath(filePath)) return { include: false, reason: "keyish" };
    if (this.gitIgnored(filePath)) return { include: false, reason: "gitignore" };
    return { include: true };
  }

  /** Whether to descend into a directory (so ignored subtrees are pruned, not walked). */
  shouldIncludeDir(dirRel: string): boolean {
    if (!dirRel || dirRel.includes("..")) return !dirRel ? true : false;
    if (this.policyIgnore?.test(dirRel).ignored) return false;
    if (this.contextignore?.test(dirRel).ignored) return false;
    return !this.gitIgnored(dirRel);
  }

  shouldIncludeBuffer(filePath: string, buf: Buffer): FilterDecision {
    const pathDecision = this.shouldIncludePath(filePath);
    if (!pathDecision.include) return pathDecision;
    if (buf.length > this.maxFileSize) return { include: false, reason: "too_large" };
    if (isBinaryBuffer(buf)) return { include: false, reason: "binary" };
    return { include: true };
  }

  async collectStats(rootDir: string, maxExamples = 8): Promise<FilterStats> {
    await this.loadIgnorePatterns(rootDir);
    const stats: FilterStats = { scannedFiles: 0, includedFiles: 0, skippedFiles: 0, skippedByReason: {}, examplesByReason: {}, unreadableFiles: [] };
    const recordSkip = (rp: string, reason = "unknown") => {
      stats.skippedFiles++;
      stats.skippedByReason[reason] = (stats.skippedByReason[reason] ?? 0) + 1;
      const examples = stats.examplesByReason[reason] ?? (stats.examplesByReason[reason] = []);
      if (examples.length < maxExamples) examples.push(rp);
    };
    const walk = async (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")) continue;
          const dirRel = path.relative(rootDir, full).replace(/\\/g, "/");
          if (!this.shouldIncludeDir(dirRel)) continue;
          await walk(full);
          continue;
        }
        if (!e.isFile()) continue;
        const rp = path.relative(rootDir, full).replace(/\\/g, "/");
        stats.scannedFiles++;
        const pathDecision = this.shouldIncludePath(rp);
        if (!pathDecision.include) { recordSkip(rp, pathDecision.reason); continue; }
        try {
          const st = await fs.promises.stat(full);
          if (st.size > this.maxFileSize) { recordSkip(rp, "too_large"); continue; }
          const decision = this.shouldIncludeBuffer(rp, await fs.promises.readFile(full));
          if (!decision.include) recordSkip(rp, decision.reason);
          else stats.includedFiles++;
        } catch {
          if (stats.unreadableFiles.length < maxExamples) stats.unreadableFiles.push(rp);
        }
      }
    };
    await walk(rootDir);
    return stats;
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
          const dirRel = path.relative(rootDir, full).replace(/\\/g, "/");
          if (!this.shouldIncludeDir(dirRel)) continue;
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
