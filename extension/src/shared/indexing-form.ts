import type { IndexingSettingsPayload } from "./indexing-settings";

export interface IndexingFormOptions {
  $: (id: string) => HTMLElement | null;
  post: (m: unknown) => void;
}

export interface IndexingFormController {
  apply: (payload: IndexingSettingsPayload) => void;
}

/** Wire the Indexing section. Every dynamic value lands through textContent
 *  or input.value — the section never builds HTML from data. */
export function wireIndexingForm(opts: IndexingFormOptions): IndexingFormController {
  const startup = opts.$("settingIdxStartup") as HTMLInputElement | null;
  const autoIndex = opts.$("settingIdxAutoIndex") as HTMLInputElement | null;
  const cache = opts.$("settingIdxCache") as HTMLInputElement | null;
  const chunkSize = opts.$("settingIdxChunkSize") as HTMLInputElement | null;
  const chunkOverlap = opts.$("settingIdxChunkOverlap") as HTMLInputElement | null;
  const rootEl = opts.$("idxStatusRoot");
  const countsEl = opts.$("idxStatusCounts");
  const modeEl = opts.$("idxStatusMode");
  const modelEl = opts.$("idxStatusModel");
  const reasonEl = opts.$("idxStatusReason");
  const rebuildBtn = opts.$("idxRebuild");

  // Don't echo a host round-trip while applying host state — only user edits post.
  let applying = false;

  const boolInput = (el: HTMLInputElement | null, key: string) => {
    if (!el) return;
    el.addEventListener("change", () => {
      if (!applying) opts.post({ type: "setIndexingSetting", key, value: el.checked });
    });
  };
  boolInput(startup, "indexOnStartup");
  boolInput(autoIndex, "autoIndex");
  boolInput(cache, "embedding.cache.enabled");

  const numInput = (el: HTMLInputElement | null, key: string) => {
    if (!el) return;
    el.addEventListener("change", () => {
      if (applying) return;
      const raw = el.value.trim();
      if (raw === "") return;
      opts.post({ type: "setIndexingSetting", key, value: Number(raw) });
    });
  };
  numInput(chunkSize, "chunkSize");
  numInput(chunkOverlap, "chunkOverlap");

  if (rebuildBtn) rebuildBtn.addEventListener("click", () => opts.post({ type: "reindex" }));

  return {
    apply: (payload) => {
      applying = true;
      try {
        if (startup) startup.checked = payload.settings.indexOnStartup;
        if (autoIndex) autoIndex.checked = payload.settings.autoIndex;
        if (cache) cache.checked = payload.settings.embedCache;
        if (chunkSize) chunkSize.value = String(payload.settings.chunkSize);
        if (chunkOverlap) chunkOverlap.value = String(payload.settings.chunkOverlap);

        const s = payload.status;
        if (rootEl) rootEl.textContent = s.workspaceRoot || "—";
        if (countsEl) countsEl.textContent = s.indexedFiles > 0
          ? `${s.indexedFiles.toLocaleString()} · ${s.totalChunks.toLocaleString()}`
          : "not indexed";
        if (modeEl) modeEl.textContent = s.searchMode === "keyword-only" ? "keyword (BM25)" : s.searchMode;
        if (modelEl) modelEl.textContent = `${s.embeddingProvider}/${s.embeddingModel}`;
        if (reasonEl) {
          reasonEl.textContent = s.degradedReason ? `⚠ ${s.degradedReason}` : "";
          reasonEl.hidden = !s.degradedReason;
        }
      } finally {
        applying = false;
      }
    },
  };
}
