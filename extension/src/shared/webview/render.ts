import { icon } from "./icons";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";

for (const [name, lang] of Object.entries({ typescript, javascript, python, json, bash, xml, css, go, rust, java, csharp, cpp, yaml, sql, markdown })) {
  hljs.registerLanguage(name, lang as any);
}
const ALIAS: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", sh: "bash", shell: "bash", html: "xml", "c++": "cpp", cs: "csharp", yml: "yaml", md: "markdown", rs: "rust" };

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

const mdit: any = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Code fence → toolbar (Copy / Insert / Apply) + highlighted code. An optional file path
// after the language (```ts src/foo.ts) enables a precise Apply target.
mdit.renderer.rules.fence = (tokens: any[], idx: number) => {
  const token = tokens[idx];
  const info = (token.info || "").trim();
  const rawLang = info.split(/\s+/)[0] || "";
  const file = info.split(/\s+/)[1] || "";
  const lang = ALIAS[rawLang.toLowerCase()] || rawLang.toLowerCase();
  const code = token.content.replace(/\n$/, "");
  let body: string;
  if (lang && hljs.getLanguage(lang)) {
    try { body = hljs.highlight(code, { language: lang }).value; } catch { body = esc(code); }
  } else {
    body = esc(code);
  }
  const id = "c" + Math.random().toString(36).slice(2, 8);
  const applyBtn = `<button class="mini" data-apply="${id}"${file ? ` data-file="${esc(file)}"` : ""}>${icon("check")} Apply</button>`;
  return `<div class="code"><div class="code-bar"><span class="lang">${esc(rawLang || "text")}</span>${file ? `<span class="cfile">${esc(file)}</span>` : ""}<span class="spacer"></span>` +
    `<button class="mini" data-cp="${id}">${icon("copy")} Copy</button><button class="mini" data-ins="${id}">${icon("insert")} Insert</button>${applyBtn}</div>` +
    `<pre><code id="${id}" class="hljs">${body}</code></pre></div>`;
};

/** Wrap `path/to/file.ts:12` references in clickable links — only within plain text, never
 *  inside tags or code/pre blocks (so rendered HTML and highlighting stay intact). */
function linkifyFilePaths(html: string): string {
  const segments = html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<[^>]+>)/g);
  return segments.map((seg) => {
    if (!seg || seg[0] === "<") return seg;
    return seg.replace(
      /((?:[A-Za-z0-9_.@+\-]+\/)+[A-Za-z0-9_.@+\-]+)(?::([0-9]+)(?:-[0-9]+)?)?/g,
      (full, p, line) => {
        const base = p.split("/").pop() || "";
        if (base.indexOf(".") < 0) return full;
        return `<a class="file-link" data-open="${esc(p)}" data-line="${esc(line || "")}">${full}</a>`;
      },
    );
  }).join("");
}

export function md(s: string): string {
  return linkifyFilePaths(mdit.render(s || ""));
}

export function fmtDiff(d: string): string {
  if (!d) return '<span class="ctx">(no changes)</span>';
  return esc(d)
    .split("\n")
    .map((l) => {
      if (l.indexOf("@@") === 0) return '<span class="l hunk">' + l + "</span>";
      if (l.indexOf("+++") === 0 || l.indexOf("---") === 0) return '<span class="l ctx">' + l + "</span>";
      if (l.charAt(0) === "+") return '<span class="l add">' + l + "</span>";
      if (l.charAt(0) === "-") return '<span class="l rem">' + l + "</span>";
      return '<span class="l ctx">' + l + "</span>";
    })
    .join("");
}

export function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const mn = Math.floor(s / 60); if (mn < 60) return mn + "m ago";
  const h = Math.floor(mn / 60); if (h < 24) return h + "h ago";
  const dy = Math.floor(h / 24); if (dy < 7) return dy + "d ago";
  return new Date(ts).toLocaleDateString();
}

export function shortPath(p: string): string {
  const parts = String(p || "").split(/[/\\]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "No workspace";
}
