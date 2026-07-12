import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AuditLogger, readAuditEvents, verifyAuditChain, hashEvent, AuditEvent } from "./audit";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-audit-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("AuditLogger", () => {
  it("appends JSONL events with a continuous hash chain", () => {
    const log = new AuditLogger({ dir });
    log.log("run-start", { query: "how does auth work" });
    log.log("tool-call", { name: "codebase-retrieval" });
    log.log("run-end", { steps: 2 });

    const events = readAuditEvents(dir);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(events[0].prev).toBe("");
    expect(events[1].prev).toBe(events[0].hash);
    expect(events[2].prev).toBe(events[1].hash);
    expect(verifyAuditChain(events).ok).toBe(true);
  });

  it("resumes the chain across logger restarts (no fork)", () => {
    new AuditLogger({ dir }).log("run-start", { query: "a" });
    const second = new AuditLogger({ dir });
    second.log("run-end", { steps: 1 });

    const events = readAuditEvents(dir);
    expect(events).toHaveLength(2);
    expect(events[1].seq).toBe(2);
    expect(events[1].prev).toBe(events[0].hash);
    expect(verifyAuditChain(events).ok).toBe(true);
  });

  it("truncates oversized data values", () => {
    const log = new AuditLogger({ dir, maxValueChars: 10 });
    log.log("tool-call", { name: "x".repeat(50) });
    const [e] = readAuditEvents(dir);
    expect(String(e.data.name).length).toBeLessThan(50);
    expect(String(e.data.name)).toContain("…[+40 chars]");
    // Truncation happens BEFORE hashing, so the chain still verifies.
    expect(verifyAuditChain([e]).ok).toBe(true);
  });

  it("never throws when the directory is unwritable", () => {
    const log = new AuditLogger({ dir: path.join(dir, "missing", "\0bad") });
    expect(() => log.log("run-start", {})).not.toThrow();
    expect(log.getFailureCount()).toBeGreaterThan(0);
  });
});

describe("verifyAuditChain", () => {
  function threeEvents(): AuditEvent[] {
    const log = new AuditLogger({ dir });
    log.log("a", { i: 1 });
    log.log("b", { i: 2 });
    log.log("c", { i: 3 });
    return readAuditEvents(dir);
  }

  it("detects an altered event", () => {
    const events = threeEvents();
    (events[1].data as any).i = 999;
    const v = verifyAuditChain(events);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(2);
    expect(v.reason).toMatch(/altered/);
  });

  it("detects a deleted event via the sequence gap", () => {
    const events = threeEvents();
    events.splice(1, 1);
    const v = verifyAuditChain(events);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(3);
    expect(v.reason).toMatch(/sequence gap/);
  });

  it("detects a rewritten-in-place event (valid own hash, broken link)", () => {
    const events = threeEvents();
    // Recompute event 2 entirely — self-consistent hash but prev now lies.
    const forged = { seq: 2, ts: events[1].ts, type: "b", data: { i: 999 }, prev: "0".repeat(64) };
    events[1] = { ...forged, hash: hashEvent(forged) };
    const v = verifyAuditChain(events);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(2);
  });

  it("passes an empty log", () => {
    expect(verifyAuditChain([]).ok).toBe(true);
  });
});

describe("readAuditEvents filters", () => {
  it("filters by type and limit", () => {
    const log = new AuditLogger({ dir });
    for (let i = 0; i < 5; i++) log.log(i % 2 === 0 ? "tool-call" : "run-start", { i });
    expect(readAuditEvents(dir, { type: "tool-call" })).toHaveLength(3);
    expect(readAuditEvents(dir, { limit: 2 }).map(e => e.seq)).toEqual([4, 5]);
  });

  it("returns [] for a missing file", () => {
    expect(readAuditEvents(path.join(dir, "nope"))).toEqual([]);
  });
});
