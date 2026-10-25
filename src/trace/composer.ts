/**
 * What the user typed, and what it means.
 *
 * The composer accepts four things and both surfaces have to agree on all of
 * them: an ordinary prompt, `@path` mentions that pin files into context, a
 * `!command` that runs a shell command directly, and a `/command` handled by
 * the client. Parsing lives here — pure, shared, and tested — rather than
 * twice, because a mention that resolves in the browser and not in the
 * terminal is worse than one that works nowhere.
 *
 * Autocomplete needs a second question answered: given the caret position,
 * which token is being typed right now? `activeToken` answers it so both
 * surfaces open the same menu at the same moment.
 */

export type ComposerIntent =
  | { kind: "empty" }
  /** An ordinary turn. `mentions` are the @paths, already stripped of the `@`. */
  | { kind: "prompt"; text: string; mentions: string[] }
  | { kind: "shell"; command: string }
  | { kind: "command"; name: string; args: string };

/**
 * Paths are matched conservatively: a run of path-ish characters that stops at
 * whitespace. Trailing sentence punctuation is trimmed, so "look at @src/a.ts."
 * mentions the file and not the full stop.
 */
const MENTION = /(^|\s)@([^\s@]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export function parseComposer(input: string): ComposerIntent {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };

  // `!` and `/` are only special at the very start; mid-sentence they are
  // ordinary characters, and treating "use !important" as a shell command
  // would be indefensible.
  if (trimmed.startsWith("!")) {
    const command = trimmed.slice(1).trim();
    return command ? { kind: "shell", command } : { kind: "empty" };
  }
  if (trimmed.startsWith("/")) {
    const rest = trimmed.slice(1).trim();
    if (!rest) return { kind: "empty" };
    const match = /^(\S+)\s*([\s\S]*)$/.exec(rest);
    return { kind: "command", name: (match?.[1] ?? rest).toLowerCase(), args: (match?.[2] ?? "").trim() };
  }

  return { kind: "prompt", text: trimmed, mentions: extractMentions(trimmed) };
}

/** The @paths in a prompt, de-duplicated and in the order they appear. */
export function extractMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION)) {
    const path = match[2].replace(TRAILING_PUNCTUATION, "");
    if (path && !found.includes(path)) found.push(path);
  }
  return found;
}

export interface ActiveToken {
  /** `@` for a file mention, `/` for a command. */
  trigger: "@" | "/";
  /** What has been typed after the trigger, which may be empty. */
  query: string;
  /** Index of the trigger character in the input. */
  start: number;
  /** Index just past the token — where a completion should end. */
  end: number;
}

/**
 * The token under the caret, when one is being typed.
 *
 * Returns null unless the caret sits inside a token that a menu should
 * complete. `/` only counts at position 0: a slash inside a path is a slash.
 */
export function activeToken(input: string, caret: number = input.length): ActiveToken | null {
  const position = Math.max(0, Math.min(caret, input.length));
  const before = input.slice(0, position);

  const at = before.lastIndexOf("@");
  if (at !== -1) {
    const preceding = at === 0 ? "" : before[at - 1];
    const query = before.slice(at + 1);
    // A mention starts a word, and stops at whitespace — "a@b.com" is not one.
    if ((at === 0 || /\s/.test(preceding)) && !/\s/.test(query)) {
      return { trigger: "@", query, start: at, end: position };
    }
  }

  if (before.startsWith("/") && !/\s/.test(before.slice(1))) {
    return { trigger: "/", query: before.slice(1), start: 0, end: position };
  }
  return null;
}

/** Replace the active token with `value`, returning the new input and caret. */
export function applyCompletion(input: string, token: ActiveToken, value: string): { text: string; caret: number } {
  // A trailing space commits the token, so the menu closes and typing carries
  // on instead of re-opening on what was just accepted.
  const inserted = `${token.trigger}${value} `;
  const text = input.slice(0, token.start) + inserted + input.slice(token.end);
  return { text, caret: token.start + inserted.length };
}

/**
 * Rank indexed paths against a query, subsequence-style.
 *
 * Deliberately simple and explainable: an exact basename match beats a prefix,
 * which beats a substring, which beats a scattered subsequence; shorter paths
 * win ties. A heavier fuzzy matcher would be a dependency and a mystery.
 */
export function rankPaths(paths: string[], query: string, limit = 12): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit);

  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    let score: number;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (isSubsequence(q, lower)) score = 3;
    else continue;
    scored.push({ path, score: score * 1000 + Math.min(999, path.length) });
  }
  return scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(s => s.path);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/** Slash commands both surfaces offer, so the menus cannot disagree. */
export interface SlashCommandSpec {
  name: string;
  summary: string;
  /** Takes a free-text argument (shown as `/name <arg>`). */
  arg?: string;
}

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: "compact", summary: "Summarize older history to free context" },
  { name: "reset", summary: "Clear the conversation" },
  { name: "mode", summary: "Set the approval mode", arg: "suggest|auto-edit|full-auto" },
  { name: "rail", summary: "Toggle the evidence rail" },
  { name: "rewind", summary: "Rewind to a checkpoint", arg: "sha" },
  { name: "sessions", summary: "List parallel sessions" },
  { name: "new", summary: "Start a parallel session", arg: "title" },
  { name: "review", summary: "Review what this session changed" },
  { name: "land", summary: "Merge this session and close it" },
  { name: "exit", summary: "Close this session" },
];

export function matchCommands(query: string): SlashCommandSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(c => c.name.startsWith(q) || c.summary.toLowerCase().includes(q));
}
