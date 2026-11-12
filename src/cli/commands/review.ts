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
import { buildReviewQuery, parseUnifiedDiff } from "../../agent/review";

// The diff parser and the review prompt live in the agent core so the editor
// asks for a review exactly the way CI does; re-exported for existing callers.
export { buildReviewQuery, parseUnifiedDiff, type DiffFile } from "../../agent/review";

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
