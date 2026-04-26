import * as fs from "fs";
import * as path from "path";
import chokidar, { FSWatcher } from "chokidar";
import { OpenContext } from "./context";
import { OpenContextConfig, File, IndexingResult } from "./types";
import { FileFilter } from "./file-filter";

const SKIP_SEGMENTS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".hg", ".svn", "dist", "build", ".next", ".nuxt", "target", "bin", "obj", ".cache", ".parcel-cache", ".turbo", ".vercel", ".terraform", ".open-context"]);

export interface FileWatcherEvents {
  onReindex?: (result: IndexingResult) => void;
  onError?: (err: Error) => void;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private changedPaths: Set<string> = new Set();
  private removedPaths: Set<string> = new Set();
  private filter: FileFilter;
  private processing = false;
  private queued = false;

  constructor(
    private context: OpenContext,
    private config: OpenContextConfig,
    private debounceMs: number = 1500,
  ) {
    this.filter = new FileFilter(config.maxFileSize);
  }

  async start(events: FileWatcherEvents = {}): Promise<void> {
    const root = path.resolve(this.config.workspaceRoot);
    await this.filter.loadIgnorePatterns(root);
    this.watcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p, stats) => this.shouldIgnore(root, p, stats),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    const onChange = (p: string) => this.queueChange(root, p);
    const onUnlink = (p: string) => this.queueUnlink(root, p);
    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
    this.watcher.on("unlink", onUnlink);
    this.watcher.on("error", (err: unknown) => events.onError?.(err instanceof Error ? err : new Error(String(err))));
    (this as any)._events = events;
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    await this.watcher?.close();
    this.watcher = null;
  }

  private shouldIgnore(root: string, absPath: string, stats?: fs.Stats): boolean {
    const rel = path.relative(root, absPath).replace(/\\/g, "/");
    if (!rel) return false;
    const segments = rel.split("/");
    if (segments.some(s => SKIP_SEGMENTS.has(s))) return true;
    if (segments.some(s => s.startsWith(".") && s !== ".github")) return true;
    if (stats?.isFile()) return !this.filter.shouldIncludePath(rel).include;
    return false;
  }

  private queueChange(root: string, abs: string): void {
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (!rel || !this.filter.shouldIncludePath(rel).include) return;
    this.removedPaths.delete(rel);
    this.changedPaths.add(rel);
    this.scheduleFlush();
  }

  private queueUnlink(root: string, abs: string): void {
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (!rel) return;
    this.changedPaths.delete(rel);
    this.removedPaths.add(rel);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => { void this.flush(); }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.processing) { this.queued = true; return; }
    this.processing = true;
    try {
      const changed = [...this.changedPaths]; this.changedPaths.clear();
      const removed = [...this.removedPaths]; this.removedPaths.clear();
      const root = path.resolve(this.config.workspaceRoot);
      const files: File[] = [];
      for (const rel of changed) {
        try {
          const buf = await fs.promises.readFile(path.join(root, rel));
          const decision = this.filter.shouldIncludeBuffer(rel, buf);
          if (!decision.include) { this.removedPaths.add(rel); continue; }
          files.push({ path: rel, contents: buf.toString("utf8") });
        } catch {
          this.removedPaths.add(rel);
        }
      }
      const events: FileWatcherEvents = (this as any)._events ?? {};
      try {
        if (removed.length) await this.context.removeFromIndex(removed);
        if (files.length) {
          const result = await this.context.addFiles(files);
          events.onReindex?.(result);
        } else if (removed.length) {
          events.onReindex?.({ newlyIndexed: [], alreadyIndexed: [], removed, duration: 0 });
        }
      } catch (err) {
        events.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.processing = false;
      if (this.queued) { this.queued = false; this.scheduleFlush(); }
    }
  }
}
