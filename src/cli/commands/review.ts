/**
 * `oce review` — PR review agent. Consumes a unified diff, grounds each
 * change in the indexed codebase, and runs the agent non-interactively to
 * produce markdown review comments.
 *
 * Built for CI: the GitHub Action installs OCE, indexes the checkout (or
 * pulls a cached team index), feeds the PR diff to this command, and posts
 * the markdown output as a review comment. Works locally too — pipe any
 * diff: `git diff main..feature | oce review`.
 */
import { Command } from "commander";
import * as fs from "fs";
import { CliIo } from "../io";
import { resolveConfig } from "../config";
import { buildSession } from "../session";

export interface DiffFile {
  path: string;
  /** Added/modified lines with their new-file line numbers, grouped by hunk. */
  hunks: { newStart: number; lines: string[] }[];
}

/** Minimal unified-diff parser: enough for `git diff` / `gh pr diff` output.
 *  Returns one entry per changed file with its added/modified lines grouped
 *  by hunk start. Deleted-file-only hunks yield no reviewable lines. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      current = { path: fileMatch[1], hunks: [] };
      files.push(current);
      continue;
    }
    if (/^--- /.test(line)) continue;
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunkMatch && current) {
      newLine = Number(hunkMatch[1]);
      current.hunks.push({ newStart: newLine, lines: [] });
      continue;
    }
    if (!current || !current.hunks.length) continue;
    const hunk = current.hunks[current.hunks.length - 1];
    if (line.startsWith("+")) { hunk.lines.push(`L${newLine}: ${line.slice(1)}`); newLine++; }
    else if (line.startsWith("-")) { /* deleted line — no new-file number */ }
    else { newLine++; } // context line or empty
  }
  return files.filter(f => f.hunks.some(h => h.lines.length));
}

/** Compose the review query: diff hunks + grounding instructions. */
export function buildReviewQuery(files: DiffFile[], maxCharsPerFile = 6000): string {
  const parts = files.map(f => {
    const hunks = f.hunks.map(h => `  @@ +${h.newStart}\n${h.lines.slice(0, 40).join("\n")}`).join("\n");
    return `File: ${f.path}\n${hunks}`.slice(0, maxCharsPerFile);
  });
  return [
    "Review these pull-request changes like a senior engineer. For each file check correctness, edge cases, security (secrets, injection, path escapes), and missing test coverage. Ground every claim in the surrounding code you retrieved. Reply with markdown review comments — one section per file that has findings, most important first. If a file looks good, say so in one line. Do not restate the diff back.",
    "",
    "The repo map and retrieval tool give you the codebase around these changes; retrieve any surrounding code a hunk depends on before judging it.",
    "",
    ...parts,
  ].join("\n");
}

export function registerReviewCommand(program: Command, io: CliIo): void {
  program
    .command("review")
    .description("Review a unified diff with the agent, grounded in the indexed codebase. Prints markdown review comments. Built for CI: pair with 'gh pr diff' and post the output as a PR comment.")
    .option("--diff <path>", "Unified diff file (default: stdin)")
    .option("-w, --workspace <path>", "Workspace the diff applies to", process.cwd())
    .option("-p, --provider <provider>", "LLM provider for the review agent")
    .option("--llm-model <model>", "LLM model (default: provider-appropriate)")
    .option("--api-key <key>", "LLM API key")
    .option("--embedding-provider <provider>", "Embedding provider for the index")
    .option("--max-files <n>", "Cap the number of changed files reviewed", "20")
    .option("--json", "Emit the review as JSON instead of markdown")
    .action(async (opts: any) => {
      const raw = opts.diff
        ? await fs.promises.readFile(String(opts.diff), "utf8")
        : await new Promise<string>(res => {
          let d = "";
          if (process.stdin.isTTY) { res(""); return; }
          process.stdin.on("data", c => d += c);
          process.stdin.on("end", () => res(d));
        });
      const diff = raw.trim();
      if (!diff) { io.error("No diff provided — pass --diff <path> or pipe a unified diff on stdin."); process.exitCode = 1; return; }

      const files = parseUnifiedDiff(diff).slice(0, Math.max(1, Number(opts.maxFiles) || 20));
      if (!files.length) { io.text("No reviewable changes found in the diff (added/modified lines)."); return; }
      io.text(`Reviewing ${files.length} changed file(s): ${files.map(f => f.path).join(", ")}\n`);

      const built = await buildSession({
        opts: { ...opts, fullAuto: true, index: true, watch: false, memory: false, audit: false, delegate: false, plan: false },
        diag: io.diagnosticsFor(opts),
        interactive: false,
        traced: false,
        resolveConfig: (o: any) => resolveConfig({ ...o, provider: opts.embeddingProvider, apiKey: undefined }, io),
        fatal: (message: string) => { io.error(message); process.exit(1); },
      });
      try {
        const review = await built.agent.run(buildReviewQuery(files));
        if (opts.json) io.json({ review, files: files.map(f => f.path) });
        else io.text(review);
      } finally {
        built.close();
      }
    });
}
