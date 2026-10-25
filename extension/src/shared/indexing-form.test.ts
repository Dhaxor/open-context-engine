import { beforeEach, describe, expect, it, vi } from "vitest";
import { wireIndexingForm } from "./indexing-form";
import type { IndexingSettingsPayload } from "./indexing-settings";

class FakeEl {
  id = ""; hidden = false; textContent = ""; value = ""; checked = false;
  listeners: Record<string, (e?: unknown) => void> = {};
  addEventListener(type: string, cb: (e?: unknown) => void) { this.listeners[type] = cb; }
  fire(type: string) { this.listeners[type]?.(); }
}

const IDS = ["settingIdxStartup", "settingIdxAutoIndex", "settingIdxCache", "settingIdxChunkSize", "settingIdxChunkOverlap", "idxStatusRoot", "idxStatusCounts", "idxStatusMode", "idxStatusModel", "idxStatusReason", "idxRebuild"];
let elements: Record<string, FakeEl>;
let posted: unknown[];

beforeEach(() => {
  elements = Object.fromEntries(IDS.map((id) => [id, new FakeEl()]));
  posted = [];
});

const form = () => wireIndexingForm({ $: (id) => elements[id] ?? null, post: (m) => { posted.push(m); } });

const payload = (over: Partial<IndexingSettingsPayload["settings"]> = {}, status: Partial<IndexingSettingsPayload["status"]> = {}): IndexingSettingsPayload => ({
  type: "indexingSettings",
  settings: { autoIndex: true, indexOnStartup: true, embedCache: false, chunkSize: 80, chunkOverlap: 15, ...over },
  status: {
    workspaceRoot: "/repo", indexedFiles: 42, totalChunks: 420, searchMode: "hybrid",
    embeddingProvider: "voyage", embeddingModel: "voyage-code-3", ...status,
  },
});

describe("wireIndexingForm", () => {
  it("renders status and settings from a payload, all via textContent", () => {
    form().apply(payload({}, { workspaceRoot: "C:\\dev\\project", degradedReason: "no embedding key" }));
    expect(elements.idxStatusRoot.textContent).toBe("C:\\dev\\project");
    expect(elements.idxStatusCounts.textContent).toBe("42 · 420");
    expect(elements.idxStatusMode.textContent).toBe("hybrid");
    expect(elements.idxStatusModel.textContent).toBe("voyage/voyage-code-3");
    expect(elements.idxStatusReason.hidden).toBe(false);
    expect(elements.idxStatusReason.textContent).toContain("no embedding key");
    expect(elements.settingIdxStartup.checked).toBe(true);
    expect(elements.settingIdxCache.checked).toBe(false);
    expect(elements.settingIdxChunkSize.value).toBe("80");
  });

  it("labels keyword-only mode and an empty index honestly", () => {
    form().apply(payload({}, { searchMode: "keyword-only", indexedFiles: 0, totalChunks: 0 }));
    expect(elements.idxStatusMode.textContent).toBe("keyword (BM25)");
    expect(elements.idxStatusCounts.textContent).toBe("not indexed");
    expect(elements.idxStatusReason.hidden).toBe(true); // no reason → hidden, not an empty strip
  });

  it("posts setIndexingSetting only for user edits, never for host applies", () => {
    const f = form();
    elements.settingIdxAutoIndex.checked = false;
    elements.settingIdxAutoIndex.fire("change");
    expect(posted).toEqual([{ type: "setIndexingSetting", key: "autoIndex", value: false }]);

    posted = [];
    elements.settingIdxChunkSize.value = "120";
    elements.settingIdxChunkSize.fire("change");
    expect(posted).toEqual([{ type: "setIndexingSetting", key: "chunkSize", value: 120 }]);

    posted = [];
    elements.settingIdxChunkSize.value = "";
    elements.settingIdxChunkSize.fire("change");
    expect(posted).toEqual([]); // empty input never posts

    posted = [];
    const f2 = form();
    f2.apply(payload({ chunkSize: 200 })); // a host apply posts nothing by itself
    expect(posted).toEqual([]);
  });

  it("ignores an empty chunk input instead of posting NaN", () => {
    form();
    elements.settingIdxChunkSize.value = "";
    elements.settingIdxChunkSize.fire("change");
    expect(posted).toEqual([]);
  });

  it("rebuild button posts reindex", () => {
    form();
    elements.idxRebuild.fire("click");
    expect(posted).toEqual([{ type: "reindex" }]);
  });
});
