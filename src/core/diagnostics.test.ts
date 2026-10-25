import { describe, expect, it } from "vitest";
import { createCliHumanDiagnostics, createCliJsonDiagnostics, createMcpStderrDiagnostics, createSilentDiagnostics } from "./diagnostics";

function capture() {
  let text = "";
  return {
    stream: { write: (chunk: string | Uint8Array) => { text += String(chunk); return true; } },
    text: () => text,
  };
}

describe("diagnostics adapters", () => {
  it("keeps JSON-safe CLI diagnostics off stdout", () => {
    const stdout = capture();
    const stderr = capture();
    const diag = createCliJsonDiagnostics({ stdout: stdout.stream as any, stderr: stderr.stream as any });

    diag.info("indexing");
    diag.warn("careful");
    diag.error("failed");
    diag.progress("10/10");

    stdout.stream.write(JSON.stringify({ ok: true }) + "\n");

    expect(JSON.parse(stdout.text())).toEqual({ ok: true });
    expect(stdout.text().trim().split(/\n/)).toHaveLength(1);
    expect(stderr.text()).toContain("indexing");
    expect(stderr.text()).toContain("10/10");
  });

  it("writes human CLI info/progress to stdout and warnings/errors to stderr", () => {
    const stdout = capture();
    const stderr = capture();
    const diag = createCliHumanDiagnostics({ stdout: stdout.stream as any, stderr: stderr.stream as any });

    diag.info("hello");
    diag.progress("50%");
    diag.warn("warn");
    diag.error("error");

    expect(stdout.text()).toBe("hello\n50%");
    expect(stderr.text()).toBe("warn\nerror\n");
  });

  it("uses stderr for MCP startup diagnostics and supports silent tests", () => {
    const stderr = capture();
    const mcp = createMcpStderrDiagnostics("[oce]", { stderr: stderr.stream as any });
    mcp.info("ready");
    expect(stderr.text()).toBe("[oce] ready\n");

    const stdout = capture();
    const silent = createSilentDiagnostics();
    silent.error("nope");
    stdout.stream.write(JSON.stringify({ ok: true }) + "\n");
    expect(JSON.parse(stdout.text())).toEqual({ ok: true });
  });
});
