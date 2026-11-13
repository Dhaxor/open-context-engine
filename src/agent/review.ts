/**
 * Code review on the agent: a unified diff in, one grounded review prompt out.
 *
 * Shared by `oce review` (CI: the PR's diff) and the editor (a turn's edits, a
 * parallel session's worktree, the working tree), so a review means the same
 * thing wherever it is asked for.
 */

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

export interface ReviewQueryOptions {
  maxCharsPerFile?: number;
  /** Files that are new and untracked — absent from a `git diff`, so named for the agent to read. */
  newFiles?: string[];
  /** Files the changes delete — no added lines to show, but worth checking for dangling references. */
  deletedFiles?: string[];
}

/** Compose the review query: diff hunks + grounding instructions. */
export function buildReviewQuery(files: DiffFile[], opts: ReviewQueryOptions | number = {}): string {
  const o: ReviewQueryOptions = typeof opts === "number" ? { maxCharsPerFile: opts } : opts;
  const maxCharsPerFile = o.maxCharsPerFile ?? 6000;
  const parts = files.map(f => {
    const hunks = f.hunks.map(h => `  @@ +${h.newStart}\n${h.lines.slice(0, 40).join("\n")}`).join("\n");
    return `File: ${f.path}\n${hunks}`.slice(0, maxCharsPerFile);
  });
  return [
    "Review these pull-request changes like a senior engineer. For each file check correctness, edge cases, security (secrets, injection, path escapes), and missing test coverage. Ground every claim in the surrounding code you retrieved. Reply with markdown review comments — one section per file that has findings, most important first. If a file looks good, say so in one line. Do not restate the diff back.",
    "",
    "The repo map and retrieval tool give you the codebase around these changes; retrieve any surrounding code a hunk depends on before judging it. This is a review: report findings, do not edit files.",
    ...(o.newFiles?.length ? ["", `New files (not shown below — read them): ${o.newFiles.join(", ")}`] : []),
    ...(o.deletedFiles?.length ? ["", `Deleted files (check nothing still depends on them): ${o.deletedFiles.join(", ")}`] : []),
    "",
    ...parts,
  ].join("\n");
}
