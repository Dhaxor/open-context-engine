/**
 * A deliberately small markdown parser for agent answers.
 *
 * Answers use a narrow subset — headings, fenced code with a language and path,
 * lists, bold, inline code — and a full CommonMark library would be a large
 * dependency to render six constructs. Parsing to a structure (rather than to
 * HTML) means no `dangerouslySetInnerHTML` anywhere in Studio: model output is
 * untrusted text and never becomes markup.
 *
 * It parses partial input, because text streams in token by token and the view
 * re-renders on every delta — an unterminated fence must render as an open code
 * block, not throw away the paragraph before it.
 */

export type MdNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string };

export type MdBlock =
  | { kind: "paragraph"; nodes: MdNode[] }
  | { kind: "heading"; level: number; nodes: MdNode[] }
  | { kind: "list"; items: MdNode[][] }
  | { kind: "fence"; lang: string; path: string; code: string; open: boolean };

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

export function parseMarkdown(input: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = input.split("\n");
  let paragraph: string[] = [];
  let items: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", nodes: parseInline(text) });
    paragraph = [];
  };
  const flushList = () => {
    if (!items.length) return;
    blocks.push({ kind: "list", items: items.map(parseInline) });
    items = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      // The agent is asked to tag fences with a language AND a path
      // (```ts src/core/retriever.ts) so the transcript can label the block.
      const [lang = "", path = ""] = fence[1].trim().split(/\s+/);
      const code: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (FENCE.test(lines[i])) { closed = true; break; }
        code.push(lines[i]);
      }
      blocks.push({ kind: "fence", lang, path, code: code.join("\n"), open: !closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: "heading", level: heading[1].length, nodes: parseInline(heading[2]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      items.push(bullet[1]);
      continue;
    }

    if (!line.trim()) { flushAll(); continue; }
    flushList();
    paragraph.push(line);
  }

  flushAll();
  return blocks;
}

/** Inline `code` and **bold**. Order matters: code wins, so `**not bold**`
 *  inside backticks stays literal. */
export function parseInline(text: string): MdNode[] {
  const nodes: MdNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) nodes.push({ kind: "code", text: match[1] });
    else nodes.push({ kind: "strong", text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push({ kind: "text", text: text.slice(last) });
  return nodes.length ? nodes : [{ kind: "text", text }];
}

/** `path:line` or `path:start-end` inside model prose, so a citation can be
 *  made clickable without the model emitting link syntax. */
export const CITATION = /\b([\w./-]+\.\w{1,5}):(\d+)(?:-(\d+))?\b/;

export interface Citation { path: string; startLine: number; endLine: number; }

export function findCitation(text: string): Citation | null {
  const m = CITATION.exec(text);
  if (!m) return null;
  const start = Number(m[2]);
  return { path: m[1], startLine: start, endLine: m[3] ? Number(m[3]) : start };
}
