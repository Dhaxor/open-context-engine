import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureNativeBinding } from "./NativeBindingSelector";

const dirs: string[] = [];
function temp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "oce-native-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("NativeBindingSelector", () => {
  it("treats dev installs without dist-native as single ABI builds", () => {
    expect(ensureNativeBinding(temp())).toMatchObject({ ok: true, detail: "single-abi-build", abi: process.versions.modules });
  });
  it("copies the matching ABI binding and marker", () => {
    const root = temp(); const abi = process.versions.modules;
    const src = path.join(root, "dist-native", `abi-${abi}`); fs.mkdirSync(src, { recursive: true }); fs.writeFileSync(path.join(src, "better_sqlite3.node"), "bin");
    expect(ensureNativeBinding(root)).toMatchObject({ ok: true, detail: "selected", abi });
    expect(fs.readFileSync(path.join(root, "node_modules/better-sqlite3/build/Release/.abi"), "utf8")).toBe(abi);
    expect(ensureNativeBinding(root).detail).toBe("already-current");
  });
  it("reports shipped ABIs when current ABI is missing", () => {
    const root = temp(); fs.mkdirSync(path.join(root, "dist-native", "abi-999"), { recursive: true });
    const result = ensureNativeBinding(root);
    expect(result.ok).toBe(false); expect(result.detail).toContain("999");
  });
});
