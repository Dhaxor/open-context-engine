import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectSandbox, sandboxRequested, wrapCommand, writeSeatbeltProfile } from "./sandbox";

describe("sandboxRequested", () => {
  it("reads the OCE_SANDBOX env var", () => {
    process.env.OCE_SANDBOX = "1";
    try { expect(sandboxRequested({})).toBe(true); }
    finally { delete process.env.OCE_SANDBOX; }
    process.env.OCE_SANDBOX = "true";
    try { expect(sandboxRequested(undefined)).toBe(true); }
    finally { delete process.env.OCE_SANDBOX; }
    process.env.OCE_SANDBOX = "0";
    try { expect(sandboxRequested(undefined)).toBe(false); }
    finally { delete process.env.OCE_SANDBOX; }
  });

  it("opts in via shell options", () => {
    expect(sandboxRequested({ sandbox: true })).toBe(true);
    expect(sandboxRequested({ sandbox: false })).toBe(false);
  });
});

describe("seatbelt profile (macOS format)", () => {
  it("denies network and limits writes to the workspace", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "oce-sb-"));
    const p = writeSeatbeltProfile(ws);
    const text = fs.readFileSync(p, "utf8");
    expect(text).toContain("(version 1)");
    expect(text).toContain("(deny network*)");
    expect(text).toContain("(deny file-write*)");
    expect(text).toContain("(allow file-write*");
    // workspace allowed under both spellings if they differ
    expect(text).toContain(`(subpath "${ws}")`);
    expect(text).toContain('  (subpath "/private/var/folders")');
    expect(text).toContain('  (subpath "/tmp")');
    fs.rmSync(p, { force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe("wrapCommand", () => {
  const ws = os.tmpdir();

  it("returns null when no sandbox applies (windows / disabled)", () => {
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) return; // seatbelt present; skip
    const profile = detectSandbox(ws);
    if (profile.kind !== "none") return; // linux with bwrap installed; skip
    expect(wrapCommand(profile, ws, "npm test")).toBeNull();
  });

  it.runIf(process.platform === "darwin")("wraps via sandbox-exec with a fresh profile", () => {
    const profile = detectSandbox(ws);
    const wrapped = wrapCommand(profile, ws, "npm test");
    expect(wrapped).not.toBeNull();
    expect(wrapped!.file).toBe("/usr/bin/sandbox-exec");
    expect(wrapped!.args[0]).toBe("-f");
    const profileFile = wrapped!.args[1];
    expect(fs.existsSync(profileFile)).toBe(true);
    expect(wrapped!.args.at(-2)).toBe("-c");
    expect(wrapped!.args.at(-1)).toBe("npm test");
    fs.rmSync(profileFile, { force: true });
  });

  it.runIf(process.platform === "linux")("wraps via bwrap with network isolation", () => {
    const profile = detectSandbox(ws);
    if (profile.kind !== "bwrap") return;
    const wrapped = wrapCommand(profile, ws, "npm test");
    expect(wrapped!.file).toBe("bwrap");
    expect(wrapped!.args).toContain("--unshare-net");
  });
});
