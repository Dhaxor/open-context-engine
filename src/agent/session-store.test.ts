import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionStore, type SavedTrace } from "./session-store";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "oce-sessions-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const session = JSON.stringify({ version: 1, messages: [] });
const trace: SavedTrace = {
  chainPrev: "abc",
  checkpoints: [{
    seq: 1, hash: "h1", prev: "", short: "h1", ts: "", label: "first", turn: 1, filesTouched: 1, restorable: true,
    edits: [{ id: "e1", kind: "create", path: "a.ts", newContents: "x".repeat(1000), diff: "" }],
  }],
};

describe("SessionStore timeline", () => {
  it("keeps the timeline beside the conversation, out of the listing", () => {
    const store = new SessionStore(dir);
    store.save("s1", "hello", session, 1, undefined, trace);
    expect(store.load("s1")?.trace).toEqual(trace);
    // list() parses every session file; whole-file edit payloads stay out of it.
    expect(store.list()).toEqual([expect.objectContaining({ id: "s1", turns: 1 })]);
    expect(fs.readFileSync(path.join(dir, "s1.json"), "utf8")).not.toContain("xxxxxxxx");
  });

  it("leaves the timeline alone when a caller saves without one, and drops an emptied one", () => {
    const store = new SessionStore(dir);
    store.save("s1", "hello", session, 1, undefined, trace);
    store.save("s1", "hello", session, 2); // the classic REPL path has no timeline
    expect(store.load("s1")?.trace?.checkpoints).toHaveLength(1);
    store.save("s1", "hello", session, 0, undefined, { checkpoints: [] });
    expect(store.load("s1")?.trace).toBeUndefined();
  });

  it("removes the timeline with the conversation, and survives a corrupt one", () => {
    const store = new SessionStore(dir);
    store.save("s1", "hello", session, 1, undefined, trace);
    fs.writeFileSync(path.join(dir, "checkpoints", "s1.json"), "{not json");
    expect(store.load("s1")).toMatchObject({ id: "s1", title: "hello" });
    expect(store.remove("s1")).toBe(true);
    expect(fs.existsSync(path.join(dir, "checkpoints", "s1.json"))).toBe(false);
  });
});
