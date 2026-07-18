import { describe, it, expect, afterEach } from "vitest";
import { createLogger, __setLogSinkForTests, __setLogLevelForTests, LogRecord, errText } from "./log";

afterEach(() => {
  __setLogSinkForTests(null);
  __setLogLevelForTests(null);
});

describe("structured logger", () => {
  function capture(): LogRecord[] {
    const records: LogRecord[] = [];
    __setLogSinkForTests(r => records.push(r));
    return records;
  }

  it("respects the active level", () => {
    const records = capture();
    __setLogLevelForTests("info");
    const log = createLogger("test");
    log.error("boom");
    log.info("fyi");
    log.debug("noise");
    expect(records.map(r => r.level)).toEqual(["error", "info"]);
  });

  it("silent drops everything; debug keeps everything", () => {
    const records = capture();
    __setLogLevelForTests("silent");
    createLogger("t").error("x");
    expect(records).toHaveLength(0);
    __setLogLevelForTests("debug");
    createLogger("t").debug("y", { detail: 1 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ component: "t", message: "y", data: { detail: 1 } });
    expect(records[0].ts).toMatch(/^\d{4}-/);
  });

  it("a throwing sink never propagates", () => {
    __setLogSinkForTests(() => { throw new Error("sink died"); });
    __setLogLevelForTests("debug");
    expect(() => createLogger("t").error("x")).not.toThrow();
  });

  it("errText renders Errors and non-Errors", () => {
    expect(errText(new Error("bad"))).toBe("bad");
    expect(errText("plain")).toBe("plain");
  });
});
