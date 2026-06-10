import { describe, it, expect, afterEach } from "vitest";
import { classifyNativeBindingError, diagnosisOneLiner } from "./native-binding-error";

function mockElectron(version: string | null): () => void {
  const prev = (process.versions as any).electron;
  if (version === null) delete (process.versions as any).electron;
  else (process.versions as any).electron = version;
  return () => {
    if (prev === undefined) delete (process.versions as any).electron;
    else (process.versions as any).electron = prev;
  };
}

describe("classifyNativeBindingError", () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  it("recognizes NODE_MODULE_VERSION mismatch and extracts the version numbers", () => {
    const err = new Error(
      "The module '/path/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.",
    );
    const d = classifyNativeBindingError(err);
    expect(d.kind).toBe("node_module_version");
    expect(d.recognized).toBe(true);
    expect(d.message).toContain("127");
    expect(d.message).toContain("137");
  });

  it("uses VS Code-flavored remedy inside Electron, Node-flavored outside", () => {
    const err = new Error("NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.");

    restore = mockElectron("42.3.0");
    const inElectron = classifyNativeBindingError(err);
    expect(inElectron.message).toMatch(/Update VS Code/);
    restore();

    restore = mockElectron(null);
    const inNode = classifyNativeBindingError(err);
    expect(inNode.message).toMatch(/npm rebuild better-sqlite3/);
  });

  it("recognizes glibc skew", () => {
    const err = new Error("/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.35' not found");
    const d = classifyNativeBindingError(err);
    expect(d.kind).toBe("glibc_too_old");
    expect(d.recognized).toBe(true);
    expect(d.message).toMatch(/glibc/i);
  });

  it("recognizes musl / Alpine via ld-musl", () => {
    const err = new Error("Error loading shared library /lib/ld-musl-x86_64.so.1");
    const d = classifyNativeBindingError(err);
    expect(d.kind).toBe("musl_libc");
    expect(d.recognized).toBe(true);
  });

  it("recognizes wrong-arch binaries", () => {
    const err = new Error("dlopen failed: wrong ELF class: ELFCLASS64");
    const d = classifyNativeBindingError(err);
    expect(d.kind).toBe("wrong_arch");
    expect(d.recognized).toBe(true);
  });

  it("recognizes sqlite-vec platform-package missing", () => {
    const err = new Error("Could not locate sqlite-vec native extension. Install sqlite-vec-windows-arm64, or use a platform supported by sqlite-vec.");
    const d = classifyNativeBindingError(err);
    expect(d.kind).toBe("sqlite_vec_platform");
    expect(d.recognized).toBe(true);
  });

  it("recognizes a missing-module error", () => {
    const err = new Error("Cannot find module 'better-sqlite3'");
    const d = classifyNativeBindingError(err);
    expect(d.kind).toBe("missing_module");
    expect(d.recognized).toBe(true);
  });

  it("falls back to unknown for unrelated errors", () => {
    const err = new Error("disk quota exceeded");
    const d = classifyNativeBindingError(err);
    expect(d.kind).toBe("unknown");
    expect(d.recognized).toBe(false);
    expect(d.raw).toContain("disk quota exceeded");
    expect(diagnosisOneLiner(d)).toMatch(/Output channel/);
  });

  it("accepts a raw string error too", () => {
    const d = classifyNativeBindingError("NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.");
    expect(d.kind).toBe("node_module_version");
  });
});
