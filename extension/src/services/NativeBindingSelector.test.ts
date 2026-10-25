import { describe, expect, it } from "vitest";
import { ensureNativeBinding } from "./NativeBindingSelector";

describe("NativeBindingSelector", () => {
  it("proves the bundled better-sqlite3 loads on this host", () => {
    // better-sqlite3 13 is Node-API: the prebuild for this platform ships in the
    // extension's node_modules, so on a supported host activation must report loaded.
    expect(ensureNativeBinding()).toMatchObject({ ok: true, detail: "loaded", abi: process.versions.modules });
  });
});
