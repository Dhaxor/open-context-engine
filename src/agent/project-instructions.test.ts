import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { INSTRUCTION_FILES, MAX_INSTRUCTION_CHARS, readProjectInstructions } from "./project-instructions";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oce-instr-"));
}

describe("readProjectInstructions", () => {
  it("returns null when no instruction file exists", () => {
    const ws = scratch();
    expect(readProjectInstructions(ws)).toBeNull();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("reads AGENTS.md ahead of the other conventions", () => {
    const ws = scratch();
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "agents rules");
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "claude rules");
    expect(readProjectInstructions(ws)).toBe("agents rules");
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("falls back to CLAUDE.md then .cursorrules", () => {
    const ws = scratch();
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "claude rules");
    expect(readProjectInstructions(ws)).toBe("claude rules");
    fs.rmSync(path.join(ws, "CLAUDE.md"));
    fs.writeFileSync(path.join(ws, ".cursorrules"), "cursor rules");
    expect(readProjectInstructions(ws)).toBe("cursor rules");
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("truncates oversized files from the head", () => {
    const ws = scratch();
    const long = "x".repeat(MAX_INSTRUCTION_CHARS + 500);
    fs.writeFileSync(path.join(ws, "AGENTS.md"), long);
    const out = readProjectInstructions(ws)!;
    expect(out.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS + 100);
    expect(out).toContain("truncated");
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("ignores empty files and directories with a matching name", () => {
    const ws = scratch();
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "   ");
    expect(readProjectInstructions(ws)).toBeNull();
    fs.rmSync(path.join(ws, "AGENTS.md"));
    fs.mkdirSync(path.join(ws, "AGENTS.md")); // a directory, not a file
    expect(readProjectInstructions(ws)).toBeNull();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("covers the documented conventions", () => {
    expect(INSTRUCTION_FILES).toContain("AGENTS.md");
    expect(INSTRUCTION_FILES).toContain("CLAUDE.md");
  });
});
