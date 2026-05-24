import { describe, it, expect } from "vitest";
import { compareFreshness } from "./freshness";
import { File, GitState } from "./types";
import { computeBlobName } from "./utils";

function indexed(files: File[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) m.set(f.path, computeBlobName(f.path, f.contents));
  return m;
}

const FILES: File[] = [{ path: "src/a.ts", contents: "export const a = 1;\n" }];

describe("compareFreshness git detection", () => {
  const onMain: GitState = { available: true, branch: "main", commit: "aaa" };

  it("is fresh when nothing changed and git matches", () => {
    const report = compareFreshness(FILES, indexed(FILES), { lastIndexedAt: 1, git: onMain }, onMain);
    expect(report.stale).toBe(false);
    expect(report.git.changed).toBe(false);
  });

  it("flags staleness when the commit changed", () => {
    const now: GitState = { available: true, branch: "main", commit: "bbb" };
    const report = compareFreshness(FILES, indexed(FILES), { lastIndexedAt: 1, git: onMain }, now);
    expect(report.git.changed).toBe(true);
    expect(report.stale).toBe(true);
    expect(report.reasons.some(r => /branch\/commit changed/.test(r))).toBe(true);
  });

  it("flags staleness when the branch changed", () => {
    const now: GitState = { available: true, branch: "feature", commit: "aaa" };
    const report = compareFreshness(FILES, indexed(FILES), { lastIndexedAt: 1, git: onMain }, now);
    expect(report.git.changed).toBe(true);
    expect(report.stale).toBe(true);
  });

  it("does not flag git changes when no git state was recorded", () => {
    const now: GitState = { available: true, branch: "main", commit: "bbb" };
    const report = compareFreshness(FILES, indexed(FILES), { lastIndexedAt: 1 }, now);
    expect(report.git.changed).toBe(false);
    expect(report.stale).toBe(false);
  });
});
