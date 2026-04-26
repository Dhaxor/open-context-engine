import { describe, it, expect } from "vitest";
import { computeBlobName, cosineSimilarity, isBinaryContent, isKeyishPath, sha256 } from "./utils";

describe("computeBlobName", () => {
  it("is deterministic for identical path + contents", () => {
    const a = computeBlobName("src/a.ts", "hello");
    const b = computeBlobName("src/a.ts", "hello");
    expect(a).toBe(b);
  });

  it("changes when the path changes", () => {
    const a = computeBlobName("src/a.ts", "hello");
    const b = computeBlobName("src/b.ts", "hello");
    expect(a).not.toBe(b);
  });

  it("changes when the contents change", () => {
    const a = computeBlobName("src/a.ts", "hello");
    const b = computeBlobName("src/a.ts", "world");
    expect(a).not.toBe(b);
  });

  it("accepts Buffer and string equivalently", () => {
    const fromStr = computeBlobName("x", "hello");
    const fromBuf = computeBlobName("x", Buffer.from("hello", "utf8"));
    expect(fromStr).toBe(fromBuf);
  });

  it("returns a 64-char hex digest", () => {
    expect(computeBlobName("p", "c")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns 0 when either vector is zero", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension/i);
  });
});

describe("isBinaryContent", () => {
  it("returns false for pure text", () => {
    expect(isBinaryContent("hello world\nfoo bar\n")).toBe(false);
  });

  it("returns true when a NUL byte is present", () => {
    expect(isBinaryContent(Buffer.from([0x48, 0x00, 0x49]))).toBe(true);
  });

  it("allows tabs, CR, LF in text", () => {
    expect(isBinaryContent("a\tb\r\nc\n")).toBe(false);
  });
});

describe("isKeyishPath", () => {
  it("detects common key extensions", () => {
    expect(isKeyishPath("secrets/cert.pem")).toBe(true);
    expect(isKeyishPath("x/id_rsa")).toBe(true);
    expect(isKeyishPath("src/app.ts")).toBe(false);
  });
});

describe("sha256", () => {
  it("returns a 64-char hex digest", () => {
    expect(sha256("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
