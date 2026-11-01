/**
 * Project instruction files — AGENTS.md and friends.
 *
 * Reading these is table stakes for coding agents: repos tuned for Claude
 * Code, Cursor, or any AGENTS.md-conformant tool carry their conventions in
 * these files, and an agent that ignores them misbehaves in exactly the ways
 * the repo's maintainers tried to prevent.
 *
 * Priority order: AGENTS.md (the cross-tool convention) first; CLAUDE.md and
 * .cursorrules are honored when present. First match wins — repos that keep
 * multiple variants would otherwise inject conflicting guidance twice.
 */
import * as fs from "fs";
import * as path from "path";

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"] as const;

/** Longest instruction file we will inject. A repo can keep essays in here;
 *  the system prompt has a budget, and guidance past ~8k chars stops being
 *  followed anyway. */
export const MAX_INSTRUCTION_CHARS = 8000;

/** Read the workspace's project instructions, or null when none exist.
 *  Truncated from the head if over budget (the top of the file carries the
 *  durable rules; long tails are usually examples). */
export function readProjectInstructions(workspaceRoot: string, maxChars = MAX_INSTRUCTION_CHARS): string | null {
  for (const name of INSTRUCTION_FILES) {
    const p = path.join(workspaceRoot, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size === 0) continue;
      let text = fs.readFileSync(p, "utf8").trim();
      if (!text) continue;
      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n\n[... ${name} truncated at ${maxChars} chars]`;
      }
      return text;
    } catch { /* not there, or unreadable — try the next convention */ }
  }
  return null;
}
