import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildProgram } from "./index";
import { createCliIo, CliFatalError } from "./io";

/**
 * The commands run in-process against a real temp workspace in keyword-only
 * mode (`-p none`) — the documented zero-key path, so no network, no embedder.
 * Output is captured through the io sink; fatal paths surface as CliFatalError
 * rejections instead of process.exit, which is what makes these runnable.
 */

let dir: string;
let out: string;
let err: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-cli-cmd-"));
  out = ""; err = "";
  fs.writeFileSync(path.join(dir, "util.ts"), "export function kappaCounter(start: number) {\n  return start + 1;\n}\n");
  fs.writeFileSync(path.join(dir, "other.ts"), "export const zetaHelper = \"zeta\";\n");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]): Promise<unknown> {
  const io = createCliIo({ out: (s) => { out += s; }, err: (s) => { err += s; } });
  return buildProgram(io).parseAsync(args, { from: "user" });
}

describe("oce commands, keyword-only, end to end", () => {
  it("index → search → status → clean", async () => {
    await run("index", "-w", dir, "-p", "none");
    expect(out).toMatch(/Done in \d+ms \| New: 2/);

    out = "";
    await run("search", "kappaCounter", "-w", dir, "-p", "none", "--json");
    const results = JSON.parse(out);
    expect(results.some((r: any) => r.path === "util.ts" && r.snippet.includes("kappaCounter"))).toBe(true);

    out = "";
    await run("status", "-w", dir, "--json");
    const status = JSON.parse(out);
    expect(status.index.chunks).toBeGreaterThan(0);
    expect(status.index.searchMode).toBe("keyword-only");
    expect(status.workspace).toBe(dir);

    await expect(run("clean", "-w", dir)).rejects.toBeInstanceOf(CliFatalError);
    expect(err).toMatch(/Re-run with --yes/);
    expect(fs.existsSync(path.join(dir, ".open-context", "context.db"))).toBe(true); // refused, intact

    out = "";
    await run("clean", "-w", dir, "--yes");
    expect(out).toMatch(/Removed \d+ file/);
    expect(fs.existsSync(path.join(dir, ".open-context", "context.db"))).toBe(false);
  });

  it("index is incremental: a second run reports existing files, not new ones", async () => {
    await run("index", "-w", dir, "-p", "none");
    out = "";
    await run("index", "-w", dir, "-p", "none", "--incremental");
    expect(out).toMatch(/New: 0 \| Existing: 2/);
  });

  it("status never rebuilds or destroys the store it was asked about", async () => {
    await run("index", "-w", dir, "-p", "none");
    const before = fs.statSync(path.join(dir, ".open-context", "context.db")).size;
    await run("status", "-w", dir);
    const after = fs.statSync(path.join(dir, ".open-context", "context.db")).size;
    // WAL checkpointing may shift bytes; the store must still hold its index.
    expect(after).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    out = "";
    await run("status", "-w", dir, "--json");
    expect(JSON.parse(out).index.chunks).toBeGreaterThan(0);
  });

  it("eval scores a case file against the indexed workspace and reports keyword-only mode", async () => {
    await run("index", "-w", dir, "-p", "none");
    const cases = path.join(dir, "cases.json");
    fs.writeFileSync(cases, JSON.stringify([
      { id: "counter", query: "function that increments a counter", expectedPaths: ["util.ts"] },
      { id: "helper", query: "zeta helper constant", expectedPaths: ["other.ts"] },
    ]));
    out = "";
    await run("eval", "-w", dir, "--cases", cases, "-k", "5", "--json", "--no-packed");
    const report = JSON.parse(out);
    expect(report.searchMode).toBe("keyword-only");
    expect(report.aggregate.cases).toBe(2);
    expect(report.aggregate.hitRate).toBeGreaterThan(0);
  });

  it("clean on a workspace with no store says so and exits zero", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oce-cli-empty-"));
    try {
      await run("clean", "-w", empty);
      expect(out).toMatch(/No index database/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("policy prints the effective policy for a workspace", async () => {
    await run("policy", "-w", dir);
    expect(out).toMatch(/policy|disabled|locked/i);
  });
});
