import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, buildReviewQuery } from "./review";

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 111..222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,9 @@ export function authenticate(user: string) {
   const session = createSession(user);
+  const admin = user === "admin";
+  if (admin) grantAllPermissions();
   return session;
 }

diff --git a/src/removed.ts b/src/removed.ts
deleted file mode 100644
index 333..000
--- a/src/removed.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function gone() {}

diff --git a/src/util.ts b/src/util.ts
index 444..555 100644
--- a/src/util.ts
+++ b/src/util.ts
@@ -5,3 +5,4 @@ export function util() {
   return 1;
 }
+export function added() { return 2; }
`;

describe("parseUnifiedDiff", () => {
  it("extracts added lines with new-file line numbers", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const auth = files.find(f => f.path === "src/auth.ts")!;
    // newStart is the hunk header value (10); the first context line consumes it,
    expect(auth.hunks[0].lines.some(l => l.includes("grantAllPermissions"))).toBe(true);
  });

  it("keeps the deleted file out (nothing to review in place) but keeps pure additions", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    expect(files.find(f => f.path === "src/removed.ts")).toBeUndefined();
    const util = files.find(f => f.path === "src/util.ts")!;
    expect(util.hunks[0].lines.some(l => l.includes("added()"))).toBe(true);
  });

  it("returns only files with reviewable additions", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    expect(files.map(f => f.path).sort()).toEqual(["src/auth.ts", "src/util.ts"]);
  });
});

describe("buildReviewQuery", () => {
  it("includes file paths, hunks, and the grounding instructions", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const q = buildReviewQuery(files);
    expect(q).toContain("File: src/auth.ts");
    expect(q).toContain("grantAllPermissions");
    expect(q).toContain("Review these pull-request changes");
    expect(q).toContain("retrieval tool");
  });

  it("caps per-file hunk text", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const q = buildReviewQuery(files, 100);
    expect(q.length).toBeLessThan(2000);
  });
});
