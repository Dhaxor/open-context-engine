import * as fs from "fs";
import * as path from "path";

export interface GuidelineSection {
  title: string;
  content: string;
  scope?: string;
}

export interface Guidelines {
  raw: string;
  sections: GuidelineSection[];
  filePath: string;
  lastModified: number;
}

const GUIDELINE_FILES = [
  ".context-guidelines",
  ".oce-guidelines",
  ".context-guidelines.md",
  ".github/context-guidelines.md",
];

export function loadGuidelines(workspaceRoot: string): Guidelines | null {
  for (const name of GUIDELINE_FILES) {
    const filePath = path.join(workspaceRoot, name);
    try {
      const stat = fs.statSync(filePath);
      const raw = fs.readFileSync(filePath, "utf8");
      return {
        raw,
        sections: parseSections(raw),
        filePath,
        lastModified: stat.mtimeMs,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function getRelevantGuidelines(guidelines: Guidelines | null, context?: { paths?: string[]; query?: string }): string {
  if (!guidelines || !guidelines.sections.length) return "";

  const relevantSections: GuidelineSection[] = [];
  for (const section of guidelines.sections) {
    if (!section.scope) {
      relevantSections.push(section);
      continue;
    }
    if (context?.paths?.some(p => matchesScope(p, section.scope!))) {
      relevantSections.push(section);
    }
  }

  if (!relevantSections.length) return "";
  return relevantSections.map(s => `### ${s.title}\n${s.content}`).join("\n\n");
}

function parseSections(raw: string): GuidelineSection[] {
  const sections: GuidelineSection[] = [];
  const lines = raw.split("\n");
  let current: { title: string; scope?: string; lines: string[] } | null = null;

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) {
      if (current) {
        sections.push({ title: current.title, content: current.lines.join("\n").trim(), scope: current.scope });
      }
      const { title, scope } = parseScopeFromTitle(heading[1]);
      current = { title, scope, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      if (!sections.length && line.trim()) {
        current = { title: "General", lines: [line] };
      }
    }
  }

  if (current) {
    sections.push({ title: current.title, content: current.lines.join("\n").trim(), scope: current.scope });
  }

  return sections;
}

function parseScopeFromTitle(title: string): { title: string; scope?: string } {
  const scopeMatch = title.match(/\[scope:\s*(.+?)\]\s*$/);
  if (scopeMatch) {
    return { title: title.replace(scopeMatch[0], "").trim(), scope: scopeMatch[1] };
  }
  const langScopes: Record<string, string> = {
    "typescript": "*.ts,*.tsx",
    "javascript": "*.js,*.jsx",
    "python": "*.py",
    "go": "*.go",
    "rust": "*.rs",
    "java": "*.java",
    "c#": "*.cs",
  };
  const lower = title.toLowerCase();
  for (const [lang, scope] of Object.entries(langScopes)) {
    if (lower === lang || lower === `${lang} guidelines` || lower === `${lang} rules`) {
      return { title, scope };
    }
  }
  return { title };
}

function matchesScope(filePath: string, scope: string): boolean {
  const patterns = scope.split(",").map(s => s.trim());
  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (filePath.endsWith(ext)) return true;
    } else if (filePath.includes(pattern)) {
      return true;
    }
  }
  return false;
}
