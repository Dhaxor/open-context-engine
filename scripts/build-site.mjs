#!/usr/bin/env node
/**
 * opencontextengine.com, made consistent. The site stays plain HTML with no
 * deploy-time build — this rewrites the committed pages in place:
 *
 *   - one <head> block per page from PAGES (title, description, canonical,
 *     Open Graph/Twitter, icons, fonts, stylesheet), so no page can drift out
 *     of having a canonical or a social card again;
 *   - one nav and one footer, with every internal link root-relative and
 *     clean (/docs, never docs.html — each .html link cost a 307);
 *   - JSON-LD kept truthful: Article dates, the shipped softwareVersion, the
 *     square logo, breadcrumbs on every page below the home page;
 *   - generated pages: the changelog body from CHANGELOG.md (+ the extension's),
 *     and sitemap.xml with each page's real last-modified date.
 *
 * Dates come from scripts/site-dates.json: a page's "modified" moves only
 * when its content hash changes, so lastmod and "Updated" mean something.
 *
 *   node scripts/build-site.mjs           rewrite web/ (and the dates manifest)
 *   node scripts/build-site.mjs --check   change nothing; fail on drift or a broken rule
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "web");
const datesFile = path.join(root, "scripts", "site-dates.json");
const CHECK = process.argv.includes("--check");
/** --touch=a.html,b.html: these pages' content really changed today, even if
 *  their hash moved only with the shared blocks (or they have no entry yet). */
const TOUCH = new Set((process.argv.find(a => a.startsWith("--touch="))?.slice(8) ?? "").split(",").filter(Boolean));
const SITE = "https://opencontextengine.com";
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const TODAY = new Date().toISOString().slice(0, 10);

const GITHUB = "https://github.com/Dhaxor/open-context-engine";
const NPM = "https://www.npmjs.com/package/@dhaxor/open-context";
const MARKETPLACE = "https://marketplace.visualstudio.com/items?itemName=open-context.open-context-engine";
const OPENVSX = "https://open-vsx.org/extension/open-context/open-context-engine";

/**
 * Every page the site serves. `crumbs` sit between Home and the page in the
 * breadcrumb trail; `article` pages carry dates (JSON-LD + a visible line).
 */
const GUIDES = [["Guides", "/guides"]];
const SETUP = [["Docs", "/docs"]];
const PAGES = {
  "index.html": {
    title: "Open Context Engine: local code context for AI coding agents",
    description: "Open-source, local-first context engine for AI coding agents: hybrid search over your repo, served to Claude Code, Cursor and VS Code over MCP.",
    type: "website",
  },
  "docs.html": {
    title: "Docs: install and connect Open Context Engine",
    description: "Install Open Context Engine, connect Claude Code, Cursor, VS Code or Windsurf with one command, pick a search mode, and share a team index.",
    name: "Docs",
  },
  "claude-code.html": {
    title: "Give Claude Code your whole codebase (MCP setup)",
    description: "One command connects Claude Code to a local index of your repo: oce mcp install claude-code. Hybrid code search, symbols and repo maps over MCP.",
    name: "Claude Code", crumbs: SETUP, article: true,
  },
  "cursor.html": {
    title: "Cursor MCP setup: give Cursor your whole codebase",
    description: "Connect Cursor to a local index of your repo with one command: oce mcp install cursor. Hybrid code search, symbol lookups and repo maps for its agent.",
    name: "Cursor", crumbs: SETUP, article: true,
  },
  "vscode.html": {
    title: "Open Context Engine for VS Code: agent and Copilot MCP",
    description: "A VS Code agent grounded in a local index of your code, with approvals, checkpoints and memory, plus an MCP server for Copilot agent mode.",
    name: "VS Code", crumbs: SETUP, article: true,
  },
  "windsurf.html": {
    title: "Windsurf MCP setup: codebase context for Cascade",
    description: "Give Windsurf's Cascade agent hybrid search over a local index of your repo: oce mcp install windsurf writes the MCP config for you.",
    name: "Windsurf", crumbs: SETUP, article: true,
  },
  "claude-desktop.html": {
    title: "Claude Desktop MCP setup: ask Claude about your code",
    description: "Let Claude Desktop search a local index of your repository over MCP: one command writes claude_desktop_config.json, and your code stays on disk.",
    name: "Claude Desktop", crumbs: SETUP, article: true,
  },
  "mcp-server.html": {
    title: "MCP server for code search: Claude Code, Cursor, any client",
    description: "An open-source MCP server that gives AI agents your codebase: hybrid code search, symbol definitions and references, repo maps. Local, stdio or HTTP.",
    name: "MCP server", crumbs: GUIDES, article: true,
  },
  "comparison.html": {
    title: "OCE vs Cursor, Copilot and other codebase context tools",
    description: "How Cursor, Copilot, grep, MCP servers and Open Context Engine give AI codebase context: what each indexes, where it runs, and when you need which.",
    name: "Comparison", crumbs: GUIDES, article: true,
  },
  "augment-alternative.html": {
    title: "Open-source alternative to Augment's Context Engine",
    description: "Open Context Engine vs Augment's Context Engine: an MIT-licensed, local-first code context engine for MCP clients. What differs, and when each fits.",
    name: "Augment alternative", crumbs: [["Comparison", "/comparison"]], article: true,
  },
  "guides.html": {
    title: "Guides: agentic workflows, code RAG, MCP and context",
    description: "Field guides for grounding AI coding agents in real codebases: agentic workflows, code RAG, semantic search, MCP servers and context engineering.",
    name: "Guides",
  },
  "agentic-workflow.html": {
    title: "What is an agentic workflow? Code retrieval for AI agents",
    description: "An agentic workflow is an LLM that plans, calls tools and loops until done. How code retrieval grounds coding agents, and how to give one your repo.",
    name: "Agentic workflow", crumbs: GUIDES, article: true,
  },
  "code-rag.html": {
    title: "Code RAG: retrieval-augmented generation for codebases",
    description: "Code RAG retrieves the right source into an LLM's context before it answers. How it works, why naive code RAG fails, and how to run it locally.",
    name: "Code RAG", crumbs: GUIDES, article: true,
  },
  "semantic-code-search.html": {
    title: "Semantic code search: find code by meaning, not keywords",
    description: "Semantic code search finds code by meaning. Where grep and pure vector search each fail, and how hybrid search covers both, locally and over MCP.",
    name: "Semantic code search", crumbs: GUIDES, article: true,
  },
  "context-engineering.html": {
    title: "Context engineering for coding agents",
    description: "Context engineering decides what an LLM sees: retrieval, structure, budget and verification. How it applies to coding agents, and how to inspect it.",
    name: "Context engineering", crumbs: GUIDES, article: true,
  },
  "agent-memory.html": {
    title: "Agent memory for coding agents: how it works, locally",
    description: "Coding agents now remember across sessions. How agent memory works, its tradeoffs, and how to run it locally over MCP with Open Context Engine.",
    name: "Agent memory", crumbs: GUIDES, article: true,
  },
  "rag-vs-fine-tuning.html": {
    title: "RAG vs fine-tuning for code: which grounds your LLM?",
    description: "RAG keeps codebase answers current and verifiable; fine-tuning shapes style. What each does for code questions, and why retrieval usually wins.",
    name: "RAG vs fine-tuning", crumbs: GUIDES, article: true,
  },
  "benchmarks.html": {
    title: "Benchmarks: measured code retrieval quality",
    description: "Measured retrieval quality on committed gold sets: recall@10, MRR and nDCG in keyword-only and hybrid modes, generated from the eval harness's reports.",
    name: "Benchmarks",
  },
  "changelog.html": {
    title: "Changelog: Open Context Engine releases",
    description: "Every Open Context Engine release: the MCP server, the CLI agent and the VS Code extension, with what shipped and why.",
    name: "Changelog",
  },
  "pricing.html": {
    title: "Pricing: free MIT core, Team $25 per seat",
    description: "Open Context Engine pricing. MIT core free forever; Team $25/seat/month for shared indexes and policy locks; Enterprise for SSO, audit, and org controls.",
    name: "Pricing",
  },
  "404.html": {
    title: "Page not found | Open Context Engine",
    description: "That page doesn't exist. Find Open Context Engine's docs, setup guides for Claude Code, Cursor and VS Code, and field guides from here.",
    noindex: true,
  },
};

/** Files in web/ that are not pages. */
const NOT_PAGES = new Set(["google8bcc36d309536137.html"]);

const NAV = [
  ["/#retrieval", "Product"],
  ["/docs", "Docs"],
  ["/claude-code", "Claude Code", "optional"],
  ["/cursor", "Cursor", "optional"],
  ["/vscode", "VS Code", "optional"],
  ["/guides", "Guides"],
  ["/pricing", "Pricing"],
  [GITHUB, "GitHub", "optional"],
];

const FOOTER = [
  ["product", [["/#retrieval", "Retrieval"], ["/#trace", "Agent"], ["/#local", "Local-first"], ["/pricing", "Pricing"], ["/benchmarks", "Benchmarks"], ["/changelog", "Changelog"]]],
  ["set up", [["/claude-code", "Claude Code"], ["/cursor", "Cursor"], ["/vscode", "VS Code"], ["/windsurf", "Windsurf"], ["/claude-desktop", "Claude Desktop"], ["/mcp-server", "MCP server"], ["/docs", "Docs"]]],
  ["learn", [["/guides", "Guides"], ["/agentic-workflow", "Agentic workflow"], ["/code-rag", "Code RAG"], ["/semantic-code-search", "Semantic code search"], ["/context-engineering", "Context engineering"], ["/agent-memory", "Agent memory"], ["/rag-vs-fine-tuning", "RAG vs fine-tuning"]]],
  ["compare", [["/comparison", "OCE vs Cursor &amp; Copilot"], ["/augment-alternative", "Augment alternative"]]],
  ["get it", [[GITHUB, "GitHub"], [NPM, "npm"], [MARKETPLACE, "VS Code Marketplace"], [OPENVSX, "Open VSX"]]],
];

// ─── helpers ──────────────────────────────────────────────────────────────────

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Escape text that may already contain entities (&amp;) without doubling them. */
const attr = s => String(s).replace(/&(?![a-z]+;|#\d+;)/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const slugOf = file => (file === "index.html" ? "" : file.replace(/\.html$/, ""));
const urlOf = file => `${SITE}/${slugOf(file)}`;
const pathOf = file => `/${slugOf(file)}`;

function git(args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

function ogImageFor(file) {
  const own = path.join(web, "og", `${slugOf(file) || "home"}.png`);
  return fs.existsSync(own) ? `${SITE}/og/${slugOf(file) || "home"}.png` : `${SITE}/og-image.png`;
}

// ─── shared blocks ────────────────────────────────────────────────────────────

function headBlock(file, meta) {
  const ogTitle = meta.ogTitle ?? meta.title.replace(/ \| Open Context Engine$/, "");
  const ogDescription = meta.ogDescription ?? meta.description;
  const image = ogImageFor(file);
  const lines = [
    `<title>${attr(meta.title)}</title>`,
    `<meta name="description" content="${attr(meta.description)}">`,
  ];
  if (meta.noindex) {
    lines.push(`<meta name="robots" content="noindex">`);
  } else {
    lines.push(
      `<link rel="canonical" href="${urlOf(file)}">`,
      `<meta property="og:type" content="${meta.article ? "article" : "website"}">`,
      `<meta property="og:site_name" content="Open Context Engine">`,
      `<meta property="og:title" content="${attr(ogTitle)}">`,
      `<meta property="og:description" content="${attr(ogDescription)}">`,
      `<meta property="og:url" content="${urlOf(file)}">`,
      `<meta property="og:image" content="${image}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="Open Context Engine — local code context for AI coding agents">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${attr(ogTitle)}">`,
      `<meta name="twitter:description" content="${attr(ogDescription)}">`,
      `<meta name="twitter:image" content="${image}">`,
    );
  }
  lines.push(
    `<link rel="icon" href="/favicon.ico" sizes="48x48">`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">`,
    `<link rel="stylesheet" href="/oce.css?v=${VERSION}">`,
  );
  return lines.join("\n");
}

function navBlock(file) {
  const here = pathOf(file);
  const links = NAV.map(([href, label, cls]) => {
    const current = href === here ? ` aria-current="page"` : "";
    return `      <a href="${href}"${cls ? ` class="${cls}"` : ""}${current}>${label}</a>`;
  }).join("\n");
  return `<header class="nav">
  <div class="wrap nav-inner">
    <a href="/" class="wordmark" aria-label="Open Context Engine home">oce<span class="caret">▍</span></a>
    <nav class="nav-links" aria-label="Main">
${links}
    </nav>
    <button class="install-chip" data-copy="npm install -g @dhaxor/open-context" aria-label="Copy install command">
      npm i -g @dhaxor/open-context <span class="ic-copy">⧉</span>
    </button>
  </div>
</header>`;
}

function footerBlock() {
  const cols = FOOTER.map(([heading, links]) =>
    `      <div><span class="col-h">${heading}</span>\n${links.map(([href, label]) => `        <a href="${href}">${label}</a>`).join("\n")}\n      </div>`).join("\n");
  return `<footer>
  <div class="wrap foot">
    <div>
      <span class="wordmark">oce<span class="caret">▍</span></span>
      <p class="legal" style="margin-top: 12px;">Open Context Engine · MIT core · v${VERSION}<br>No telemetry. No code leaves your machine.</p>
      <p class="legal" style="margin-top: 12px;"><a href="mailto:hello@opencontextengine.com">hello@opencontextengine.com</a></p>
    </div>
    <div class="cols">
${cols}
    </div>
  </div>
</footer>`;
}

// ─── JSON-LD ──────────────────────────────────────────────────────────────────

const ORG = { "@type": "Organization", "@id": `${SITE}/#org`, name: "Open Context Engine", url: `${SITE}/`, logo: `${SITE}/logo.png`, sameAs: [GITHUB, NPM, MARKETPLACE, OPENVSX] };

function walk(node, fn) {
  if (Array.isArray(node)) { node.forEach(n => walk(n, fn)); return; }
  if (!node || typeof node !== "object") return;
  fn(node);
  if (node["@graph"]) walk(node["@graph"], fn);
}

function transformLd(file, meta, dates, json) {
  walk(json, node => {
    const type = node["@type"];
    if (type === "Organization") Object.assign(node, ORG);
    if (type === "SoftwareApplication") {
      node.softwareVersion = VERSION;
      node.image = `${SITE}/og-image.png`;
      node.sameAs = [GITHUB, NPM, MARKETPLACE, OPENVSX];
      node.offers = [
        { "@type": "Offer", name: "Community", price: "0", priceCurrency: "USD" },
        { "@type": "Offer", name: "Team", price: "25", priceCurrency: "USD",
          priceSpecification: { "@type": "UnitPriceSpecification", price: "25", priceCurrency: "USD", unitText: "per seat per month" } },
      ];
    }
    if (type === "Article" || type === "TechArticle" || type === "BlogPosting") {
      node.headline = node.headline ?? meta.title.replace(/ \| Open Context Engine$/, "");
      node.datePublished = dates.published;
      node.dateModified = dates.modified;
      node.image = ogImageFor(file);
      node.author = { "@type": "Organization", "@id": `${SITE}/#org`, name: "Open Context Engine", url: `${SITE}/` };
      node.publisher = { "@id": `${SITE}/#org` };
      node.mainEntityOfPage = urlOf(file);
    }
    if (type === "BreadcrumbList") node.itemListElement = crumbItems(file, meta);
  });
  return json;
}

function crumbItems(file, meta) {
  const trail = [["Home", "/"], ...(meta.crumbs ?? []), [meta.name ?? meta.title, pathOf(file)]];
  return trail.map(([name, p], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${SITE}${p}` }));
}

function rewriteLd(html, file, meta, dates) {
  let sawCrumbs = false;
  const out = html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, (whole, body) => {
    let json;
    try { json = JSON.parse(body); } catch (err) { throw new Error(`${file}: invalid JSON-LD (${err.message})`); }
    walk(json, n => { if (n["@type"] === "BreadcrumbList") sawCrumbs = true; });
    return `<script type="application/ld+json">\n${JSON.stringify(transformLd(file, meta, dates, json), null, 2)}\n</script>`;
  });
  if (sawCrumbs || file === "index.html" || meta.noindex) return out;
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbItems(file, meta) };
  return out.replace("</head>", `<script type="application/ld+json">\n${JSON.stringify(crumbs, null, 2)}\n</script>\n</head>`);
}

// ─── the changelog ────────────────────────────────────────────────────────────

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** The Markdown the changelogs use: paragraphs, "- " lists with indented
 *  continuation lines, ``` fences, and ###/#### sub-headings. */
function markdown(text) {
  const blocks = [];
  let list = null;
  let para = null;
  let fence = null;
  const flushPara = () => { if (para) { blocks.push(`<p>${inline(para.join(" "))}</p>`); para = null; } };
  const flushList = () => { if (list) { blocks.push(`<ul>\n${list.map(i => `      <li>${inline(i.join(" "))}</li>`).join("\n")}\n    </ul>`); list = null; } };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (fence) {
      if (/^\s*```/.test(line)) { blocks.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`); fence = null; }
      else fence.push(raw);
      continue;
    }
    if (/^\s*```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
    const heading = /^(#{3,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    const item = /^[-*] (.*)$/.exec(line);
    if (item) { flushPara(); (list ??= []).push([item[1]]); continue; }
    if (list && /^\s+\S/.test(line)) { list[list.length - 1].push(line.trim()); continue; }
    flushList();
    (para ??= []).push(line.trim());
  }
  if (fence) blocks.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
  flushPara(); flushList();
  return blocks.join("\n    ");
}

function versions(md) {
  const out = new Map();
  for (const part of md.split(/^## /m).slice(1)) {
    const [heading, ...rest] = part.split("\n");
    const m = /^(\d+\.\d+\.\d+)\s*(?:—\s*(.*))?$/.exec(heading.trim());
    if (m) out.set(m[1], { tagline: m[2] ?? "", body: rest.join("\n").trim() });
  }
  return out;
}

/** Release dates come from git tags when they're there, and are remembered in
 *  the dates manifest — CI's shallow checkout has no tags to read. */
const releaseDates = {};
function releaseDate(version, known) {
  const date = git(["log", "-1", "--format=%cs", `v${version}`]) || known?.[version] || "";
  if (date) releaseDates[version] = date;
  return date;
}

function changelogBody() {
  const core = versions(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
  const ext = versions(fs.readFileSync(path.join(root, "extension", "CHANGELOG.md"), "utf8"));
  const all = [...new Set([...core.keys(), ...ext.keys()])].sort((a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
  });
  return all.map(v => {
    const c = core.get(v), e = ext.get(v);
    const date = releaseDate(v, manifest._releases);
    const tagline = c?.tagline || e?.tagline;
    const parts = [`    <h2 id="v${v.replace(/\./g, "-")}">${v}${tagline ? ` <span class="tagline">${esc(tagline)}</span>` : ""}${date ? ` <span class="date">${date}</span>` : ""}</h2>`];
    if (c?.body) parts.push(`    ${markdown(c.body)}`);
    if (e?.body) parts.push(`    <h3>VS Code extension</h3>\n    ${markdown(e.body)}`);
    return parts.join("\n");
  }).join("\n\n");
}

// ─── one page ─────────────────────────────────────────────────────────────────

function render(file, source, dates) {
  const meta = PAGES[file];
  let html = source;

  // <head>: drop every tag the shared block owns, then insert it once.
  html = html.replace(/<head>([\s\S]*?)<\/head>/, (_, head) => {
    const kept = head
      .replace(/<title>[\s\S]*?<\/title>\s*/g, "")
      .replace(/<meta (?:name|property)="(?:description|robots|og:[^"]+|twitter:[^"]+)"[^>]*>\s*/g, "")
      .replace(/<link rel="(?:canonical|preconnect|icon|apple-touch-icon|stylesheet)"[^>]*?href="[^"]*"[^>]*>\s*/g, "")
      .replace(/<link href="https:\/\/fonts\.googleapis\.com[^"]*" rel="stylesheet">\s*/g, "");
    return `<head>${kept.replace(/(<meta name="viewport"[^>]*>\n?)/, `$1${headBlock(file, meta)}\n`)}</head>`;
  });

  html = html.replace(/<header class="nav">[\s\S]*?<\/header>/, navBlock(file));
  html = html.replace(/<footer>[\s\S]*?<\/footer>/, footerBlock());
  html = html.replace(/<script src="\/?site\.js" defer><\/script>/, `<script src="/site.js" defer></script>`);

  // Internal links: root-relative and clean.
  const slugs = new Set(Object.keys(PAGES).map(slugOf));
  html = html.replace(/href="(?:\/)?([a-z0-9-]+)(?:\.html)?(#[^"]*)?"/g, (whole, slug, hash = "") => {
    if (slug === "index") return `href="/${hash}"`;
    return slugs.has(slug) ? `href="/${slug}${hash}"` : whole;
  });

  // Generated content.
  if (file === "changelog.html") {
    html = html.replace(/(<!-- changelog:start -->)[\s\S]*?(<!-- changelog:end -->)/, `$1\n${changelogBody()}\n    $2`);
  }

  // A visible "Updated" line on dated pages, right under the lead paragraph.
  if (meta.article) {
    html = html.replace(/\s*<p class="updated">[\s\S]*?<\/p>/, "");
    const line = `\n    <p class="updated">Updated <time datetime="${dates.modified}">${humanDate(dates.modified)}</time></p>`;
    html = html.replace(/(<section class="hero[^"]*"[^>]*>[\s\S]*?<p class="sub">[\s\S]*?<\/p>)/, `$1${line}`);
  }

  html = rewriteLd(html, file, meta, dates);
  return html.replace(/\n{3,}/g, "\n\n");
}

function humanDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}

// ─── rules ────────────────────────────────────────────────────────────────────

function lint(file, html, meta) {
  const problems = [];
  if (meta.title.length > 60) problems.push(`title is ${meta.title.length} chars (max 60)`);
  if (meta.description.length < 70 || meta.description.length > 160) problems.push(`description is ${meta.description.length} chars (70–160)`);
  const h1s = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1s !== 1) problems.push(`${h1s} <h1> elements (want 1)`);
  if (!/<html lang="en">/.test(html)) problems.push(`missing <html lang="en">`);
  const slugs = new Set(Object.keys(PAGES).map(slugOf));
  const assets = new Set(fs.readdirSync(web));
  for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) {
    const target = href.slice(1);
    if (target === "" || slugs.has(target) || assets.has(target) || target.startsWith("og/")) continue;
    problems.push(`internal link to ${href}, which is not a page`);
  }
  for (const [, href] of html.matchAll(/href="([a-z0-9-]+\.html)/g)) problems.push(`.html link ${href} (use /${href.replace(/\.html$/, "")})`);
  // Markdown the changelog converter didn't understand shows up as raw text.
  if (file === "changelog.html" && /```|<p>#{1,6} |<li>#{1,6} /.test(html)) problems.push("unrendered Markdown in the generated changelog");
  return problems.map(p => `${file}: ${p}`);
}

// ─── run ──────────────────────────────────────────────────────────────────────

const manifest = fs.existsSync(datesFile) ? JSON.parse(fs.readFileSync(datesFile, "utf8")) : {};
const nextManifest = {};
const errors = [];
const writes = [];

const files = fs.readdirSync(web).filter(f => f.endsWith(".html") && !NOT_PAGES.has(f)).sort();
for (const f of files) if (!PAGES[f]) errors.push(`web/${f} has no entry in PAGES (scripts/build-site.mjs)`);
for (const f of Object.keys(PAGES)) if (!files.includes(f)) errors.push(`PAGES lists ${f}, but web/${f} does not exist`);

for (const file of files.filter(f => PAGES[f])) {
  const source = fs.readFileSync(path.join(web, file), "utf8");
  // The content hash ignores the dates themselves, or every run would move them.
  const hash = createHash("sha256").update(render(file, source, { published: "P", modified: "M" })).digest("hex").slice(0, 16);
  const known = manifest[file];
  let dates;
  if (known && known.hash === hash) dates = { published: known.published, modified: known.modified };
  else if (known) dates = { published: known.published, modified: TODAY };
  else {
    dates = {
      published: git(["log", "--diff-filter=A", "--follow", "--format=%cs", "--", `web/${file}`]).split("\n").pop() || TODAY,
      modified: git(["log", "-1", "--format=%cs", "--", `web/${file}`]) || TODAY,
    };
  }
  if (!CHECK && TOUCH.has(file)) dates = { ...dates, modified: TODAY };
  if (CHECK && (!known || known.hash !== hash)) errors.push(`web/${file} changed since its date was recorded — run node scripts/build-site.mjs`);
  nextManifest[file] = { hash, ...dates };
  const out = render(file, source, dates);
  errors.push(...lint(file, out, PAGES[file]));
  if (out !== source) writes.push([path.join(web, file), out]);
}

nextManifest._releases = Object.fromEntries(Object.entries(releaseDates).sort(([a], [b]) => (a < b ? 1 : -1)));

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Object.keys(PAGES).filter(f => !PAGES[f].noindex && nextManifest[f]).map(f => `  <url>
    <loc>${urlOf(f)}</loc>
    <lastmod>${nextManifest[f].modified}</lastmod>
  </url>`).join("\n")}
</urlset>
`;
if (fs.readFileSync(path.join(web, "sitemap.xml"), "utf8") !== sitemap) writes.push([path.join(web, "sitemap.xml"), sitemap]);
const manifestText = JSON.stringify(nextManifest, null, 2) + "\n";
if (!fs.existsSync(datesFile) || fs.readFileSync(datesFile, "utf8") !== manifestText) writes.push([datesFile, manifestText]);

if (CHECK) {
  for (const [file] of writes) errors.push(`${path.relative(root, file)} is out of date — run node scripts/build-site.mjs`);
  if (errors.length) {
    console.error(errors.map(e => `✗ ${e}`).join("\n"));
    process.exit(1);
  }
  console.log(`✓ site: ${files.length} pages consistent, sitemap and dates current`);
} else {
  for (const [file, text] of writes) fs.writeFileSync(file, text);
  console.log(`build-site: ${writes.length} file(s) written (${files.length} pages)`);
  if (errors.length) {
    console.error(errors.map(e => `✗ ${e}`).join("\n"));
    process.exit(1);
  }
}
